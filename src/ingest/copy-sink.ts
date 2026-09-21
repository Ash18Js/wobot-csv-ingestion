import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import copyStreams from 'pg-copy-streams';
import type { DbClient } from '../db.js';
import { inTransaction } from '../db.js';
import type { ValidRow } from './row-validator.js';

const { from: copyFrom } = copyStreams;

export interface PendingRejection {
  rowNumber: number;
  lineNumber: number | null;
  code: string;
  message: string;
  column: string | null;
  rawLine: string;
}

/** Totals as of the *previous* committed batch. */
export interface Checkpoint {
  bytesProcessed: number;
  rowsRead: number;
  rowsApplied: number;
  rowsSuperseded: number;
  rowsRejected: number;
  headerColumns: string[] | null;
}

export interface FlushResult {
  /** Distinct SKUs in this batch after collapsing same-file duplicates. */
  candidates: number;
  /** Rows that actually changed the catalog. The rest lost the freshness check. */
  applied: number;
  /** New durable totals, as just written to the imports row. */
  totals: {
    rowsApplied: number;
    rowsSuperseded: number;
    rowsRejected: number;
  };
}

/** Truncated so one pathological 50 MB line cannot blow up the rejection table. */
export const RAW_LINE_MAX_CHARS = 2_000;

/**
 * COPY TEXT format escaping. Postgres reads backslash escapes in this format,
 * so every backslash, tab, newline and carriage return in the data has to be
 * escaped or the row silently splits in the wrong place.
 */
function copyEscape(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      default: out += ch;
    }
  }
  return out;
}

/**
 * Writes one batch of a merchant's catalog.
 *
 * The whole batch — staged rows, the merge, the rejection log and the
 * checkpoint — commits as one transaction. That is the answer to "the process
 * can be killed at any moment": there is no window in which the catalog has
 * moved forward but the checkpoint has not, or the other way round.
 */
export class CatalogWriter {
  constructor(
    private readonly client: DbClient,
    private readonly merchantId: string,
    private readonly importId: string,
    private readonly leaseSeconds: number,
    private readonly workerId: string,
  ) {}

  /**
   * A TEMP table lives on this connection only, writes no WAL, and disappears
   * if the worker dies — so a crashed ingest leaves nothing to clean up.
   * UNLOGGED would be the alternative, but then two workers would collide.
   */
  async prepare(): Promise<void> {
    // An ingest commits once per batch — hundreds of thousands of commits on a
    // 2 GB file — and waiting for a disk flush on each one dominates the run.
    //
    // Turning this off on the ingest session only risks losing the last few
    // hundred milliseconds of commits if *Postgres itself* crashes. That is
    // safe here, because a batch's rows and its checkpoint are in the same
    // transaction: losing the tail loses both together, and the worker resumes
    // from the older checkpoint and re-applies work that is idempotent anyway.
    // The API's sessions are untouched — a merchant's password change is still
    // flushed before we acknowledge it.
    await this.client.query('SET synchronous_commit = off');

    await this.client.query(`
      CREATE TEMP TABLE IF NOT EXISTS stage_products (
        sku        text,
        name       text,
        category   text,
        price      numeric(20, 4),
        currency   char(3),
        stock      integer,
        updated_at timestamptz
      ) ON COMMIT PRESERVE ROWS
    `);
  }

  async flush(
    rows: readonly ValidRow[],
    rejections: readonly PendingRejection[],
    checkpoint: Checkpoint,
  ): Promise<FlushResult> {
    return inTransaction(this.client, async (client) => {
      let merged = { candidates: 0, applied: 0 };

      if (rows.length > 0) {
        await client.query('TRUNCATE stage_products');
        await this.copyRows(rows);
        merged = await this.merge();
      }

      if (rejections.length > 0) {
        await this.writeRejections(rejections);
      }

      // The counters are derived from what this very transaction did, then
      // written inside it. Commit makes the data and the tally durable
      // together; a crash rolls back both.
      // Superseded is measured against the rows we were given, not against
      // the deduplicated set, so that for any import
      //     rowsRead === rowsApplied + rowsSuperseded + rowsRejected
      // holds exactly. A row is superseded whether it lost to a newer row
      // later in the same file or to one already in the catalog.
      const totals = {
        rowsApplied: checkpoint.rowsApplied + merged.applied,
        rowsSuperseded: checkpoint.rowsSuperseded + (rows.length - merged.applied),
        rowsRejected: checkpoint.rowsRejected + rejections.length,
      };

      await client.query(
        `UPDATE imports
            SET bytes_processed  = $2,
                rows_read        = $3,
                rows_applied     = $4,
                rows_superseded  = $5,
                rows_rejected    = $6,
                header_columns   = COALESCE(header_columns, $7::jsonb),
                lease_expires_at = now() + make_interval(secs => $8),
                locked_by        = $9
          WHERE id = $1`,
        [
          this.importId,
          checkpoint.bytesProcessed,
          checkpoint.rowsRead,
          totals.rowsApplied,
          totals.rowsSuperseded,
          totals.rowsRejected,
          checkpoint.headerColumns ? JSON.stringify(checkpoint.headerColumns) : null,
          this.leaseSeconds,
          this.workerId,
        ],
      );

      return { ...merged, totals };
    });
  }

  private async copyRows(rows: readonly ValidRow[]): Promise<void> {
    const stream = this.client.query(
      copyFrom(
        `COPY stage_products (sku, name, category, price, currency, stock, updated_at)
         FROM STDIN WITH (FORMAT text)`,
      ),
    );

    for (const row of rows) {
      const line =
        copyEscape(row.sku) + '\t' +
        copyEscape(row.name) + '\t' +
        copyEscape(row.category) + '\t' +
        row.price + '\t' +
        row.currency + '\t' +
        row.stock + '\t' +
        row.updatedAt + '\n';

      // Respect backpressure. Without this, a fast parser can queue the whole
      // batch in the socket buffer and undo the memory bound.
      if (!stream.write(line)) await once(stream, 'drain');
    }

    stream.end();
    await finished(stream);
  }

  /**
   * The heart of the service.
   *
   * DISTINCT ON collapses SKUs repeated *within this batch*, keeping the
   * newest — which is also required, because ON CONFLICT refuses to touch the
   * same row twice in one statement.
   *
   * The WHERE on DO UPDATE is the cross-batch and cross-ingest guarantee: an
   * update only lands if its updated_at is strictly newer than what is already
   * stored. Postgres holds a row lock for the duration of the conflict check,
   * so two workers importing overlapping files for the same merchant cannot
   * interleave into a stale result. No application-level locking needed.
   */
  private async merge(): Promise<{ candidates: number; applied: number }> {
    const { rows } = await this.client.query<{ candidates: number; applied: number }>(
      `
      WITH deduped AS (
        SELECT DISTINCT ON (sku)
               sku, name, category, price, currency, stock, updated_at
          FROM stage_products
         ORDER BY sku, updated_at DESC
      ), upserted AS (
        INSERT INTO products
              (merchant_id, sku, name, category, price, currency, stock, updated_at, last_import_id)
        SELECT $1, d.sku, d.name, d.category, d.price, d.currency, d.stock, d.updated_at, $2
          FROM deduped d
        ON CONFLICT (merchant_id, sku) DO UPDATE
           SET name           = excluded.name,
               category       = excluded.category,
               price          = excluded.price,
               currency       = excluded.currency,
               stock          = excluded.stock,
               updated_at     = excluded.updated_at,
               ingested_at    = now(),
               last_import_id = excluded.last_import_id
         WHERE excluded.updated_at > products.updated_at
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM deduped)  AS candidates,
             (SELECT count(*) FROM upserted) AS applied
      `,
      [this.merchantId, this.importId],
    );

    return rows[0] ?? { candidates: 0, applied: 0 };
  }

  /**
   * One statement for the whole batch via array unnest, rather than 5,000
   * round trips or a parameter list long enough to hit Postgres' 65,535 limit.
   */
  private async writeRejections(rejections: readonly PendingRejection[]): Promise<void> {
    await this.client.query(
      `INSERT INTO import_rejections
             (import_id, row_number, line_number, error_code, error_message, column_name, raw_line)
       SELECT $1, * FROM unnest(
             $2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[])
       ON CONFLICT (import_id, row_number) DO NOTHING`,
      [
        this.importId,
        rejections.map((r) => r.rowNumber),
        rejections.map((r) => r.lineNumber),
        rejections.map((r) => r.code),
        rejections.map((r) => r.message),
        rejections.map((r) => r.column),
        rejections.map((r) => r.rawLine.slice(0, RAW_LINE_MAX_CHARS)),
      ],
    );
  }
}

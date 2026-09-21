import { createReadStream } from 'node:fs';
import { parse, type Parser } from 'csv-parse';
import { config } from '../config.js';
import type { DbClient } from '../db.js';
import { logger } from '../logger.js';
import {
  CatalogWriter,
  RAW_LINE_MAX_CHARS,
  type Checkpoint,
  type PendingRejection,
} from './copy-sink.js';
import { REQUIRED_COLUMNS, validateRow, type ValidRow } from './row-validator.js';

export class UnusableFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnusableFileError';
  }
}

export interface ImportJob {
  id: string;
  merchant_id: string;
  storage_path: string;
  bytes_processed: number;
  rows_read: number;
  rows_applied: number;
  rows_superseded: number;
  rows_rejected: number;
  header_columns: string[] | null;
}

export interface IngestTotals {
  bytesProcessed: number;
  rowsRead: number;
  rowsApplied: number;
  rowsSuperseded: number;
  rowsRejected: number;
}

export interface IngestOutcome {
  /** `paused` means we stopped cleanly at a batch boundary and can resume. */
  status: 'completed' | 'cancelled' | 'paused';
  totals: IngestTotals;
}

/**
 * Merchant export tooling produces headers like " SKU", "Price﻿" and
 * "Updated_At". Normalizing here is what makes "column order varies between
 * merchants" a non-event: we address every field by name, never by position.
 */
function normalizeHeader(name: string): string {
  return name.replace(/^﻿/, '').trim().toLowerCase();
}

/** Rebuilds an RFC 4180 line from a parsed record, for the rejection report. */
function reconstructLine(record: Partial<Record<string, string>>, columns: string[]): string {
  return columns
    .map((c) => {
      const v = record[c] ?? '';
      return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    })
    .join(',');
}

/**
 * Streams one file into the catalog.
 *
 * Memory is bounded by INGEST_BATCH_ROWS, not by file size: the read stream,
 * the parser and the COPY stream all apply backpressure, and `for await`
 * pauses the whole chain while a batch is being written. A 2 GB file and a
 * 2 MB file use the same amount of memory.
 */
export async function runIngest(
  client: DbClient,
  job: ImportJob,
  shouldCancel: () => Promise<boolean>,
  shouldStop: () => boolean = () => false,
): Promise<IngestOutcome> {
  const totals: IngestTotals = {
    bytesProcessed: job.bytes_processed,
    rowsRead: job.rows_read,
    rowsApplied: job.rows_applied,
    rowsSuperseded: job.rows_superseded,
    rowsRejected: job.rows_rejected,
  };

  const resuming = job.bytes_processed > 0 && job.header_columns !== null;

  // A resumed ingest starts mid-file, where there is no header line to read,
  // so we replay the column order recorded on the first attempt.
  // `info: true` costs about 10% and buys the two things we cannot do without:
  // info.bytes (the record-boundary offset we checkpoint on) and info.lines
  // (the physical line number a merchant needs to find a bad row).
  //
  // `raw: true` was measured at a further 15% — paid on every row, to keep
  // text we only ever use for the 2-5% that get rejected. Not worth it; the
  // rejection report re-serializes the parsed record instead.
  const common = {
    relax_column_count: true, // short rows become records with missing fields,
    relax_quotes: true, //       which our validator rejects individually
    skip_empty_lines: true, //   instead of the parser aborting the file
    skip_records_with_error: true,
    info: true as const,
  };

  const parser: Parser = parse(
    resuming
      ? { ...common, columns: job.header_columns!, bom: false }
      : { ...common, columns: (header: string[]) => header.map(normalizeHeader), bom: true },
  );

  const source = createReadStream(job.storage_path, {
    start: resuming ? job.bytes_processed : 0,
    highWaterMark: 1 << 20, // 1 MB reads: fewer syscalls, still tiny memory
  });

  source.on('error', (err) => parser.destroy(err));
  source.pipe(parser);

  const writer = new CatalogWriter(
    client,
    job.merchant_id,
    job.id,
    config.LEASE_SECONDS,
    config.WORKER_ID,
  );
  await writer.prepare();

  // Rows the *parser* could not turn into a record at all (unterminated
  // quotes, stray delimiters). They get negative row numbers so they cannot
  // collide with the data-row numbering, which is what the merchant sees.
  const { rows: negRows } = await client.query<{ floor: number }>(
    `SELECT COALESCE(MIN(row_number), 0) AS floor
       FROM import_rejections WHERE import_id = $1 AND row_number < 0`,
    [job.id],
  );
  let unparseableSeq = negRows[0]?.floor ?? 0;

  const parseSkips: PendingRejection[] = [];
  parser.on('skip', (err: Error & { lines?: number; code?: string }) => {
    unparseableSeq -= 1;
    parseSkips.push({
      rowNumber: unparseableSeq,
      lineNumber: typeof err.lines === 'number' ? err.lines : null,
      code: 'unparseable_line',
      message: err.message.slice(0, 500),
      column: null,
      rawLine: '',
    });
  });

  let headerColumns: string[] | null = resuming ? job.header_columns : null;
  let headerChecked = resuming;

  let batch: ValidRow[] = [];
  let rejections: PendingRejection[] = [];
  let rowNumber = job.rows_read;
  let pendingBytes = job.bytes_processed;
  const fileOffsetBase = resuming ? job.bytes_processed : 0;

  /**
   * Writes are pipelined one deep: while a batch is being COPYed and merged,
   * the parser keeps filling the next one. Parsing is CPU-bound and the write
   * is I/O-bound, so overlapping them is close to free throughput — measured
   * at roughly +45% on the test rig.
   *
   * Only one write is ever in flight, chained through this promise, which is
   * what keeps the checkpoints strictly ordered. Two batches in memory instead
   * of one is the entire cost: at the default batch size, about 6 MB.
   */
  let inFlight: Promise<void> = Promise.resolve();

  const flush = (): void => {
    if (parseSkips.length > 0) {
      rejections.push(...parseSkips.splice(0, parseSkips.length));
    }
    if (batch.length === 0 && rejections.length === 0) return;

    const outgoing = batch;
    const outgoingRejections = rejections;
    const atBytes = pendingBytes;
    const atRow = rowNumber;
    const columns = headerColumns;
    batch = [];
    rejections = [];

    inFlight = inFlight.then(async () => {
      // `totals` is read here, not at call time, so it holds what the previous
      // batch actually committed. The writer adds this batch's contribution
      // inside the same transaction and hands back the new durable totals.
      const checkpoint: Checkpoint = {
        bytesProcessed: atBytes,
        rowsRead: atRow,
        rowsApplied: totals.rowsApplied,
        rowsSuperseded: totals.rowsSuperseded,
        rowsRejected: totals.rowsRejected,
        headerColumns: columns,
      };

      const result = await writer.flush(outgoing, outgoingRejections, checkpoint);

      totals.rowsApplied = result.totals.rowsApplied;
      totals.rowsSuperseded = result.totals.rowsSuperseded;
      totals.rowsRejected = result.totals.rowsRejected;
      totals.bytesProcessed = atBytes;
      totals.rowsRead = atRow;
    });
  };

  /** Blocks until every queued write has committed, surfacing any failure. */
  const settle = (): Promise<void> => inFlight;

  let cancelled = false;
  let paused = false;
  let batchesQueued = 0;

  try {
    for await (const item of parser as AsyncIterable<{
      record: Partial<Record<string, string>>;
      info: { bytes: number; lines: number };
    }>) {
      const { record, info } = item;

      if (!headerChecked) {
        headerColumns = Object.keys(record);
        const missing = REQUIRED_COLUMNS.filter((c) => !headerColumns!.includes(c));
        if (missing.length > 0) {
          throw new UnusableFileError(
            `CSV header is missing required column(s): ${missing.join(', ')}. ` +
              `Found: ${headerColumns!.join(', ')}`,
          );
        }
        headerChecked = true;
      }

      rowNumber += 1;
      // info.bytes is the offset *after* this record, so it always names a
      // record boundary — exactly what a resumed read stream needs.
      pendingBytes = fileOffsetBase + info.bytes;

      const result = validateRow(record);
      if (result.ok) {
        batch.push(result.row);
      } else {
        rejections.push({
          rowNumber,
          lineNumber: info.lines,
          code: result.error.code,
          message: result.error.message,
          column: result.error.column ?? null,
          rawLine: reconstructLine(record, headerColumns ?? []).slice(0, RAW_LINE_MAX_CHARS),
        });
      }

      if (batch.length >= config.INGEST_BATCH_ROWS) {
        flush();

        // Cheap guard against the writer falling behind the parser: if a
        // second batch is already full, wait for the queue to drain before
        // buffering a third. Keeps memory flat if Postgres slows down.
        if (batchesQueued++ >= 1) {
          await settle();
          batchesQueued = 0;
        }

        // Checked between batches, never mid-batch: cancelling should stop
        // further work, not tear a transaction in half.
        if (await shouldCancel()) {
          cancelled = true;
          break;
        }

        // SIGTERM during a deploy. Stopping here leaves a valid checkpoint,
        // so whoever picks the import up next carries on from this byte.
        if (shouldStop()) {
          paused = true;
          break;
        }
      }
    }

    if (!cancelled && !paused) flush();
    await settle();
  } finally {
    // If the loop threw, a queued write may still be running. Let it land (or
    // fail) here rather than surfacing later as an unhandled rejection; the
    // original error is the one worth reporting.
    await inFlight.catch(() => {});
    parser.destroy();
    source.destroy();
  }

  const status = cancelled ? 'cancelled' : paused ? 'paused' : 'completed';
  logger.info({ importId: job.id, ...totals, status }, `ingest ${status}`);

  return { status, totals };
}

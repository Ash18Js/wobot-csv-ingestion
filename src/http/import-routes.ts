import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { storeUpload, discardUpload } from '../imports/storage.js';
import {
  createImport,
  getImport,
  listImports,
  requestCancel,
  type ImportRecord,
} from '../imports/repo.js';
import { ApiError } from './errors.js';
import {
  assertCanAccessMerchant,
  authenticate,
  requireAuth,
  resolveMerchantForRead,
  resolveMerchantForWrite,
} from './guards.js';

const uuid = z.string().uuid();

const listQuery = z.object({
  merchantId: uuid.optional(),
  status: z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.coerce.date().optional(),
});

function presentImport(record: ImportRecord): Record<string, unknown> {
  const progress =
    record.size_bytes > 0
      ? Math.min(1, record.bytes_processed / record.size_bytes)
      : 0;

  return {
    id: record.id,
    merchantId: record.merchant_id,
    filename: record.original_filename,
    status: record.status,
    sizeBytes: record.size_bytes,
    cancelRequested: record.cancel_requested,
    attempts: record.attempts,
    progress: {
      // Byte-based, because row count is unknown until the file is read.
      fraction: Number(progress.toFixed(4)),
      bytesProcessed: record.bytes_processed,
      rowsRead: record.rows_read,
    },
    result: {
      rowsApplied: record.rows_applied,
      rowsSuperseded: record.rows_superseded,
      rowsRejected: record.rows_rejected,
    },
    error: record.error,
    createdAt: record.created_at,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    links: {
      self: `/v1/imports/${record.id}`,
      rejections: `/v1/imports/${record.id}/rejections`,
      cancel: `/v1/imports/${record.id}/cancel`,
    },
  };
}

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/imports?merchantId=...
   *
   * Accepts one or more CSV files as multipart/form-data. Each file is
   * streamed to disk and hashed as it arrives; nothing is parsed here. The
   * response is 202 with a pollable resource per file, so the request does not
   * stay open for the duration of the ingest.
   *
   * merchantId travels in the query string rather than a form field on
   * purpose: form fields can legally arrive *after* the file parts, and we are
   * not going to buffer a 2 GB body to find out who it belongs to.
   */
  app.post('/v1/imports', { preHandler: authenticate }, async (req, reply) => {
    const auth = requireAuth(req);
    const query = z.object({ merchantId: uuid.optional() }).parse(req.query);
    const merchantId = resolveMerchantForWrite(auth, query.merchantId);

    if (!req.isMultipart()) {
      throw ApiError.badRequest('Expected multipart/form-data with one or more CSV files');
    }

    const accepted: Record<string, unknown>[] = [];

    for await (const part of req.files()) {
      const filename = part.filename || 'upload.csv';

      const stored = await storeUpload(part.file, merchantId);

      // @fastify/multipart sets this when the stream hit the size limit. The
      // bytes on disk are a prefix of the real file, so we must not keep them.
      if (part.file.truncated) {
        await discardUpload(stored.path);
        throw ApiError.payloadTooLarge(`"${filename}" exceeds the maximum upload size`);
      }

      if (stored.bytes === 0) {
        await discardUpload(stored.path);
        throw ApiError.badRequest(`"${filename}" is empty`);
      }

      const { record, duplicate } = await createImport({
        merchantId,
        uploadedBy: auth.userId,
        filename,
        sha256: stored.sha256,
        sizeBytes: stored.bytes,
        storagePath: stored.path,
      });

      accepted.push({
        ...presentImport(record),
        // Honest about what happened: the caller gets the original import
        // rather than a second one, and can tell that it was deduplicated.
        deduplicated: duplicate,
      });
    }

    if (accepted.length === 0) {
      throw ApiError.badRequest('No files were included in the request');
    }

    return reply.status(202).send({ imports: accepted });
  });

  /** GET /v1/imports — most recent first. */
  app.get('/v1/imports', { preHandler: authenticate }, async (req) => {
    const auth = requireAuth(req);
    const query = listQuery.parse(req.query);
    const merchantId = resolveMerchantForRead(auth, query.merchantId);

    const records = await listImports({
      merchantId,
      ...(query.status ? { status: query.status } : {}),
      limit: query.limit,
      ...(query.before ? { before: query.before } : {}),
    });

    return { imports: records.map(presentImport) };
  });

  /** GET /v1/imports/:id */
  app.get('/v1/imports/:id', { preHandler: authenticate }, async (req) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);

    const record = await getImport(id);
    if (!record) throw ApiError.notFound('No such import');
    assertCanAccessMerchant(auth, record.merchant_id);

    return presentImport(record);
  });

  /**
   * GET /v1/imports/:id/rejections
   *
   * A CSV the merchant can open next to their original file: row number, the
   * physical line number, what was wrong, which column, and the offending
   * line as we read it. Streamed with keyset pagination, so a file with a
   * million bad rows does not become a million-row array in memory.
   */
  app.get('/v1/imports/:id/rejections', { preHandler: authenticate }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { format } = z.object({ format: z.enum(['csv', 'json']).default('csv') }).parse(req.query);

    const record = await getImport(id);
    if (!record) throw ApiError.notFound('No such import');
    assertCanAccessMerchant(auth, record.merchant_id);

    if (format === 'json') {
      const { rows } = await pool.query(
        `SELECT row_number AS "rowNumber", line_number AS "lineNumber",
                error_code AS "errorCode", column_name AS "column",
                error_message AS "message", raw_line AS "rawLine"
           FROM import_rejections
          WHERE import_id = $1
          ORDER BY row_number
          LIMIT 1000`,
        [id],
      );
      return reply.send({
        importId: id,
        totalRejected: record.rows_rejected,
        truncated: record.rows_rejected > rows.length,
        rejections: rows,
      });
    }

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="rejections-${id}.csv"`)
      .send(Readable.from(streamRejectionCsv(id)));
  });

  /** POST /v1/imports/:id/cancel */
  app.post('/v1/imports/:id/cancel', { preHandler: authenticate }, async (req, reply) => {
    const auth = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);

    const existing = await getImport(id);
    if (!existing) throw ApiError.notFound('No such import');
    assertCanAccessMerchant(auth, existing.merchant_id);

    if (!['queued', 'processing'].includes(existing.status)) {
      throw ApiError.conflict(`Import is already ${existing.status} and cannot be cancelled`, {
        status: existing.status,
      });
    }

    const updated = await requestCancel(id);
    if (!updated) throw ApiError.conflict('Import finished before it could be cancelled');

    // 202: a running ingest stops at its next batch boundary, not instantly.
    return reply.status(202).send(presentImport(updated));
  });

  /** GET /v1/products — small read API, mostly so the ingest can be verified. */
  app.get('/v1/products', { preHandler: authenticate }, async (req) => {
    const auth = requireAuth(req);
    const query = z
      .object({
        merchantId: uuid.optional(),
        sku: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);

    const merchantId = resolveMerchantForRead(auth, query.merchantId);

    const { rows } = await pool.query(
      `SELECT merchant_id AS "merchantId", sku, name, category, price, currency, stock,
              updated_at AS "updatedAt", ingested_at AS "ingestedAt",
              last_import_id AS "lastImportId"
         FROM products
        WHERE ($1::uuid IS NULL OR merchant_id = $1)
          AND ($2::text IS NULL OR sku = $2)
        ORDER BY sku
        LIMIT $3`,
      [merchantId, query.sku ?? null, query.limit],
    );

    return { products: rows };
  });
}

const CSV_HEADER = 'row_number,line_number,error_code,column,message,raw_line\n';

function csvField(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Pulls rejections a page at a time by keyset, not OFFSET: OFFSET makes the
 * database re-scan everything it already skipped, which turns the last page of
 * a million-row report into a full table scan.
 */
interface RejectionRow {
  row_number: number;
  line_number: number | null;
  error_code: string;
  column_name: string | null;
  error_message: string;
  raw_line: string;
}

async function* streamRejectionCsv(importId: string): AsyncGenerator<string> {
  yield CSV_HEADER;

  const PAGE = 2_000;
  let after: number | null = null;

  for (;;) {
    const { rows }: { rows: RejectionRow[] } = await pool.query<RejectionRow>(
      `SELECT row_number, line_number, error_code, column_name, error_message, raw_line
         FROM import_rejections
        WHERE import_id = $1
          AND ($2::bigint IS NULL OR row_number > $2)
        ORDER BY row_number
        LIMIT $3`,
      [importId, after, PAGE],
    );

    if (rows.length === 0) return;

    let chunk = '';
    for (const r of rows) {
      chunk +=
        [
          // Negative numbers are our internal sequence for lines the parser
          // could not read at all; the merchant gets the line number instead.
          r.row_number >= 0 ? csvField(r.row_number) : '',
          csvField(r.line_number),
          csvField(r.error_code),
          csvField(r.column_name),
          csvField(r.error_message),
          csvField(r.raw_line),
        ].join(',') + '\n';
    }
    yield chunk;

    if (rows.length < PAGE) return;
    after = rows[rows.length - 1]!.row_number;
  }
}

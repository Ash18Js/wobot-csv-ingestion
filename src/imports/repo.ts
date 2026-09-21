import { pool, type DbClient } from '../db.js';
import { config } from '../config.js';

export type ImportStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface ImportRecord {
  id: string;
  merchant_id: string;
  uploaded_by: string;
  original_filename: string;
  size_bytes: number;
  storage_path: string;
  status: ImportStatus;
  cancel_requested: boolean;
  header_columns: string[] | null;
  bytes_processed: number;
  rows_read: number;
  rows_applied: number;
  rows_superseded: number;
  rows_rejected: number;
  attempts: number;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const COLUMNS = `
  id, merchant_id, uploaded_by, original_filename, size_bytes, storage_path,
  status, cancel_requested, header_columns, bytes_processed, rows_read,
  rows_applied, rows_superseded, rows_rejected, attempts, error,
  created_at, started_at, finished_at
`;

export interface CreateImportInput {
  merchantId: string;
  uploadedBy: string;
  filename: string;
  sha256: Buffer;
  sizeBytes: number;
  storagePath: string;
}

export interface CreateImportResult {
  record: ImportRecord;
  /** True when these exact bytes were already accepted for this merchant. */
  duplicate: boolean;
}

/**
 * Idempotent create.
 *
 * ON CONFLICT DO NOTHING against the (merchant_id, content_sha256) unique
 * index is what makes "the same file arriving twice must not be applied
 * twice" true even for two requests racing in parallel — the database, not
 * the application, decides who wins.
 */
export async function createImport(input: CreateImportInput): Promise<CreateImportResult> {
  const inserted = await pool.query<ImportRecord>(
    `INSERT INTO imports
           (merchant_id, uploaded_by, original_filename, content_sha256, size_bytes, storage_path)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (merchant_id, content_sha256) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.merchantId,
      input.uploadedBy,
      input.filename,
      input.sha256,
      input.sizeBytes,
      input.storagePath,
    ],
  );

  if (inserted.rows[0]) return { record: inserted.rows[0], duplicate: false };

  const existing = await pool.query<ImportRecord>(
    `SELECT ${COLUMNS} FROM imports WHERE merchant_id = $1 AND content_sha256 = $2`,
    [input.merchantId, input.sha256],
  );

  return { record: existing.rows[0]!, duplicate: true };
}

export async function getImport(id: string): Promise<ImportRecord | null> {
  const { rows } = await pool.query<ImportRecord>(
    `SELECT ${COLUMNS} FROM imports WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export interface ListOptions {
  merchantId: string | null;
  status?: ImportStatus;
  limit: number;
  before?: Date;
}

export async function listImports(opts: ListOptions): Promise<ImportRecord[]> {
  const { rows } = await pool.query<ImportRecord>(
    `SELECT ${COLUMNS}
       FROM imports
      WHERE ($1::uuid IS NULL OR merchant_id = $1)
        AND ($2::import_status IS NULL OR status = $2)
        AND ($3::timestamptz IS NULL OR created_at < $3)
      ORDER BY created_at DESC
      LIMIT $4`,
    [opts.merchantId, opts.status ?? null, opts.before ?? null, opts.limit],
  );
  return rows;
}

/**
 * Flags an import for cancellation. The worker notices between batches.
 * A queued import is cancelled outright since nobody has started it.
 */
export async function requestCancel(id: string): Promise<ImportRecord | null> {
  const { rows } = await pool.query<ImportRecord>(
    `UPDATE imports
        SET cancel_requested = true,
            status      = CASE WHEN status = 'queued' THEN 'cancelled'::import_status ELSE status END,
            finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
      WHERE id = $1
        AND status IN ('queued', 'processing')
      RETURNING ${COLUMNS}`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Takes exclusive ownership of one import.
 *
 * FOR UPDATE SKIP LOCKED is the whole concurrency design: several workers can
 * run this same statement at the same instant and each gets a different row,
 * with no queue server, no advisory locks, and no double processing.
 *
 * The second branch of the WHERE re-claims work whose lease has expired —
 * which is how a killed worker's import gets picked up and resumed instead of
 * sitting in 'processing' for ever.
 */
export async function claimNextImport(client: DbClient): Promise<ImportRecord | null> {
  const { rows } = await client.query<ImportRecord>(
    `UPDATE imports
        SET status           = 'processing',
            locked_by        = $1,
            lease_expires_at = now() + make_interval(secs => $2),
            attempts         = attempts + 1,
            started_at       = COALESCE(started_at, now())
      WHERE id = (
            SELECT id FROM imports
             WHERE cancel_requested = false
               AND (status = 'queued'
                    -- A lease that has expired (the worker was killed) or was
                    -- handed back explicitly (the worker shut down cleanly).
                    -- NULL has to be spelled out: "NULL < now()" is NULL, not
                    -- true, so omitting it strands every released import.
                    OR (status = 'processing'
                        AND (lease_expires_at IS NULL OR lease_expires_at < now())))
             ORDER BY created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
      )
      RETURNING ${COLUMNS}`,
    [config.WORKER_ID, config.LEASE_SECONDS],
  );
  return rows[0] ?? null;
}

export async function isCancelRequested(client: DbClient, id: string): Promise<boolean> {
  const { rows } = await client.query<{ cancel_requested: boolean }>(
    'SELECT cancel_requested FROM imports WHERE id = $1',
    [id],
  );
  return rows[0]?.cancel_requested ?? false;
}

export async function finishImport(
  client: DbClient,
  id: string,
  status: Exclude<ImportStatus, 'queued' | 'processing'>,
  error?: string,
): Promise<void> {
  await client.query(
    `UPDATE imports
        SET status = $2, error = $3, finished_at = now(),
            locked_by = NULL, lease_expires_at = NULL
      WHERE id = $1`,
    [id, status, error ?? null],
  );
}

/** Releases the lease without finishing, so another worker can pick it up. */
export async function releaseImport(client: DbClient, id: string, error: string): Promise<void> {
  await client.query(
    `UPDATE imports
        SET locked_by = NULL, lease_expires_at = NULL, error = $2
      WHERE id = $1 AND status = 'processing'`,
    [id, error],
  );
}

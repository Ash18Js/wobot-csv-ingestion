import { access } from 'node:fs/promises';
import { logger } from '../logger.js';
import { pool } from '../db.js';
import {
  claimNextImport,
  finishImport,
  isCancelRequested,
  releaseImport,
} from '../imports/repo.js';
import { runIngest, UnusableFileError } from './pipeline.js';

/**
 * After this many failed attempts an import is marked failed rather than
 * retried for ever. Five rides out a database restart; beyond that something
 * is wrong with the file or the code and a human should look.
 */
export const MAX_ATTEMPTS = 5;

/**
 * Claims at most one import and runs it to completion.
 *
 * Returns false when there was nothing to claim, so the caller knows to sleep.
 * Extracted from the worker entrypoint so tests can drive exactly one unit of
 * work without spawning a process or racing a poll loop.
 */
export async function processNextImport(shouldStop: () => boolean = () => false): Promise<boolean> {
  const client = await pool.connect();

  try {
    const job = await claimNextImport(client);
    if (!job) return false;

    logger.info(
      {
        importId: job.id,
        merchantId: job.merchant_id,
        file: job.original_filename,
        attempt: job.attempts,
        resumeFromByte: job.bytes_processed,
      },
      job.bytes_processed > 0 ? 'resuming import' : 'starting import',
    );

    try {
      await access(job.storage_path);
    } catch {
      await finishImport(client, job.id, 'failed', 'Uploaded file is no longer on disk');
      return true;
    }

    try {
      const outcome = await runIngest(
        client,
        {
          id: job.id,
          merchant_id: job.merchant_id,
          storage_path: job.storage_path,
          bytes_processed: job.bytes_processed,
          rows_read: job.rows_read,
          rows_applied: job.rows_applied,
          rows_superseded: job.rows_superseded,
          rows_rejected: job.rows_rejected,
          header_columns: job.header_columns,
        },
        () => isCancelRequested(client, job.id),
        shouldStop,
      );

      if (outcome.status === 'paused') {
        // Shutting down mid-file. Drop the lease so the next worker resumes
        // from the checkpoint immediately rather than waiting it out.
        await releaseImport(client, job.id, 'Worker shut down; will resume');
        logger.info({ importId: job.id }, 'import paused for shutdown');
        return true;
      }

      await finishImport(client, job.id, outcome.status);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // An unusable header is a property of the file, not a transient fault.
      // Retrying it four more times helps nobody.
      if (err instanceof UnusableFileError) {
        logger.warn({ importId: job.id, err }, 'import rejected: unusable file');
        await finishImport(client, job.id, 'failed', message);
        return true;
      }

      if (job.attempts >= MAX_ATTEMPTS) {
        logger.error({ importId: job.id, err }, 'import failed permanently');
        await finishImport(client, job.id, 'failed', `After ${job.attempts} attempts: ${message}`);
      } else {
        logger.error({ importId: job.id, err, attempt: job.attempts }, 'import attempt failed');
        await releaseImport(client, job.id, message);
      }
      return true;
    }
  } finally {
    client.release();
  }
}

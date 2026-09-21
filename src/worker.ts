import { config } from './config.js';
import { logger } from './logger.js';
import { pool, waitForDatabase } from './db.js';
import { processNextImport } from './ingest/worker-loop.js';

/**
 * The ingest worker.
 *
 * Run as many of these as you like: `docker compose up --scale worker=3`.
 * Work is claimed with FOR UPDATE SKIP LOCKED, so they never collide and
 * there is no broker to operate.
 */
let stopping = false;

async function main(): Promise<void> {
  await waitForDatabase();
  logger.info(
    { workerId: config.WORKER_ID, batchRows: config.INGEST_BATCH_ROWS },
    'ingest worker started',
  );

  const stop = (signal: string): void => {
    logger.info({ signal }, 'worker draining; will stop at the next batch boundary');
    stopping = true;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (!stopping) {
    let didWork = false;
    try {
      didWork = await processNextImport(() => stopping);
    } catch (err) {
      // Claiming itself failed — most likely the database went away. Back off
      // rather than spinning on it.
      logger.error({ err }, 'worker loop error');
      await new Promise((r) => setTimeout(r, 2_000));
    }

    if (!didWork && !stopping) {
      await new Promise((r) => setTimeout(r, config.WORKER_POLL_MS));
    }
  }

  await pool.end();
  logger.info('worker stopped');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'worker crashed');
  process.exit(1);
});

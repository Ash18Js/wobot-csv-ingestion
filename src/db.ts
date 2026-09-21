import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool, types } = pg;

// node-postgres hands back NUMERIC as a JavaScript string by default, which is
// exactly what we want for money: parsing it to a float here would undo the
// whole point of storing it as NUMERIC. This line is a guard against anyone
// "helpfully" changing that later.
types.setTypeParser(types.builtins.NUMERIC, (v) => v);

// int8 (bigint) also arrives as a string. Our counters fit comfortably in a
// JS number (< 2^53), so converting is safe and makes the JSON output nicer.
types.setTypeParser(types.builtins.INT8, (v) => Number(v));

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client errored');
});

export type DbClient = pg.PoolClient;

/** Runs `fn` inside a transaction, committing on success and rolling back on throw. */
export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Same, but on a client the caller already holds (the worker keeps one per import). */
export async function inTransaction<T>(
  client: DbClient,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function waitForDatabase(attempts = 30, delayMs = 1_000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      logger.warn({ attempt: i }, 'database not ready, retrying');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * Minimal forward-only migration runner.
 *
 * Every .sql file in ./migrations is applied once, in filename order, each in
 * its own transaction, and recorded in schema_migrations. Re-running is a
 * no-op. A whole-table advisory lock means two containers starting at the same
 * moment cannot both apply the same file.
 *
 * Deliberately not a framework: the whole thing is auditable in one screen,
 * which matters more here than rollback support we would never use.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, waitForDatabase } from '../src/db.js';
import { logger } from '../src/logger.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

// 0001_identity.sql -> applied before 0002_catalog.sql. Lexicographic order is
// correct as long as the numeric prefix is zero-padded, which is the convention.
async function migrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

async function main(): Promise<void> {
  await waitForDatabase();

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Any number works; it just has to be the same in every process.
    await client.query('SELECT pg_advisory_lock($1)', [0x6d6967]);

    try {
      const { rows } = await client.query<{ filename: string; checksum: string }>(
        'SELECT filename, checksum FROM schema_migrations',
      );
      const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

      // The directory sits at a different depth depending on how we were
      // started: dist/scripts/migrate.js in the image, scripts/migrate.ts via
      // tsx. Take the first candidate that actually contains .sql files.
      let dir: string | null = null;
      for (const candidate of [MIGRATIONS_DIR, join(process.cwd(), 'migrations')]) {
        if ((await migrationFiles(candidate).catch(() => [])).length > 0) {
          dir = candidate;
          break;
        }
      }
      if (!dir) throw new Error('Could not locate a migrations directory containing .sql files');

      for (const filename of await migrationFiles(dir)) {
        const sql = await readFile(join(dir, filename), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const previous = applied.get(filename);

        if (previous !== undefined) {
          if (previous !== checksum) {
            throw new Error(
              `Migration ${filename} was modified after being applied. ` +
                `Add a new migration instead of editing a released one.`,
            );
          }
          logger.debug({ filename }, 'migration already applied');
          continue;
        }

        logger.info({ filename }, 'applying migration');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
            [filename, checksum],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
        }
      }

      logger.info('migrations up to date');
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [0x6d6967]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  logger.error({ err }, 'migration run failed');
  process.exit(1);
});

import { mkdir } from 'node:fs/promises';
import { config } from './config.js';
import { logger } from './logger.js';
import { pool, waitForDatabase } from './db.js';
import { buildServer } from './http/server.js';

async function main(): Promise<void> {
  await mkdir(config.UPLOAD_DIR, { recursive: true });
  await waitForDatabase();

  const app = await buildServer();
  await app.listen({ port: config.PORT, host: config.HOST });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down api');
    await app.close();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'api failed to start');
  process.exit(1);
});

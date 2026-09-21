import { hostname } from 'node:os';
import { z } from 'zod';

/**
 * All environment reading happens here, once, at startup. If something is
 * missing or nonsensical the process refuses to boot with a readable message,
 * rather than failing three layers deep at 2am.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),

  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 14),

  /**
   * Anyone may self-register as a merchant user. Platform staff cannot be
   * self-served into existence — registering as staff requires this shared
   * code, which in a real deployment would be a one-time invite table.
   */
  STAFF_REGISTRATION_CODE: z.string().min(8).optional(),

  UPLOAD_DIR: z.string().default('./uploads'),

  /**
   * Headroom above the 2 GB the brief names, on purpose.
   *
   * "2 GB" from a merchant's export tool is not 2 GiB to the byte — the
   * generator's own `--size 2GB` emits 2,147,483,731 bytes, 83 over. A limit
   * set exactly at the stated maximum rejects the stated maximum.
   */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(3 * 1024 * 1024 * 1024),

  /** Rows buffered in memory before a COPY + merge. Bounds memory, not file size. */
  INGEST_BATCH_ROWS: z.coerce.number().int().positive().default(20_000),
  /** How long a worker's claim on an import is good for before others may steal it. */
  LEASE_SECONDS: z.coerce.number().int().positive().default(30),
  /** Identifies this worker in the lease column. Defaults to container hostname. */
  WORKER_ID: z.string().default(`${hostname()}-${process.pid}`),
  /** Idle poll interval when there is no work waiting. */
  WORKER_POLL_MS: z.coerce.number().int().positive().default(500),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

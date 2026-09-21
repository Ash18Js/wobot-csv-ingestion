import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Integration tests need UPLOAD_DIR pointed somewhere disposable *before*
 * src/config.ts is imported, because config reads the environment once at
 * module load. Everything here is imported dynamically for that reason.
 */
/** Set by tests/setup.ts, before any of this module's imports run. */
export const hasDatabase = process.env['HAS_DATABASE'] === '1';

export const uploadDir = await mkdtemp(join(tmpdir(), 'catalog-test-'));
process.env['UPLOAD_DIR'] = uploadDir;
process.env['INGEST_BATCH_ROWS'] ??= '500';
process.env['LOG_LEVEL'] = 'silent';

const { pool } = await import('../../src/db.js');
const { buildServer } = await import('../../src/http/server.js');
const { processNextImport } = await import('../../src/ingest/worker-loop.js');

export { pool, processNextImport };

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  app ??= await buildServer();
  return app;
}

export async function shutdown(): Promise<void> {
  if (app) await app.close();
  await pool.end();
  await rm(uploadDir, { recursive: true, force: true });
}

/** Merchants cascade to users, imports, rejections and products. */
export async function resetDatabase(): Promise<void> {
  await pool.query('TRUNCATE merchants CASCADE');
  await pool.query('TRUNCATE users CASCADE');
}

export interface TestAccount {
  token: string;
  userId: string;
  merchantId: string | null;
  email: string;
}

export async function registerMerchant(name = 'Acme Retail'): Promise<TestAccount> {
  const instance = await getApp();
  const email = `${randomUUID()}@example.test`;

  const res = await instance.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      accountType: 'merchant',
      email,
      password: 'correct-horse-battery-staple',
      merchantName: name,
    },
  });

  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return {
    token: body.accessToken,
    userId: body.user.id,
    merchantId: body.user.merchantId,
    email,
  };
}

export async function registerStaff(code: string): Promise<TestAccount> {
  const instance = await getApp();
  const email = `${randomUUID()}@staff.test`;

  const res = await instance.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      accountType: 'staff',
      email,
      password: 'correct-horse-battery-staple',
      staffRegistrationCode: code,
    },
  });

  if (res.statusCode !== 201) throw new Error(`staff register failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { token: body.accessToken, userId: body.user.id, merchantId: null, email };
}

/** Builds a multipart/form-data body by hand — no extra dependency needed. */
export function multipartCsv(
  filename: string,
  content: string | Buffer,
): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `----catalogtest${randomUUID().replace(/-/g, '')}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: text/csv\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;

  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([head, body, tail]),
  };
}

export interface UploadResult {
  id: string;
  status: string;
  deduplicated: boolean;
  statusCode: number;
  body: Record<string, unknown>;
}

export async function upload(
  account: TestAccount,
  filename: string,
  content: string | Buffer,
  query = '',
): Promise<UploadResult> {
  const instance = await getApp();
  const { headers, payload } = multipartCsv(filename, content);

  const res = await instance.inject({
    method: 'POST',
    url: `/v1/imports${query}`,
    headers: { ...headers, authorization: `Bearer ${account.token}` },
    payload,
  });

  const body = res.statusCode === 202 ? res.json().imports[0] : res.json();
  return {
    id: body?.id,
    status: body?.status,
    deduplicated: body?.deduplicated,
    statusCode: res.statusCode,
    body,
  };
}

export async function getStatus(account: TestAccount, id: string): Promise<any> {
  const instance = await getApp();
  const res = await instance.inject({
    method: 'GET',
    url: `/v1/imports/${id}`,
    headers: { authorization: `Bearer ${account.token}` },
  });
  return res.statusCode === 200 ? res.json() : { statusCode: res.statusCode, ...res.json() };
}

/** Runs the worker until the queue is empty, with a safety bound. */
export async function drainQueue(maxJobs = 20): Promise<void> {
  for (let i = 0; i < maxJobs; i++) {
    if (!(await processNextImport())) return;
  }
  throw new Error('queue did not drain');
}

export async function productBySku(merchantId: string, sku: string): Promise<any | null> {
  const { rows } = await pool.query(
    `SELECT sku, name, category, price, currency, stock, updated_at
       FROM products WHERE merchant_id = $1 AND sku = $2`,
    [merchantId, sku],
  );
  return rows[0] ?? null;
}

export const HEADER = 'sku,name,category,price,currency,stock,updated_at\n';

export function csv(...rows: string[]): string {
  return HEADER + rows.map((r) => `${r}\n`).join('');
}

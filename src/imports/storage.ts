import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

export interface StoredUpload {
  path: string;
  sha256: Buffer;
  bytes: number;
}

/**
 * Writes an uploaded file to disk without ever holding it in memory, hashing
 * it on the way past.
 *
 * Hashing during the write rather than re-reading afterwards matters at 2 GB:
 * a second pass would double the I/O on the request path, which is exactly
 * where we cannot afford it.
 *
 * The file lands under a content-addressed name, so two merchants uploading
 * the same bytes do not share a file and a retried upload does not accumulate
 * copies.
 */
export async function storeUpload(source: Readable, merchantId: string): Promise<StoredUpload> {
  const dir = join(config.UPLOAD_DIR, merchantId);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.incoming-${randomUUID()}`);
  const hash = createHash('sha256');
  let bytes = 0;

  try {
    await pipeline(
      source,
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk as Buffer);
          bytes += (chunk as Buffer).length;
          yield chunk;
        }
      },
      createWriteStream(tmpPath),
    );
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }

  const sha256 = hash.digest();
  const finalPath = join(dir, `${sha256.toString('hex')}.csv`);

  try {
    // Already have these exact bytes: keep the original, drop the copy.
    await stat(finalPath);
    await rm(tmpPath, { force: true });
  } catch {
    await rename(tmpPath, finalPath);
  }

  return { path: finalPath, sha256, bytes };
}

export async function discardUpload(path: string): Promise<void> {
  await rm(path, { force: true });
}

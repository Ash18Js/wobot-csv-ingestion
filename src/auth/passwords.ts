import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// promisify() cannot pick the overload that takes options, so we name it.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from Node's standard library.
 *
 * scrypt is memory-hard, which is the property that matters against GPU
 * cracking, and it ships with Node — no native module to compile, so the
 * Docker build stays a plain `npm ci` and the image has no toolchain in it.
 *
 * Stored format:  scrypt$N$r$p$<salt base64>$<derived key base64>
 * Keeping the parameters inside the string means we can raise the cost later
 * without invalidating everyone's existing password.
 */
const N = 16_384; // CPU/memory cost — ~16 MB per hash at r=8
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = (await scrypt(plaintext.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
  }));

  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');

  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const derived = (await scrypt(plaintext.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
  }));

  // Constant time: a length-dependent or short-circuiting compare leaks the
  // hash one byte at a time to anyone patient enough to measure.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import type { DbClient } from '../db.js';
import { pool } from '../db.js';

/**
 * Two-token scheme, both issued and verified here — no hosted identity
 * provider, per the brief.
 *
 *  - Access token: a short-lived signed JWT. Stateless, so the hot path
 *    (every API call) costs a HMAC verify and no database round trip.
 *  - Refresh token: a long, opaque random string. Stored as a SHA-256 digest,
 *    so a dump of the database does not hand an attacker working sessions.
 *    Rotated on every use: presenting an old one after rotation fails.
 */

const ISSUER = 'catalog-ingest';
const AUDIENCE = 'catalog-api';
const key = new TextEncoder().encode(config.JWT_SECRET);

export type UserRole = 'merchant_user' | 'platform_staff';

export interface AuthContext {
  userId: string;
  role: UserRole;
  /** null for platform staff, who belong to no single merchant. */
  merchantId: string | null;
}

export async function issueAccessToken(ctx: AuthContext): Promise<string> {
  return new SignJWT({ role: ctx.role, mid: ctx.merchantId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(ctx.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<AuthContext> {
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: AUDIENCE,
    // Pinning the algorithm list is what stops an "alg: none" or RS256/HS256
    // confusion attack. Never leave this to the token's own header.
    algorithms: ['HS256'],
  });

  const role = payload['role'];
  if (role !== 'merchant_user' && role !== 'platform_staff') {
    throw new Error('token has an unknown role');
  }
  const mid = payload['mid'];
  if (mid !== null && typeof mid !== 'string') {
    throw new Error('token has an invalid merchant claim');
  }
  if (typeof payload.sub !== 'string') {
    throw new Error('token has no subject');
  }

  return { userId: payload.sub, role, merchantId: mid };
}

const digest = (token: string): Buffer => createHash('sha256').update(token).digest();

export async function issueRefreshToken(userId: string, client?: DbClient): Promise<string> {
  const token = randomBytes(48).toString('base64url');
  const runner = client ?? pool;

  await runner.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [userId, digest(token), config.REFRESH_TOKEN_TTL_SECONDS],
  );

  return token;
}

export interface RefreshResult {
  userId: string;
  role: UserRole;
  merchantId: string | null;
}

/**
 * Consumes a refresh token: marks it revoked and returns its owner, in one
 * statement so two concurrent uses of the same token cannot both succeed.
 * Returns null if the token is unknown, expired, or already used.
 */
export async function consumeRefreshToken(
  token: string,
  client: DbClient,
): Promise<RefreshResult | null> {
  const { rows } = await client.query<RefreshResult>(
    `UPDATE refresh_tokens rt
        SET revoked_at = now()
       FROM users u
      WHERE rt.token_hash = $1
        AND rt.revoked_at IS NULL
        AND rt.expires_at > now()
        AND u.id = rt.user_id
    RETURNING u.id AS "userId", u.role, u.merchant_id AS "merchantId"`,
    [digest(token)],
  );

  return rows[0] ?? null;
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [digest(token)],
  );
}

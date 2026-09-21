import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken, type AuthContext } from '../auth/tokens.js';
import { ApiError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/**
 * preHandler for every non-public route. Nothing in this service is public
 * except /health and the auth endpoints themselves.
 */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing Bearer token');
  }

  try {
    req.auth = await verifyAccessToken(header.slice('Bearer '.length).trim());
  } catch {
    // Deliberately vague: expired vs. forged is not the caller's business.
    throw ApiError.unauthorized('Invalid or expired token');
  }
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw ApiError.unauthorized();
  return req.auth;
}

export function requireStaff(req: FastifyRequest): AuthContext {
  const auth = requireAuth(req);
  if (auth.role !== 'platform_staff') throw ApiError.forbidden('Platform staff only');
  return auth;
}

/**
 * The single place tenant isolation is decided.
 *
 * A merchant user may only ever act on their own merchant — if they name a
 * different one we answer 403, and if they name none we fill in theirs.
 * Platform staff may act on any merchant but must say which one, because
 * "whose catalog am I writing to" is not a question to guess at.
 */
export function resolveMerchantForWrite(auth: AuthContext, requested?: string): string {
  if (auth.role === 'platform_staff') {
    if (!requested) {
      throw ApiError.badRequest('Platform staff must supply merchantId for this operation');
    }
    return requested;
  }

  if (requested && requested !== auth.merchantId) {
    throw ApiError.forbidden('You may only act on your own merchant');
  }
  // A merchant_user always has a merchant_id; the database CHECK enforces it.
  return auth.merchantId!;
}

/**
 * Read-side scope. `null` means "no filter" and is only ever returned for
 * platform staff who did not name a merchant.
 */
export function resolveMerchantForRead(auth: AuthContext, requested?: string): string | null {
  if (auth.role === 'platform_staff') return requested ?? null;

  if (requested && requested !== auth.merchantId) {
    throw ApiError.forbidden('You may only read your own merchant');
  }
  return auth.merchantId!;
}

/** Used after loading a row, to check the caller is allowed to see it. */
export function assertCanAccessMerchant(auth: AuthContext, merchantId: string): void {
  if (auth.role === 'platform_staff') return;
  if (auth.merchantId !== merchantId) {
    // 404 rather than 403: a merchant should not be able to probe for the
    // existence of another merchant's import ids.
    throw ApiError.notFound();
  }
}

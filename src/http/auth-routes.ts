import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  consumeRefreshToken,
  issueAccessToken,
  issueRefreshToken,
  revokeRefreshToken,
  type UserRole,
} from '../auth/tokens.js';
import { ApiError } from './errors.js';
import { authenticate, requireAuth } from './guards.js';

const passwordRule = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256);

const registerSchema = z.discriminatedUnion('accountType', [
  z.object({
    accountType: z.literal('merchant'),
    email: z.string().email(),
    password: passwordRule,
    merchantName: z.string().min(2).max(120),
  }),
  z.object({
    accountType: z.literal('staff'),
    email: z.string().email(),
    password: passwordRule,
    staffRegistrationCode: z.string().min(8),
  }),
]);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'merchant';
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  merchant_id: string | null;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/auth/register
   *
   * Registering as a merchant creates the merchant and its first user in one
   * transaction. Registering as staff requires the shared code from the
   * environment, so staff accounts cannot be created from the open internet.
   */
  app.post('/v1/auth/register', async (req, reply) => {
    const body = registerSchema.parse(req.body);

    if (body.accountType === 'staff') {
      if (
        !config.STAFF_REGISTRATION_CODE ||
        body.staffRegistrationCode !== config.STAFF_REGISTRATION_CODE
      ) {
        throw ApiError.forbidden('Staff registration is not available');
      }
    }

    const result = await withTransaction(async (client) => {
      let merchantId: string | null = null;

      if (body.accountType === 'merchant') {
        // Slug collisions are possible and boring; retry with a suffix rather
        // than making the user think of a different company name.
        let slug = slugify(body.merchantName);
        for (let attempt = 0; attempt < 5; attempt++) {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO merchants (name, slug) VALUES ($1, $2)
             ON CONFLICT (slug) DO NOTHING
             RETURNING id`,
            [body.merchantName, slug],
          );
          if (inserted.rows[0]) {
            merchantId = inserted.rows[0].id;
            break;
          }
          slug = `${slugify(body.merchantName)}-${Math.random().toString(36).slice(2, 7)}`;
        }
        if (!merchantId) throw ApiError.conflict('Could not allocate a merchant slug');
      }

      const passwordHash = await hashPassword(body.password);

      try {
        const { rows } = await client.query<UserRow>(
          `INSERT INTO users (email, password_hash, role, merchant_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, email, role, merchant_id, password_hash`,
          [
            body.email,
            passwordHash,
            body.accountType === 'staff' ? 'platform_staff' : 'merchant_user',
            merchantId,
          ],
        );
        const user = rows[0]!;
        const refreshToken = await issueRefreshToken(user.id, client);
        return { user, refreshToken };
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw ApiError.conflict('An account with that email already exists');
        }
        throw err;
      }
    });

    const accessToken = await issueAccessToken({
      userId: result.user.id,
      role: result.user.role,
      merchantId: result.user.merchant_id,
    });

    return reply.status(201).send({
      accessToken,
      refreshToken: result.refreshToken,
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: result.user.id,
        email: result.user.email,
        role: result.user.role,
        merchantId: result.user.merchant_id,
      },
    });
  });

  /** POST /v1/auth/login */
  app.post('/v1/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);

    const { rows } = await pool.query<UserRow>(
      `SELECT id, email, password_hash, role, merchant_id
         FROM users WHERE lower(email) = lower($1)`,
      [body.email],
    );
    const user = rows[0];

    // Verify against a dummy hash when the user does not exist, so the
    // response time does not tell an attacker which emails are registered.
    const ok = user
      ? await verifyPassword(body.password, user.password_hash)
      : await verifyPassword(body.password, DUMMY_HASH);

    if (!user || !ok) throw ApiError.unauthorized('Invalid email or password');

    const accessToken = await issueAccessToken({
      userId: user.id,
      role: user.role,
      merchantId: user.merchant_id,
    });
    const refreshToken = await issueRefreshToken(user.id);

    return reply.send({
      accessToken,
      refreshToken,
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        merchantId: user.merchant_id,
      },
    });
  });

  /** POST /v1/auth/token/refresh — rotates the refresh token. */
  app.post('/v1/auth/token/refresh', async (req, reply) => {
    const body = refreshSchema.parse(req.body);

    const issued = await withTransaction(async (client) => {
      const owner = await consumeRefreshToken(body.refreshToken, client);
      if (!owner) return null;

      const refreshToken = await issueRefreshToken(owner.userId, client);
      const accessToken = await issueAccessToken({
        userId: owner.userId,
        role: owner.role,
        merchantId: owner.merchantId,
      });
      return { accessToken, refreshToken };
    });

    if (!issued) throw ApiError.unauthorized('Refresh token is invalid or expired');

    return reply.send({ ...issued, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS });
  });

  /** POST /v1/auth/logout */
  app.post('/v1/auth/logout', async (req, reply) => {
    const body = refreshSchema.parse(req.body);
    await revokeRefreshToken(body.refreshToken);
    return reply.status(204).send();
  });

  /** GET /v1/auth/me */
  app.get('/v1/auth/me', { preHandler: authenticate }, async (req) => {
    const auth = requireAuth(req);
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.role, u.merchant_id AS "merchantId",
              m.name AS "merchantName", m.slug AS "merchantSlug"
         FROM users u
         LEFT JOIN merchants m ON m.id = u.merchant_id
        WHERE u.id = $1`,
      [auth.userId],
    );
    if (!rows[0]) throw ApiError.notFound('User no longer exists');
    return rows[0];
  });
}

/**
 * A real scrypt hash of a value nobody knows, used only to burn the same CPU
 * time on a login attempt for a non-existent account.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$0000000000000000000000==$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

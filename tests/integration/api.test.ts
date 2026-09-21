import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  csv,
  drainQueue,
  getApp,
  hasDatabase,
  registerMerchant,
  registerStaff,
  resetDatabase,
  shutdown,
  upload,
  type TestAccount,
} from '../helpers/harness.js';

const STAFF_CODE = 'staff-code-for-tests';
const SAMPLE = csv('A-1,Widget,peripherals,10.00,USD,5,2025-03-01T10:00:00Z');

describe.skipIf(!hasDatabase)('API and access control', () => {
  let acme: TestAccount;
  let rival: TestAccount;

  beforeEach(async () => {
    await resetDatabase();
    acme = await registerMerchant('Acme Retail');
    rival = await registerMerchant('Rival Retail');
  });

  afterAll(async () => {
    await shutdown();
  });

  describe('nothing is public', () => {
    it.each([
      ['GET', '/v1/imports'],
      ['POST', '/v1/imports'],
      ['GET', '/v1/products'],
      ['GET', '/v1/auth/me'],
    ])('%s %s requires a token', async (method, url) => {
      const app = await getApp();
      const res = await app.inject({ method: method as 'GET', url });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a syntactically valid but unsigned token', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: 'Bearer aaa.bbb.ccc' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('leaves /health open', async () => {
      const app = await getApp();
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    });
  });

  describe('tenant isolation', () => {
    it('a merchant cannot read another merchant\'s import', async () => {
      const { id } = await upload(acme, 'catalog.csv', SAMPLE);
      const app = await getApp();

      const res = await app.inject({
        method: 'GET',
        url: `/v1/imports/${id}`,
        headers: { authorization: `Bearer ${rival.token}` },
      });

      // 404, not 403: a rival should not be able to confirm the id exists.
      expect(res.statusCode).toBe(404);
    });

    it('a merchant cannot cancel another merchant\'s import', async () => {
      const { id } = await upload(acme, 'catalog.csv', SAMPLE);
      const app = await getApp();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/imports/${id}/cancel`,
        headers: { authorization: `Bearer ${rival.token}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('a merchant cannot download another merchant\'s rejection report', async () => {
      const { id } = await upload(acme, 'catalog.csv', SAMPLE);
      const app = await getApp();

      const res = await app.inject({
        method: 'GET',
        url: `/v1/imports/${id}/rejections`,
        headers: { authorization: `Bearer ${rival.token}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('a merchant cannot upload into another merchant by naming them', async () => {
      const res = await upload(acme, 'catalog.csv', SAMPLE, `?merchantId=${rival.merchantId}`);
      expect(res.statusCode).toBe(403);
    });

    it('listing only ever shows your own imports', async () => {
      await upload(acme, 'mine.csv', SAMPLE);
      await upload(rival, 'theirs.csv', csv('B-1,Other,cables,1.00,USD,1,2025-03-01T10:00:00Z'));

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/imports',
        headers: { authorization: `Bearer ${acme.token}` },
      });

      const { imports } = res.json();
      expect(imports).toHaveLength(1);
      expect(imports[0].filename).toBe('mine.csv');
    });

    it('products are scoped to the merchant too', async () => {
      await upload(acme, 'mine.csv', SAMPLE);
      await drainQueue();

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/products',
        headers: { authorization: `Bearer ${rival.token}` },
      });
      expect(res.json().products).toHaveLength(0);
    });
  });

  describe('platform staff', () => {
    it('can read any merchant\'s import', async () => {
      const staff = await registerStaff(STAFF_CODE);
      const { id } = await upload(acme, 'catalog.csv', SAMPLE);

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: `/v1/imports/${id}`,
        headers: { authorization: `Bearer ${staff.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().merchantId).toBe(acme.merchantId);
    });

    it('sees every merchant when they do not name one', async () => {
      const staff = await registerStaff(STAFF_CODE);
      await upload(acme, 'a.csv', SAMPLE);
      await upload(rival, 'b.csv', csv('B-1,Other,cables,1.00,USD,1,2025-03-01T10:00:00Z'));

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/imports',
        headers: { authorization: `Bearer ${staff.token}` },
      });
      expect(res.json().imports).toHaveLength(2);
    });

    it('must say which merchant they are uploading for', async () => {
      const staff = await registerStaff(STAFF_CODE);
      const res = await upload(staff, 'catalog.csv', SAMPLE);
      expect(res.statusCode).toBe(400);
      expect(res.body.error.message).toContain('merchantId');
    });

    it('can upload on a merchant\'s behalf when they do', async () => {
      const staff = await registerStaff(STAFF_CODE);
      const res = await upload(staff, 'catalog.csv', SAMPLE, `?merchantId=${acme.merchantId}`);
      expect(res.statusCode).toBe(202);
      expect(res.body.merchantId).toBe(acme.merchantId);
    });

    it('cannot be created without the registration code', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          accountType: 'staff',
          email: 'sneaky@example.test',
          password: 'correct-horse-battery-staple',
          staffRegistrationCode: 'guessing',
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('sessions', () => {
    it('logs in case-insensitively and rejects a wrong password', async () => {
      const app = await getApp();

      const ok = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: acme.email.toUpperCase(), password: 'correct-horse-battery-staple' },
      });
      expect(ok.statusCode).toBe(200);

      const bad = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: acme.email, password: 'wrong-password-entirely' },
      });
      expect(bad.statusCode).toBe(401);
      // The message must not reveal whether the account exists.
      expect(bad.json().error.message).toBe('Invalid email or password');
    });

    it('rotates refresh tokens and refuses a reused one', async () => {
      const app = await getApp();

      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: acme.email, password: 'correct-horse-battery-staple' },
      });
      const first = login.json().refreshToken;

      const refreshed = await app.inject({
        method: 'POST',
        url: '/v1/auth/token/refresh',
        payload: { refreshToken: first },
      });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().refreshToken).not.toBe(first);

      // Replaying the consumed token must fail.
      const replay = await app.inject({
        method: 'POST',
        url: '/v1/auth/token/refresh',
        payload: { refreshToken: first },
      });
      expect(replay.statusCode).toBe(401);
    });

    it('logout revokes the refresh token', async () => {
      const app = await getApp();
      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: acme.email, password: 'correct-horse-battery-staple' },
      });
      const token = login.json().refreshToken;

      expect(
        (await app.inject({ method: 'POST', url: '/v1/auth/logout', payload: { refreshToken: token } }))
          .statusCode,
      ).toBe(204);

      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/auth/token/refresh',
            payload: { refreshToken: token },
          })
        ).statusCode,
      ).toBe(401);
    });

    it('refuses to register the same email twice', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          accountType: 'merchant',
          email: acme.email,
          password: 'correct-horse-battery-staple',
          merchantName: 'Copycat',
        },
      });
      expect(res.statusCode).toBe(409);
    });

    it('refuses a short password', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          accountType: 'merchant',
          email: 'short@example.test',
          password: 'short',
          merchantName: 'Short',
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('upload endpoint', () => {
    it('answers 202 without waiting for the ingest', async () => {
      const res = await upload(acme, 'catalog.csv', SAMPLE);
      expect(res.statusCode).toBe(202);
      expect(res.status).toBe('queued');
      expect(res.body.links).toMatchObject({ self: expect.stringContaining('/v1/imports/') });
    });

    it('rejects an empty file', async () => {
      const res = await upload(acme, 'empty.csv', '');
      expect(res.statusCode).toBe(400);
    });

    it('rejects a request that is not multipart', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/imports',
        headers: { authorization: `Bearer ${acme.token}` },
        payload: { not: 'multipart' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('serves the rejection report as CSV with a filename', async () => {
      const { id } = await upload(
        acme,
        'bad.csv',
        csv('A-1,Bad,peripherals,N/A,USD,1,2025-03-01T10:00:00Z'),
      );
      await drainQueue();

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: `/v1/imports/${id}/rejections`,
        headers: { authorization: `Bearer ${acme.token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain(`rejections-${id}.csv`);
      expect(res.body).toContain('row_number,line_number,error_code');
      expect(res.body).toContain('invalid_price');
    });

    it('serves the same report as JSON on request', async () => {
      const { id } = await upload(
        acme,
        'bad2.csv',
        csv('A-1,Bad,peripherals,N/A,USD,1,2025-03-01T10:00:00Z'),
      );
      await drainQueue();

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: `/v1/imports/${id}/rejections?format=json`,
        headers: { authorization: `Bearer ${acme.token}` },
      });

      expect(res.json().rejections[0]).toMatchObject({
        errorCode: 'invalid_price',
        column: 'price',
      });
    });

    it('404s on an unknown import id', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/imports/00000000-0000-4000-8000-000000000000',
        headers: { authorization: `Bearer ${acme.token}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('400s on an id that is not a uuid', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/imports/not-a-uuid',
        headers: { authorization: `Bearer ${acme.token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/passwords.js';
import { issueAccessToken, verifyAccessToken } from '../../src/auth/tokens.js';
import { isValidCurrency, minorUnits } from '../../src/ingest/currency.js';

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    const a = await hashPassword('same-password-here');
    const b = await hashPassword('same-password-here');
    expect(a).not.toBe(b);
  });

  it('never stores the plaintext', async () => {
    const hash = await hashPassword('hunter2-hunter2');
    expect(hash).not.toContain('hunter2');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1$2$3')).toBe(false);
  });
});

describe('access tokens', () => {
  const ctx = {
    userId: '11111111-1111-4111-8111-111111111111',
    role: 'merchant_user' as const,
    merchantId: '22222222-2222-4222-8222-222222222222',
  };

  it('round-trips the identity and the merchant claim', async () => {
    const token = await issueAccessToken(ctx);
    expect(await verifyAccessToken(token)).toEqual(ctx);
  });

  it('carries a null merchant for platform staff', async () => {
    const staff = { userId: ctx.userId, role: 'platform_staff' as const, merchantId: null };
    expect(await verifyAccessToken(await issueAccessToken(staff))).toEqual(staff);
  });

  it('rejects a token with a tampered payload', async () => {
    const token = await issueAccessToken(ctx);
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    decoded.mid = '33333333-3333-4333-8333-333333333333';
    const forged =
      `${header}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;

    await expect(verifyAccessToken(forged)).rejects.toThrow();
  });

  it('rejects the "alg: none" trick', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: ctx.userId, role: 'platform_staff', mid: null }),
    ).toString('base64url');

    await expect(verifyAccessToken(`${header}.${payload}.`)).rejects.toThrow();
  });

  it('rejects rubbish', async () => {
    await expect(verifyAccessToken('not.a.token')).rejects.toThrow();
  });
});

describe('ISO 4217 table', () => {
  it('knows the currencies the generator uses', () => {
    for (const code of ['USD', 'EUR', 'GBP', 'INR', 'JPY']) {
      expect(isValidCurrency(code)).toBe(true);
    }
  });

  it('has the right minor units', () => {
    expect(minorUnits('USD')).toBe(2);
    expect(minorUnits('JPY')).toBe(0);
    expect(minorUnits('KWD')).toBe(3);
    expect(minorUnits('CLF')).toBe(4);
  });

  it('does not recognise invented codes', () => {
    expect(isValidCurrency('DOLLARS')).toBe(false);
    expect(isValidCurrency('XYZ')).toBe(false);
    expect(isValidCurrency('usd')).toBe(false); // callers normalize first
  });
});

import { describe, expect, it } from 'vitest';
import { parseTimestamp, validateRow } from '../../src/ingest/row-validator.js';

const good = {
  sku: 'A-1001',
  name: 'Wireless Mouse, Pro',
  category: 'peripherals',
  price: '24.99',
  currency: 'USD',
  stock: '150',
  updated_at: '2025-03-01T10:00:00Z',
};

/** Fails the test with the row's error if it unexpectedly rejected. */
function expectValid(record: Record<string, string>) {
  const result = validateRow(record);
  if (!result.ok) throw new Error(`expected valid, got ${result.error.code}: ${result.error.message}`);
  return result.row;
}

function expectRejected(record: Record<string, string>, code: string) {
  const result = validateRow(record);
  expect(result.ok, `expected rejection "${code}"`).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe('validateRow — accepts', () => {
  it('a clean row', () => {
    const row = expectValid(good);
    expect(row).toMatchObject({
      sku: 'A-1001',
      price: '24.99',
      currency: 'USD',
      stock: 150,
      updatedAt: '2025-03-01T10:00:00.000Z',
    });
  });

  it('keeps price as an exact decimal string, never a float', () => {
    // 0.1 + 0.2 territory: this must survive byte for byte.
    const row = expectValid({ ...good, price: '1234567890123.45', currency: 'USD' });
    expect(row.price).toBe('1234567890123.45');
    expect(typeof row.price).toBe('string');
  });

  it('a zero-decimal currency with no decimals', () => {
    expect(expectValid({ ...good, price: '36676', currency: 'JPY' }).price).toBe('36676');
  });

  it('fewer decimals than the currency allows', () => {
    expect(expectValid({ ...good, price: '45', currency: 'USD' }).price).toBe('45');
  });

  it('a three-decimal currency', () => {
    expect(expectValid({ ...good, price: '12.345', currency: 'KWD' }).price).toBe('12.345');
  });

  it('a lowercase currency code, normalizing it', () => {
    expect(expectValid({ ...good, currency: 'eur' }).currency).toBe('EUR');
  });

  it('zero stock', () => {
    expect(expectValid({ ...good, stock: '0' }).stock).toBe(0);
  });

  it('a name containing a newline (legal inside RFC 4180 quotes)', () => {
    expect(expectValid({ ...good, name: 'Desk Lamp\n(adjustable)' }).name).toContain('\n');
  });

  it('a timestamp with a positive offset, converting to UTC', () => {
    expect(expectValid({ ...good, updated_at: '2025-03-01T10:05:00+05:30' }).updatedAt).toBe(
      '2025-03-01T04:35:00.000Z',
    );
  });

  it('a timestamp with a negative offset', () => {
    expect(expectValid({ ...good, updated_at: '2025-03-01T10:00:00-08:00' }).updatedAt).toBe(
      '2025-03-01T18:00:00.000Z',
    );
  });

  it('surrounding whitespace on sku and currency', () => {
    const row = expectValid({ ...good, sku: '  A-1001  ', currency: ' usd ' });
    expect(row.sku).toBe('A-1001');
    expect(row.currency).toBe('USD');
  });
});

/**
 * One case per corruption the generator in the brief can emit. If the
 * generator grows a new one, a test here should fail first.
 */
describe('validateRow — rejects every corruption the generator emits', () => {
  it('negative-price', () => expectRejected({ ...good, price: '-24.99' }, 'negative_price'));

  it('non-numeric-price', () => expectRejected({ ...good, price: 'N/A' }, 'invalid_price'));

  it('wrong-minor-units on a 2-decimal currency', () =>
    expectRejected({ ...good, price: '24.999', currency: 'USD' }, 'price_minor_units'));

  it('wrong-minor-units on a 0-decimal currency', () =>
    expectRejected({ ...good, price: '36676.50', currency: 'JPY' }, 'price_minor_units'));

  it('negative-stock', () => expectRejected({ ...good, stock: '-12' }, 'negative_stock'));

  it('fractional-stock', () => expectRejected({ ...good, stock: '42.5' }, 'invalid_stock'));

  it('missing-sku', () => expectRejected({ ...good, sku: '' }, 'missing_sku'));

  it('missing-sku that is only whitespace', () =>
    expectRejected({ ...good, sku: '   ' }, 'missing_sku'));

  it('bad-date', () => expectRejected({ ...good, updated_at: '2025-13-45 99:99' }, 'invalid_timestamp'));

  it('bad-currency', () => expectRejected({ ...good, currency: 'DOLLARS' }, 'invalid_currency'));

  it('short-row (a column absent entirely)', () => {
    const { updated_at: _omitted, ...short } = good;
    expectRejected(short as Record<string, string>, 'missing_column');
  });
});

describe('validateRow — rejects other real-world damage', () => {
  it('a syntactically valid but nonexistent currency', () =>
    expectRejected({ ...good, currency: 'XYZ' }, 'unknown_currency'));

  it('a date that does not exist', () =>
    expectRejected({ ...good, updated_at: '2025-02-31T00:00:00Z' }, 'invalid_timestamp'));

  it('an out-of-range UTC offset', () =>
    expectRejected({ ...good, updated_at: '2025-03-01T10:00:00+25:00' }, 'invalid_timestamp'));

  it('stock beyond int4', () => expectRejected({ ...good, stock: '99999999999' }, 'stock_out_of_range'));

  it('an empty price', () => expectRejected({ ...good, price: '' }, 'invalid_price'));

  it('a sku longer than the column allows', () =>
    expectRejected({ ...good, sku: 'x'.repeat(200) }, 'sku_too_long'));

  it('names the offending column so the merchant can fix it', () => {
    const result = validateRow({ ...good, price: 'N/A' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.column).toBe('price');
      expect(result.error.message).toContain('N/A');
    }
  });
});

describe('parseTimestamp', () => {
  it('reads a bare local timestamp as UTC (documented leniency)', () => {
    expect(parseTimestamp('2025-03-01 10:00:00')).toBe('2025-03-01T10:00:00.000Z');
  });

  it('accepts fractional seconds', () => {
    expect(parseTimestamp('2025-03-01T10:00:00.123Z')).toBe('2025-03-01T10:00:00.123Z');
  });

  it('accepts a lowercase t/z separator', () => {
    expect(parseTimestamp('2025-03-01t10:00:00z')).toBe('2025-03-01T10:00:00.000Z');
  });

  it('rejects free text', () => {
    expect(parseTimestamp('yesterday')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('01/03/2025')).toBeNull();
  });

  it('rejects an hour of 24 and a month of 13', () => {
    expect(parseTimestamp('2025-03-01T24:00:00Z')).toBeNull();
    expect(parseTimestamp('2025-13-01T10:00:00Z')).toBeNull();
  });
});

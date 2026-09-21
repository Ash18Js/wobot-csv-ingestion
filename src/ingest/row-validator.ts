import { isValidCurrency, minorUnits } from './currency.js';

/**
 * Validation of one CSV record.
 *
 * Deliberately hand-written rather than a schema library: this runs tens of
 * millions of times per file and is the hottest loop in the service. It is
 * also pure — no I/O, no database — which is what makes it cheap to test
 * exhaustively against every corruption the generator can emit.
 *
 * Every failure carries a machine-readable code and a message a merchant can
 * act on without reading our source.
 */

export const REQUIRED_COLUMNS = [
  'sku',
  'name',
  'category',
  'price',
  'currency',
  'stock',
  'updated_at',
] as const;

export type RequiredColumn = (typeof REQUIRED_COLUMNS)[number];

export interface ValidRow {
  sku: string;
  name: string;
  category: string;
  /** Exact decimal, kept as a string all the way into NUMERIC. Never a float. */
  price: string;
  currency: string;
  stock: number;
  /** Normalized to UTC ISO-8601. */
  updatedAt: string;
}

export interface RowRejection {
  code: string;
  message: string;
  column?: string;
}

export type RowResult = { ok: true; row: ValidRow } | { ok: false; error: RowRejection };

const MAX_SKU = 128;
const MAX_NAME = 512;
const MAX_CATEGORY = 128;

const UNSIGNED_DECIMAL = /^\d+(?:\.(\d+))?$/;
const UNSIGNED_INTEGER = /^\d+$/;
const CURRENCY_SHAPE = /^[A-Za-z]{3}$/;

// ISO-8601: date, then T or a space, time, then optionally Z or ±HH:MM.
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(?:([Zz])|([+-])(\d{2}):(\d{2}))?$/;

const reject = (code: string, message: string, column?: string): RowResult => ({
  ok: false,
  error: column === undefined ? { code, message } : { code, message, column },
});

/**
 * `record` comes straight from csv-parse with `columns: true`. A field is
 * `undefined` when the row had fewer columns than the header — the generator's
 * "short-row" corruption, and something merchants' export tools do for real.
 */
export function validateRow(record: Partial<Record<string, string>>): RowResult {
  for (const column of REQUIRED_COLUMNS) {
    if (record[column] === undefined) {
      return reject(
        'missing_column',
        `Row is missing the "${column}" column (the row has fewer fields than the header)`,
        column,
      );
    }
  }

  // ---- sku ---------------------------------------------------------------
  const sku = record['sku']!.trim();
  if (sku.length === 0) {
    return reject('missing_sku', 'sku is empty; every row must identify a product', 'sku');
  }
  if (sku.length > MAX_SKU) {
    return reject('sku_too_long', `sku exceeds ${MAX_SKU} characters`, 'sku');
  }

  // ---- name / category ---------------------------------------------------
  const name = record['name']!;
  if (name.length > MAX_NAME) {
    return reject('name_too_long', `name exceeds ${MAX_NAME} characters`, 'name');
  }

  const category = record['category']!;
  if (category.length > MAX_CATEGORY) {
    return reject('category_too_long', `category exceeds ${MAX_CATEGORY} characters`, 'category');
  }

  // ---- currency (before price: it decides how many decimals are legal) ---
  const currencyRaw = record['currency']!.trim();
  if (!CURRENCY_SHAPE.test(currencyRaw)) {
    return reject(
      'invalid_currency',
      `currency "${currencyRaw}" is not a 3-letter ISO-4217 code`,
      'currency',
    );
  }
  const currency = currencyRaw.toUpperCase();
  if (!isValidCurrency(currency)) {
    return reject('unknown_currency', `"${currency}" is not an active ISO-4217 code`, 'currency');
  }

  // ---- price -------------------------------------------------------------
  const priceRaw = record['price']!.trim();
  if (priceRaw.length === 0) {
    return reject('invalid_price', 'price is empty', 'price');
  }
  if (priceRaw.startsWith('-')) {
    return reject('negative_price', `price "${priceRaw}" is negative`, 'price');
  }
  const priceMatch = UNSIGNED_DECIMAL.exec(priceRaw);
  if (!priceMatch) {
    return reject('invalid_price', `price "${priceRaw}" is not a decimal number`, 'price');
  }
  const decimals = priceMatch[1]?.length ?? 0;
  const allowed = minorUnits(currency);
  if (decimals > allowed) {
    return reject(
      'price_minor_units',
      `price "${priceRaw}" has ${decimals} decimal places; ${currency} allows at most ${allowed}`,
      'price',
    );
  }

  // ---- stock -------------------------------------------------------------
  const stockRaw = record['stock']!.trim();
  if (stockRaw.startsWith('-')) {
    return reject('negative_stock', `stock "${stockRaw}" is negative`, 'stock');
  }
  if (!UNSIGNED_INTEGER.test(stockRaw)) {
    return reject(
      'invalid_stock',
      `stock "${stockRaw}" is not a whole number of units`,
      'stock',
    );
  }
  const stock = Number(stockRaw);
  if (!Number.isSafeInteger(stock) || stock > 2_147_483_647) {
    return reject('stock_out_of_range', `stock "${stockRaw}" is too large`, 'stock');
  }

  // ---- updated_at --------------------------------------------------------
  const updatedAt = parseTimestamp(record['updated_at']!.trim());
  if (updatedAt === null) {
    return reject(
      'invalid_timestamp',
      `updated_at "${record['updated_at']}" is not an ISO-8601 timestamp`,
      'updated_at',
    );
  }

  return {
    ok: true,
    row: { sku, name, category, price: priceRaw, currency, stock, updatedAt },
  };
}

/**
 * Returns the instant as a UTC ISO string, or null if the text is not a real
 * timestamp. A regex alone is not enough: "2025-02-31" matches the shape but
 * is not a date, so the components are checked against the Date they produce.
 *
 * A timestamp with no offset is read as UTC. Rejecting those would bounce a
 * lot of otherwise fine merchant exports; the choice is documented in README.
 */
export function parseTimestamp(text: string): string | null {
  const m = TIMESTAMP.exec(text);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] ? Number(m[6]) : 0;
  const fraction = m[7] ? Number(`0.${m[7]}`) : 0;

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (m[9]) {
    const offHours = Number(m[10]);
    const offMinutes = Number(m[11]);
    if (offHours > 14 || offMinutes > 59) return null;
    offsetMinutes = (offHours * 60 + offMinutes) * (m[9] === '-' ? -1 : 1);
  }

  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, Math.round(fraction * 1000));
  const probe = new Date(utcMs);

  // Catches 2025-02-31, which Date.UTC silently rolls over to March 3rd.
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return new Date(utcMs - offsetMinutes * 60_000).toISOString();
}

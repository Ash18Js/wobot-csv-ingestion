#!/usr/bin/env node
/**
 * Deterministic bulk CSV generator for the catalog ingestion assignment.
 *
 * Streams to disk with backpressure, so it emits multi-GB files in constant
 * memory. Output is reproducible for a given --seed.
 *
 * Usage: npx tsx scripts/generate-csv.ts --out <file> [--rows N | --size 2GB] [options]
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: './tmp/catalog.csv' },
    rows: { type: 'string' },
    size: { type: 'string' }, // e.g. "512MB", "2GB"
    'bad-rate': { type: 'string', default: '0.02' },
    'dupe-rate': { type: 'string', default: '0.05' },
    seed: { type: 'string', default: '1' },
    crlf: { type: 'boolean', default: false },
    bom: { type: 'boolean', default: false },
    shuffle: { type: 'boolean', default: false }, // randomize header column order
  },
});

const OUT = values.out!;
const EOL = values.crlf ? '\r\n' : '\n';
const BAD_RATE = Number(values['bad-rate']);
const DUPE_RATE = Number(values['dupe-rate']);
const TARGET_BYTES = values.size ? parseSize(values.size) : null;
const TARGET_ROWS = values.rows ? Number(values.rows) : TARGET_BYTES ? null : 1_000_000;

function parseSize(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i.exec(input.trim());
  if (!m) throw new Error(`Invalid --size: ${input}`);
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[
    (m[2] ?? 'B').toLowerCase() as 'b' | 'kb' | 'mb' | 'gb'
  ];
  return Math.floor(Number(m[1]) * mult);
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(Number(values.seed));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number): boolean => rand() < p;
const intBetween = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const CATEGORIES = [
  'peripherals', 'lighting', 'audio', 'cables', 'storage',
  'furniture', 'stationery', 'networking', 'power', 'displays',
] as const;

const ADJECTIVES = [
  'Wireless', 'Compact', 'Adjustable', 'Heavy-Duty', 'Pro "Series"',
  'Ultra-Slim', 'Rugged', 'Silent', 'Ergonomic', 'Modular',
] as const;

const NOUNS = [
  'Mouse', 'Desk Lamp', 'Headset', 'HDMI Cable', 'SSD Enclosure',
  'Monitor Arm', 'Notebook', 'Switch', 'Surge Protector', 'Display',
] as const;

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'JPY'] as const;
type Currency = (typeof CURRENCIES)[number];

const MINOR_UNITS: Record<Currency, number> = {
  USD: 2, EUR: 2, GBP: 2, INR: 2, JPY: 0,
};

const COLUMNS = ['sku', 'name', 'category', 'price', 'currency', 'stock', 'updated_at'] as const;
type Column = (typeof COLUMNS)[number];

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

const BASE_TS = Date.UTC(2025, 2, 1, 0, 0, 0);
const OFFSETS_MIN = [330, -300, 540, 60, -480] as const;

function formatTs(ms: number): string {
  if (!chance(0.15)) return new Date(ms).toISOString();
  const off = pick(OFFSETS_MIN);
  const wall = new Date(ms + off * 60_000).toISOString().slice(0, -1);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${wall}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function makeName(): string {
  const base = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
  if (chance(0.15)) return `${base}, ${intBetween(2, 8)}-pack`;
  if (chance(0.05)) return `${base}\n(refurbished)`;
  return base;
}

function formatPrice(currency: Currency): string {
  const units = MINOR_UNITS[currency];
  return units === 0
    ? String(intBetween(100, 60_000))
    : (intBetween(99, 49_999) / 100).toFixed(units);
}

type Row = Record<Column, string>;

function validRow(sku: string, tsOffsetMinutes: number): Row {
  const currency = pick(CURRENCIES);
  return {
    sku,
    name: makeName(),
    category: pick(CATEGORIES),
    price: formatPrice(currency),
    currency,
    stock: String(intBetween(0, 5_000)),
    updated_at: formatTs(BASE_TS + tsOffsetMinutes * 60_000),
  };
}

type Corruption =
  | 'negative-price'
  | 'non-numeric-price'
  | 'wrong-minor-units'
  | 'negative-stock'
  | 'fractional-stock'
  | 'missing-sku'
  | 'bad-date'
  | 'bad-currency'
  | 'short-row';

const CORRUPTIONS: readonly Corruption[] = [
  'negative-price', 'non-numeric-price', 'wrong-minor-units',
  'negative-stock', 'fractional-stock', 'missing-sku',
  'bad-date', 'bad-currency', 'short-row',
];

function corrupt(row: Row, header: readonly Column[], kind: Corruption): string {
  const r = { ...row };
  switch (kind) {
    case 'negative-price':
      r.price = `-${r.price}`;
      break;
    case 'non-numeric-price':
      r.price = 'N/A';
      break;
    case 'wrong-minor-units':
      r.price = MINOR_UNITS[r.currency as Currency] === 0 ? `${r.price}.50` : `${r.price}9`;
      break;
    case 'negative-stock':
      r.stock = `-${intBetween(1, 50)}`;
      break;
    case 'fractional-stock':
      r.stock = `${intBetween(1, 50)}.5`;
      break;
    case 'missing-sku':
      r.sku = '';
      break;
    case 'bad-date':
      r.updated_at = '2025-13-45 99:99';
      break;
    case 'bad-currency':
      r.currency = 'DOLLARS';
      break;
    case 'short-row':
      return header.slice(0, -1).map((c) => csvField(r[c])).join(',');
  }
  return header.map((c) => csvField(r[c])).join(',');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(dirname(OUT), { recursive: true });

  const header: Column[] = [...COLUMNS];
  if (values.shuffle) {
    for (let i = header.length - 1; i > 0; i--) {
      const j = intBetween(0, i);
      [header[i], header[j]] = [header[j]!, header[i]!];
    }
  }

  const out = createWriteStream(OUT);
  let bytes = 0;

  const write = async (chunk: string): Promise<void> => {
    bytes += Buffer.byteLength(chunk);
    if (!out.write(chunk)) await once(out, 'drain');
  };

  if (values.bom) await write('﻿');
  await write(header.join(',') + EOL);

  // Duplicates are produced without retaining every SKU: `minted` counts the
  // SKUs issued so far (any value in 1..minted names a real one), and `recent`
  // is a fixed-size ring of lately-issued SKUs so some duplicates land near
  // their original and some far away. Memory stays flat for any file size.
  const RECENT_CAP = 50_000;
  const recent: string[] = [];
  let recentAt = 0;
  const remember = (sku: string): void => {
    if (recent.length < RECENT_CAP) recent.push(sku);
    else {
      recent[recentAt] = sku;
      recentAt = (recentAt + 1) % RECENT_CAP;
    }
  };

  const skuAt = (n: number): string => `SKU-${String(n).padStart(9, '0')}`;

  let minted = 0;
  let rowNo = 0;
  let bad = 0;
  let dupes = 0;

  const done = (): boolean =>
    TARGET_ROWS !== null ? rowNo >= TARGET_ROWS : bytes >= TARGET_BYTES!;

  while (!done()) {
    rowNo++;

    const isDupe = minted > 0 && chance(DUPE_RATE);
    let sku: string;
    if (isDupe) {
      sku =
        recent.length > 0 && chance(0.5)
          ? pick(recent) // a nearby earlier row
          : skuAt(intBetween(1, minted)); // anywhere earlier in the file
      dupes++;
    } else {
      sku = skuAt(++minted);
    }

    const offset = isDupe ? intBetween(-2_000, 2_000) : rowNo % 100_000;
    const row = validRow(sku, offset);

    let line: string;
    if (chance(BAD_RATE)) {
      line = corrupt(row, header, pick(CORRUPTIONS));
      bad++;
    } else {
      line = header.map((c) => csvField(row[c])).join(',');
      if (!isDupe) remember(sku);
    }

    await write(line + EOL);

    if (rowNo % 250_000 === 0) {
      const mb = (bytes / 1024 ** 2).toFixed(1);
      const rss = (process.memoryUsage().rss / 1024 ** 2).toFixed(1);
      process.stderr.write(`  ${rowNo} rows · ${mb} MB written · rss ${rss} MB\n`);
    }
  }

  out.end();
  await once(out, 'finish');

  process.stderr.write(
    `\nWrote ${OUT}\n` +
      `  rows:       ${rowNo}\n` +
      `  bytes:      ${bytes} (${(bytes / 1024 ** 3).toFixed(2)} GB)\n` +
      `  invalid:    ${bad} (${((bad / rowNo) * 100).toFixed(2)}%)\n` +
      `  duplicates: ${dupes} (${((dupes / rowNo) * 100).toFixed(2)}%)\n` +
      `  eol:        ${values.crlf ? 'CRLF' : 'LF'}${values.bom ? ' + BOM' : ''}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

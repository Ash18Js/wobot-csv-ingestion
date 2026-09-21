import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  csv,
  drainQueue,
  getStatus,
  hasDatabase,
  pool,
  productBySku,
  registerMerchant,
  resetDatabase,
  shutdown,
  upload,
  type TestAccount,
} from '../helpers/harness.js';

/**
 * These exercise the guarantees in section 4 of the brief against a real
 * Postgres. They are skipped when DATABASE_URL is unset so `npm test` still
 * works without a database; `docker compose up` provides one.
 */
describe.skipIf(!hasDatabase)('ingest', () => {
  let merchant: TestAccount;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    merchant = await registerMerchant();
  });

  afterAll(async () => {
    await shutdown();
  });

  it('ingests a clean file and reports an exact tally', async () => {
    const file = csv(
      'A-1001,"Wireless Mouse, Pro",peripherals,24.99,USD,150,2025-03-01T10:00:00Z',
      'A-1002,Desk Lamp,lighting,45.00,USD,0,2025-03-01T10:05:00+05:30',
      'A-1003,Headset,audio,36676,JPY,12,2025-03-01T11:00:00Z',
    );

    const { id, status } = await upload(merchant, 'clean.csv', file);
    expect(status).toBe('queued');

    await drainQueue();

    const result = await getStatus(merchant, id);
    expect(result.status).toBe('completed');
    expect(result.progress.rowsRead).toBe(3);
    expect(result.result).toEqual({ rowsApplied: 3, rowsSuperseded: 0, rowsRejected: 0 });

    const product = await productBySku(merchant.merchantId!, 'A-1001');
    expect(product.name).toBe('Wireless Mouse, Pro');
    // Exactness: NUMERIC in, string out, no float anywhere in between.
    expect(product.price).toBe('24.9900');
    expect(product.stock).toBe(150);
  });

  it('keeps bad rows from stopping the rest of the file', async () => {
    const file = csv(
      'A-1,Good,peripherals,10.00,USD,1,2025-03-01T10:00:00Z',
      'A-2,Bad price,peripherals,N/A,USD,1,2025-03-01T10:00:00Z',
      'A-3,Also good,peripherals,11.00,USD,1,2025-03-01T10:00:00Z',
      ',Missing sku,peripherals,12.00,USD,1,2025-03-01T10:00:00Z',
      'A-5,Bad date,peripherals,13.00,USD,1,2025-13-45 99:99',
      'A-6,Last good,peripherals,14.00,USD,1,2025-03-01T10:00:00Z',
    );

    const { id } = await upload(merchant, 'mixed.csv', file);
    await drainQueue();

    const result = await getStatus(merchant, id);
    expect(result.status).toBe('completed');
    expect(result.result.rowsApplied).toBe(3);
    expect(result.result.rowsRejected).toBe(3);

    // The good row *after* the bad ones is what proves the file kept going.
    expect(await productBySku(merchant.merchantId!, 'A-6')).not.toBeNull();
  });

  it('produces a rejection report a merchant can act on', async () => {
    const file = csv(
      'A-1,Good,peripherals,10.00,USD,1,2025-03-01T10:00:00Z',
      'A-2,Bad price,peripherals,N/A,USD,1,2025-03-01T10:00:00Z',
    );

    const { id } = await upload(merchant, 'report.csv', file);
    await drainQueue();

    const { rows } = await pool.query(
      `SELECT row_number, line_number, error_code, column_name, error_message, raw_line
         FROM import_rejections WHERE import_id = $1`,
      [id],
    );

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.row_number).toBe(2); // second data row
    expect(row.line_number).toBe(3); // third physical line, header included
    expect(row.error_code).toBe('invalid_price');
    expect(row.column_name).toBe('price');
    expect(row.error_message).toContain('N/A');
    expect(row.raw_line).toContain('A-2');
  });

  describe('the same file arriving twice', () => {
    it('is not applied twice', async () => {
      const file = csv('A-1,Widget,peripherals,10.00,USD,5,2025-03-01T10:00:00Z');

      const first = await upload(merchant, 'catalog.csv', file);
      const second = await upload(merchant, 'catalog.csv', file);

      expect(second.id).toBe(first.id);
      expect(second.deduplicated).toBe(true);

      await drainQueue();

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM imports');
      expect(rows[0]!.n).toBe(1);
    });

    it('still deduplicates when the filename differs', async () => {
      const file = csv('A-1,Widget,peripherals,10.00,USD,5,2025-03-01T10:00:00Z');
      const first = await upload(merchant, 'monday.csv', file);
      const second = await upload(merchant, 'monday-retry.csv', file);
      expect(second.id).toBe(first.id);
    });

    it('does not deduplicate across merchants', async () => {
      const other = await registerMerchant('Other Retail');
      const file = csv('A-1,Widget,peripherals,10.00,USD,5,2025-03-01T10:00:00Z');

      const mine = await upload(merchant, 'catalog.csv', file);
      const theirs = await upload(other, 'catalog.csv', file);

      expect(theirs.id).not.toBe(mine.id);
      expect(theirs.deduplicated).toBe(false);
    });
  });

  it("applies a merchant's corrected re-upload", async () => {
    const broken = csv('A-1,Widget,peripherals,N/A,USD,5,2025-03-01T10:00:00Z');
    const fixed = csv('A-1,Widget,peripherals,10.00,USD,5,2025-03-01T10:00:00Z');

    const first = await upload(merchant, 'catalog.csv', broken);
    await drainQueue();
    expect((await getStatus(merchant, first.id)).result.rowsRejected).toBe(1);
    expect(await productBySku(merchant.merchantId!, 'A-1')).toBeNull();

    const second = await upload(merchant, 'catalog.csv', fixed);
    expect(second.id).not.toBe(first.id); // different bytes, different import
    expect(second.deduplicated).toBe(false);

    await drainQueue();
    const product = await productBySku(merchant.merchantId!, 'A-1');
    expect(product.price).toBe('10.0000');
  });

  describe('freshness', () => {
    const fresh = csv('A-1,Newer,audio,99.00,USD,10,2025-03-02T00:00:00Z');
    const stale = csv('A-1,Older,cables,1.00,USD,999,2025-03-01T00:00:00Z');

    it('a stale update does not overwrite a fresher row', async () => {
      await upload(merchant, 'fresh.csv', fresh);
      await drainQueue();
      const staleImport = await upload(merchant, 'stale.csv', stale);
      await drainQueue();

      const product = await productBySku(merchant.merchantId!, 'A-1');
      expect(product.name).toBe('Newer');
      expect(product.stock).toBe(10);

      // And the import says honestly what happened to that row.
      const result = await getStatus(merchant, staleImport.id);
      expect(result.result).toMatchObject({ rowsApplied: 0, rowsSuperseded: 1, rowsRejected: 0 });
    });

    it('a fresher update does overwrite an older row', async () => {
      await upload(merchant, 'stale.csv', stale);
      await drainQueue();
      await upload(merchant, 'fresh.csv', fresh);
      await drainQueue();

      expect((await productBySku(merchant.merchantId!, 'A-1')).name).toBe('Newer');
    });

    it('within one file, the most recently updated row wins regardless of order', async () => {
      const file = csv(
        'A-1001,"Wireless Mouse, Pro",peripherals,24.99,USD,150,2025-03-01T10:00:00Z',
        'A-1001,Newest,peripherals,22.50,USD,148,2025-03-02T09:00:00Z',
        'A-1001,Middle,peripherals,23.00,USD,149,2025-03-01T18:00:00Z',
      );

      const { id } = await upload(merchant, 'dupes.csv', file);
      await drainQueue();

      const product = await productBySku(merchant.merchantId!, 'A-1001');
      expect(product.name).toBe('Newest');
      expect(product.price).toBe('22.5000');

      // Three rows read; one landed, two were superseded. Nothing vanishes.
      const result = await getStatus(merchant, id);
      expect(result.progress.rowsRead).toBe(3);
      expect(result.result.rowsApplied + result.result.rowsSuperseded).toBe(3);
    });

    it('holds when duplicates straddle a batch boundary', async () => {
      // INGEST_BATCH_ROWS is 500 in tests, so this deliberately spans batches:
      // the fresh row is in batch 1 and the stale one in batch 2.
      const filler = Array.from(
        { length: 600 },
        (_, i) => `F-${i},Filler,peripherals,1.00,USD,1,2025-03-01T10:00:00Z`,
      );
      const file = csv(
        'A-1,Newer,audio,99.00,USD,10,2025-03-02T00:00:00Z',
        ...filler,
        'A-1,Older,cables,1.00,USD,999,2025-03-01T00:00:00Z',
      );

      await upload(merchant, 'straddle.csv', file);
      await drainQueue();

      expect((await productBySku(merchant.merchantId!, 'A-1')).name).toBe('Newer');
    });
  });

  describe('CSV quirks from real export tooling', () => {
    it('reads columns by name, in any order', async () => {
      const file =
        'updated_at,stock,currency,price,category,name,sku\n' +
        '2025-03-01T10:00:00Z,7,USD,10.00,cables,Shuffled,A-9\n';

      await upload(merchant, 'shuffled.csv', file);
      await drainQueue();

      const product = await productBySku(merchant.merchantId!, 'A-9');
      expect(product.name).toBe('Shuffled');
      expect(product.stock).toBe(7);
    });

    it('handles a BOM and CRLF line endings', async () => {
      const file =
        '﻿sku,name,category,price,currency,stock,updated_at\r\n' +
        'A-10,BOM and CRLF,cables,10.00,USD,1,2025-03-01T10:00:00Z\r\n';

      await upload(merchant, 'bom.csv', file);
      await drainQueue();

      // If the BOM were not stripped the first column would be named
      // "﻿sku" and every row would fail as missing_column.
      expect((await productBySku(merchant.merchantId!, 'A-10')).name).toBe('BOM and CRLF');
    });

    it('handles quoted fields containing commas, quotes and newlines', async () => {
      const file = csv(
        'A-11,"Desk Lamp\n(adjustable), 2-pack",lighting,45.00,USD,3,2025-03-01T10:00:00Z',
        'A-12,"Pro ""Series"" Mouse",peripherals,30.00,USD,4,2025-03-01T10:00:00Z',
      );

      await upload(merchant, 'quoted.csv', file);
      await drainQueue();

      expect((await productBySku(merchant.merchantId!, 'A-11')).name).toBe(
        'Desk Lamp\n(adjustable), 2-pack',
      );
      expect((await productBySku(merchant.merchantId!, 'A-12')).name).toBe('Pro "Series" Mouse');
    });

    it('fails the import when the header lacks a required column', async () => {
      const file = 'sku,name,price,currency,stock,updated_at\nA-1,No category,10.00,USD,1,2025-03-01T10:00:00Z\n';

      const { id } = await upload(merchant, 'noheader.csv', file);
      await drainQueue();

      const result = await getStatus(merchant, id);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('category');
      // Failed on the header means no partial catalog was written.
      expect(result.result.rowsApplied).toBe(0);
    });
  });

  describe('crash recovery', () => {
    it('resumes from the checkpoint instead of starting over', async () => {
      const rows = Array.from(
        { length: 1200 },
        (_, i) => `R-${i},Row ${i},peripherals,1.00,USD,1,2025-03-01T10:00:00Z`,
      );
      const { id } = await upload(merchant, 'resume.csv', csv(...rows));

      // Stop after the first batch, exactly as SIGTERM would.
      let batches = 0;
      const { processNextImport } = await import('../helpers/harness.js');
      await processNextImport(() => ++batches >= 1);

      const halfway = await getStatus(merchant, id);
      expect(halfway.status).toBe('processing');
      expect(halfway.progress.rowsRead).toBeGreaterThan(0);
      expect(halfway.progress.rowsRead).toBeLessThan(1200);
      const checkpointBytes = halfway.progress.bytesProcessed;
      expect(checkpointBytes).toBeGreaterThan(0);

      // A fresh worker picks it up and carries on from that byte.
      await drainQueue();

      const done = await getStatus(merchant, id);
      expect(done.status).toBe('completed');
      expect(done.progress.rowsRead).toBe(1200);
      expect(done.result.rowsApplied).toBe(1200);
      expect(done.attempts).toBe(2);

      const { rows: count } = await pool.query(
        'SELECT count(*)::int AS n FROM products WHERE merchant_id = $1',
        [merchant.merchantId],
      );
      expect(count[0]!.n).toBe(1200);
    });

    it('never lets the tally drift from the rows read', async () => {
      const rows = Array.from({ length: 900 }, (_, i) =>
        i % 7 === 0
          ? `B-${i},Bad,peripherals,N/A,USD,1,2025-03-01T10:00:00Z`
          : `B-${i},Good,peripherals,1.00,USD,1,2025-03-01T10:00:00Z`,
      );
      const { id } = await upload(merchant, 'invariant.csv', csv(...rows));
      await drainQueue();

      const r = await getStatus(merchant, id);
      expect(r.progress.rowsRead).toBe(
        r.result.rowsApplied + r.result.rowsSuperseded + r.result.rowsRejected,
      );
    });
  });

  describe('cancel', () => {
    it('stops a running ingest and leaves it cancelled', async () => {
      const rows = Array.from(
        { length: 1200 },
        (_, i) => `C-${i},Row,peripherals,1.00,USD,1,2025-03-01T10:00:00Z`,
      );
      const { id } = await upload(merchant, 'cancel.csv', csv(...rows));

      const { getApp } = await import('../helpers/harness.js');
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/imports/${id}/cancel`,
        headers: { authorization: `Bearer ${merchant.token}` },
      });
      expect(res.statusCode).toBe(202);

      await drainQueue();

      const result = await getStatus(merchant, id);
      // Cancelled before a worker ever claimed it.
      expect(result.status).toBe('cancelled');
      expect(result.result.rowsApplied).toBe(0);
    });

    it('refuses to cancel an import that already finished', async () => {
      const { id } = await upload(
        merchant,
        'done.csv',
        csv('A-1,Widget,peripherals,10.00,USD,5,2025-03-01T10:00:00Z'),
      );
      await drainQueue();

      const { getApp } = await import('../helpers/harness.js');
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/imports/${id}/cancel`,
        headers: { authorization: `Bearer ${merchant.token}` },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain('completed');
    });
  });
});

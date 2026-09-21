-- The catalog itself.
--
-- Primary key is (merchant_id, sku): a SKU identifies a product *within a
-- merchant's catalog*, so two merchants may legitimately use the same string.
--
-- price is NUMERIC, never a float. NUMERIC is exact decimal arithmetic in
-- Postgres; a double would silently turn 24.99 into 24.989999999999998.
-- Scale 4 leaves room for currencies with more than two minor units.
--
-- updated_at is the *merchant's* edit timestamp from the file, not our clock.
-- It is the value the staleness guard compares on, so it earns a real column.

CREATE TABLE products (
    merchant_id    uuid           NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
    sku            text           NOT NULL,
    name           text           NOT NULL,
    category       text           NOT NULL,
    price          numeric(20, 4) NOT NULL,
    currency       char(3)        NOT NULL,
    stock          integer        NOT NULL,
    updated_at     timestamptz    NOT NULL,

    -- Our own bookkeeping, useful when a merchant asks "which upload did this?"
    ingested_at    timestamptz    NOT NULL DEFAULT now(),
    last_import_id uuid,

    PRIMARY KEY (merchant_id, sku),

    CONSTRAINT products_price_non_negative CHECK (price >= 0),
    CONSTRAINT products_stock_non_negative CHECK (stock >= 0)
);

-- Deliberately no secondary indexes.
--
-- Every extra index is maintained on every one of the tens of millions of
-- upserts an ingest performs, and this table's whole job is to absorb writes.
-- The (merchant_id, sku) primary key already serves the upsert and the only
-- read the API needs. A reporting index belongs on a read replica or behind a
-- measured requirement, not on the write path by default.

-- Imports: the job record, the checkpoint, the lease, and the rejection log.

CREATE TYPE import_status AS ENUM (
    'queued',      -- accepted, file on disk, nobody working on it yet
    'processing',  -- a worker holds a lease on it
    'completed',
    'failed',
    'cancelled'
);

CREATE TABLE imports (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id    uuid          NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
    uploaded_by    uuid          NOT NULL REFERENCES users (id),

    original_filename text       NOT NULL,
    -- SHA-256 of the exact bytes received. This is the whole de-duplication
    -- story: same bytes for the same merchant = same import, no matter how
    -- many times a timed-out client retries. A *corrected* re-upload has
    -- different bytes, so it is a different import and does take effect.
    content_sha256 bytea         NOT NULL,
    size_bytes     bigint        NOT NULL,
    storage_path   text          NOT NULL,

    status           import_status NOT NULL DEFAULT 'queued',
    cancel_requested boolean       NOT NULL DEFAULT false,

    -- Header order varies per merchant, so we record the order we actually saw.
    -- It is also what lets a resumed ingest start mid-file, where there is no
    -- header line to read.
    header_columns jsonb,

    -- ---- checkpoint --------------------------------------------------------
    -- Written inside the same transaction as the batch it describes. That is
    -- what makes "kill -9 at any moment" safe: either the batch and the
    -- checkpoint both landed, or neither did.
    bytes_processed  bigint NOT NULL DEFAULT 0,  -- byte offset of a record boundary
    rows_read        bigint NOT NULL DEFAULT 0,
    rows_applied     bigint NOT NULL DEFAULT 0,  -- inserted or updated
    rows_superseded  bigint NOT NULL DEFAULT 0,  -- valid, but older than what we hold
    rows_rejected    bigint NOT NULL DEFAULT 0,

    -- ---- worker lease ------------------------------------------------------
    locked_by        text,
    lease_expires_at timestamptz,
    attempts         integer NOT NULL DEFAULT 0,

    error       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    started_at  timestamptz,
    finished_at timestamptz
);

-- Idempotent upload. A second POST of identical bytes hits this index and we
-- hand back the original import instead of doing the work twice.
CREATE UNIQUE INDEX imports_merchant_content_key
    ON imports (merchant_id, content_sha256);

-- The queue lookup. Partial, so it stays small however long the history gets.
CREATE INDEX imports_claimable_idx
    ON imports (created_at)
    WHERE status IN ('queued', 'processing');

CREATE INDEX imports_merchant_recent_idx
    ON imports (merchant_id, created_at DESC);

-- One row per rejected line. The primary key is (import_id, row_number), which
-- makes re-writing a batch after a crash a no-op instead of a duplicate.
CREATE TABLE import_rejections (
    import_id     uuid   NOT NULL REFERENCES imports (id) ON DELETE CASCADE,
    row_number    bigint NOT NULL,   -- 1-based data row, excluding the header
    line_number   bigint,            -- physical line in the file, for the merchant
    error_code    text   NOT NULL,
    error_message text   NOT NULL,
    column_name   text,
    raw_line      text   NOT NULL,   -- truncated; see RAW_LINE_MAX_CHARS

    PRIMARY KEY (import_id, row_number)
);

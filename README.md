# Bulk CSV Catalog Ingestion

A REST service that ingests merchant product catalogs from CSV. Files reach
2 GB and tens of millions of rows, arrive in bursts, are routinely malformed,
and are frequently re-uploaded. The service runs in a 512 MB container.

Node 22 · TypeScript (strict) · Fastify · PostgreSQL 16 · no queue broker.

---

## Quick start

```bash
docker compose up --build
```

That brings up Postgres, applies migrations, and starts the API on
**http://localhost:3000** plus one ingest worker. Nothing needs to be installed
locally.

```bash
curl localhost:3000/health
```

Run the test suite (it uses a separate database and will not disturb your data):

```bash
docker compose run --rm test
```

Generate test files (needs Node locally, or run it inside the worker container):

```bash
npm i -D tsx
npx tsx scripts/generate-csv.ts --out ./tmp/fixture.csv --rows 500 --bad-rate 0.2 --seed 42
npx tsx scripts/generate-csv.ts --out ./tmp/huge.csv --size 2GB --bad-rate 0.05 --dupe-rate 0.10 --crlf --bom
```

---

## Five minutes, end to end

```bash
# 1. Register. This creates the merchant and its first user.
curl -sX POST localhost:3000/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"accountType":"merchant","email":"ops@acme.test",
       "password":"correct-horse-battery-staple","merchantName":"Acme Retail"}'

TOKEN=...   # accessToken from the response

# 2. Upload. Returns 202 immediately; the request does not wait for the ingest.
curl -sX POST localhost:3000/v1/imports \
  -H "authorization: Bearer $TOKEN" \
  -F "file=@./tmp/fixture.csv"

IMPORT=...  # id from the response

# 3. Poll.
curl -s localhost:3000/v1/imports/$IMPORT -H "authorization: Bearer $TOKEN"

# 4. Get the bad rows back as a CSV the merchant can open next to their file.
curl -s localhost:3000/v1/imports/$IMPORT/rejections -H "authorization: Bearer $TOKEN"

# 5. Stop one that is still running.
curl -sX POST localhost:3000/v1/imports/$IMPORT/cancel -H "authorization: Bearer $TOKEN"
```

---

## API

Nothing is public except `/health` and the auth endpoints. Every other route
requires `Authorization: Bearer <accessToken>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/auth/register` | Create a merchant + its first user, or a staff user with the registration code |
| `POST` | `/v1/auth/login` | Exchange credentials for an access token and a refresh token |
| `POST` | `/v1/auth/token/refresh` | Rotate the refresh token, get a new access token |
| `POST` | `/v1/auth/logout` | Revoke a refresh token |
| `GET` | `/v1/auth/me` | The current user and their merchant |
| `POST` | `/v1/imports` | Upload one or more CSVs. `202` with a pollable resource per file |
| `GET` | `/v1/imports` | List imports, newest first |
| `GET` | `/v1/imports/:id` | Status, progress and the outcome tally |
| `GET` | `/v1/imports/:id/rejections` | Rejected rows as CSV (`?format=json` for JSON) |
| `POST` | `/v1/imports/:id/cancel` | Ask a running ingest to stop. `202` |
| `GET` | `/v1/products` | Read the catalog — mostly so an ingest can be verified |

### Status codes

`202` on upload and cancel, because both are accepted-not-done. `409` when
cancelling something already finished. `413` when an upload exceeds the limit.
`404` — not `403` — when a merchant asks for another merchant's import, so an id
cannot be probed for existence. Validation failures are `400` with the offending
field named.

### `merchantId` travels in the query string

`POST /v1/imports?merchantId=...` — not as a form field. Multipart fields may
legally arrive *after* the file parts, and deciding who a 2 GB body belongs to
is not something to discover halfway through streaming it to disk. Merchant
users may omit it (theirs is implied) and are refused if they name someone
else's. Platform staff must supply it.

---

## Data model

```
merchants ──< users ──< refresh_tokens
     │          │
     │          └──< imports ──< import_rejections
     └──< products
```

- **`products`** is keyed on `(merchant_id, sku)`: a SKU identifies a product
  *within a merchant's catalog*, so two merchants may use the same string.
  `price` is `NUMERIC(20,4)` and is read back as a string — a float would turn
  `24.99` into `24.989999999999998`. `updated_at` is the merchant's own edit
  time from the file, not our clock, because it is what the freshness guard
  compares on.
- **`imports`** carries the job, the checkpoint, the worker lease and the tally.
- **`import_rejections`** is keyed on `(import_id, row_number)`.

Schema changes are forward-only SQL files in `migrations/`, applied by
`scripts/migrate.ts` under an advisory lock and recorded with a checksum, so a
migration that has already shipped cannot be silently edited.

---

## How the operating constraints are met

### 2 GB files, tens of millions of rows, 512 MB container

Nothing is ever fully in memory.

The upload is streamed straight to disk and SHA-256'd **on the way past** — one
pass, not a write followed by a re-read. The ingest then reads that file with a
streaming RFC 4180 parser, and `for await` over the parser applies backpressure
through the whole chain: while a batch is being written to Postgres, the parser
is paused and the file read is paused behind it. The COPY stream is written with
`drain` respected for the same reason.

Memory is therefore a function of `INGEST_BATCH_ROWS` (default 20,000), not of
file size. **Measured peak: ~124 MB for a 1M-row file and the same for 2 GB.**
The container is capped at 512 MB in `docker-compose.yml` and V8's heap at
320 MB, so a regression that stops being streaming crashes loudly instead of
being quietly OOM-killed.

### Bad rows must not stop the file

Validation is per row and returns a code, a message and the offending column.
The parser is configured to be forgiving where merchants' tooling is sloppy —
`relax_column_count` so a short row becomes a record with missing fields rather
than a fatal error, `relax_quotes`, `skip_records_with_error` for bytes that
cannot be parsed at all — and everything it hands back is judged by our
validator, which rejects rows individually and keeps going.

Rejections are written in the same transaction as the batch they came from, so
the report can never claim a row was rejected in work that was rolled back.

The report at `/v1/imports/:id/rejections` gives, per row: the data row number,
the physical line number in the file, an error code, the column, a message, and
the row as we read it. That is enough to find and fix it in the original file.

### The same file arriving twice must not be applied twice

A unique index on `(merchant_id, content_sha256)`. The insert is
`ON CONFLICT DO NOTHING` and, when it does nothing, the caller gets the original
import back with `"deduplicated": true`. The database decides, so two requests
racing in parallel — which is exactly what a timed-out client retry looks like —
cannot both win.

### A corrected re-upload must take effect

Different bytes, different hash, different import. There is nothing to special
case: the same mechanism that stops an identical retry lets a fixed file
through.

### A stale update must never overwrite a fresher one

This is the one guarantee that cannot be done in application code without
locking, so it is done in the statement:

```sql
INSERT INTO products (...)
SELECT ... FROM deduped
ON CONFLICT (merchant_id, sku) DO UPDATE
   SET ...
 WHERE excluded.updated_at > products.updated_at
```

Three things fall out of that one clause:

1. **Within a file.** `deduped` is a `DISTINCT ON (sku) ... ORDER BY sku,
   updated_at DESC` over the batch, so repeated SKUs collapse to the newest.
   This is also required, not just desirable: `ON CONFLICT DO UPDATE` refuses to
   touch the same row twice in one statement.
2. **Across batches.** The `WHERE` re-checks against what is actually stored.
3. **Across concurrent ingests.** Postgres holds a row lock for the duration of
   the conflict check, so two workers importing overlapping files for the same
   merchant serialize on the row itself. No advisory locks, no application-level
   mutex, no ordering requirement between workers.

A row that loses is counted as `superseded`, not dropped silently. For any
import, `rowsRead == rowsApplied + rowsSuperseded + rowsRejected` — there is a
test that asserts it.

### The process can be killed at any moment

Each batch commits **the staged rows, the merge, the rejection log and the
checkpoint in one transaction.** There is no window where the catalog has moved
forward but the checkpoint has not, or the reverse.

The checkpoint stores the byte offset of a record boundary (from the parser, so
it is always a boundary) and the header column order. A worker that finds an
import whose lease has expired re-claims it and **resumes from that byte** —
`createReadStream(path, { start })` with the recorded columns replayed, since
there is no header line in the middle of a file.

Re-applying a batch is idempotent anyway: the freshness guard is `>`, so
re-writing rows with equal timestamps changes nothing, and rejections are keyed
on `(import_id, row_number)`.

`SIGTERM` is handled separately from a kill: the worker finishes the batch in
flight, hands the lease back, and exits. The next worker starts from that
checkpoint immediately rather than waiting the lease out.

Verified by killing the worker with `SIGKILL` at 25% of a 1M-row file: the
durable tally was exact at the moment of the kill, the restarted worker resumed
from byte 21,701,975 rather than zero, and the final result was exactly
1,000,000 rows with no double counting. There is an automated test for the same
path.

### Throughput under bursty uploads

- Rows are loaded with `COPY ... FROM STDIN` into a session-local `TEMP` table,
  then merged with a single statement. `TEMP` writes no WAL and cannot collide
  between workers.
- Writes are **pipelined one deep**: while a batch is being COPYed and merged,
  the parser fills the next one. Parsing is CPU-bound and the write is I/O-bound.
  Only one write is ever in flight, which keeps checkpoints strictly ordered; at
  most two batches are in memory, about 6 MB.
- `synchronous_commit` is turned off **on the ingest session only** (see the
  comment in `copy-sink.ts` for why that is safe here and not elsewhere).
- `products` deliberately carries **no secondary indexes**. Every extra index is
  maintained on every one of tens of millions of upserts.
- Scale out with `docker compose up --scale worker=3`. Jobs are claimed with
  `FOR UPDATE SKIP LOCKED`, so workers never double-process and there is no
  broker to run.

---

## Measured performance

Full numbers, methodology and hardware are in **[`BENCHMARK.md`](BENCHMARK.md)**.
A 2.00 GiB file — 24,708,106 rows, CRLF + BOM, 5% malformed, 10% duplicate SKUs
— run on two very different machines:

| | Windows 11 · i5-13450HX (Docker Desktop) | Linux · 2-vCPU Xeon (native) |
| --- | --- | --- |
| Upload + SHA-256 + `202` | 21.6 s | 13.2 s |
| Ingest wall clock | 31.1 min | 19.8 min |
| Throughput | 13,236 rows/sec | 20,768 rows/sec |
| Peak worker memory | **160 MiB** / 512 MiB | **148 MB** / 512 MB |
| Attempts | 1 | 1 |

Both produced **identical tallies** — 21,189,124 applied, 2,280,595 superseded,
1,238,387 rejected, summing exactly to 24,708,106. The rejected count matches
the generator's own count of malformed rows. The result did not depend on
hardware, batch timing, or how the work happened to be scheduled.

`docker stats` mid-ingest says what the constraint is: worker at **85% CPU and
59 MiB of its 512 MiB cap**, Postgres at **88% CPU and 571 MiB of 7.6 GiB
available**, with 12.3 MB read from disk across the whole run. Not memory, not
read I/O — CPU, on both sides at once, which is also evidence the write
pipelining works.

Stage isolation, measured separately:

| Stage | Rows/sec |
| --- | --- |
| CSV parse only | 134,500 |
| parse + `info` (byte offsets for checkpointing) | ~120,000 |
| parse + `info` + validation | 78,900 |
| full pipeline including COPY + merge + commit | 20,768 |

Two decisions came out of that table. `raw: true` on the parser (keeping each
line's original text) cost a further 15% **on every row** to serve the 2–5% that
get rejected — dropped, and the rejection report re-serializes the parsed record
instead. And the parser ceiling (~79k rows/sec) sits well above the database
side (~28k), so the merge is where to spend further effort, not the parse.

Reproduce with `./scripts/benchmark.sh ./tmp/huge.csv`, or
`.\scripts\benchmark.ps1 -File .\tmp\huge.csv` on Windows.

---

## Tests

```bash
docker compose run --rm test     # in Docker, against its own database
npm test                         # locally; needs DATABASE_URL for the integration tests
```

95 tests. The unit tests need no database and cover the validator, the money
and timestamp handling, password hashing and the JWT paths — including a
tampered payload and the `alg: none` forgery. The integration tests run against
real Postgres and cover each guarantee above as a behaviour rather than as an
implementation detail:

- a bad row does not stop the rows after it
- the rejection report points at the right row, line and column
- identical bytes twice produce one import; a corrected file produces a second
- the same bytes from two different merchants are two imports
- a stale file does not overwrite a fresher row, in either upload order
- within one file the newest row wins regardless of position, **including when
  the duplicates straddle a batch boundary**
- a killed ingest resumes from its checkpoint and finishes with an exact tally
- `rowsRead == applied + superseded + rejected`, always
- shuffled column order, BOM, CRLF, embedded newlines and doubled quotes
- a header missing a required column fails the import and writes nothing
- cancel stops a run; cancelling a finished import is a `409`
- one merchant cannot read, cancel, report on or upload into another's data
- platform staff can reach any merchant but must say which
- refresh tokens rotate, and a replayed one is refused

The resume test found a real bug during development: releasing a lease set
`lease_expires_at` to `NULL`, and `NULL < now()` is `NULL`, not `true`, so a
cleanly-paused import could never be re-claimed. That predicate is now explicit.

---

## Judgement calls

Where the brief was open, these are the calls made and why.

**Auth is built, not delegated.** scrypt from Node's standard library for
passwords — memory-hard, and no native module, so the image needs no build
toolchain. Short-lived HS256 access tokens (stateless, so the hot path costs a
HMAC verify and no database round trip) plus opaque refresh tokens stored as
SHA-256 digests and rotated on use. The verify pins `algorithms: ['HS256']`;
leaving that to the token's own header is how `alg` confusion attacks work.

**Staff cannot self-register.** A shared `STAFF_REGISTRATION_CODE` gates it. A
real deployment would use a one-time invite table; the point here was that the
open internet must not be able to mint a user who can read every merchant.

**A timestamp with no offset is read as UTC** rather than rejected. Rejecting
them would bounce a lot of otherwise fine merchant exports over a formatting
detail. The alternative — guessing a local zone — would be worse, because it
could silently make a row look fresher or staler than it is.

**Price decimals are checked against the currency.** `24.999` is not a USD
amount and `1000.50` is not a JPY one. The ISO 4217 table in
`src/ingest/currency.ts` carries the minor-unit exponents. Fewer decimals than
allowed is fine (`45` for USD); more is a rejection.

**Cancel is cooperative, and partial work stays.** A running ingest stops at the
next batch boundary — tearing a transaction in half to be a second faster is not
a trade worth making. Rows already committed remain in the catalog. That is the
honest semantics for an upsert stream: they were real updates, and the
alternative (rolling back a partially applied 2 GB file) means holding a
transaction open for the entire ingest, which defeats the memory design.

**Rejected rows are stored, capped.** `raw_line` is truncated to 2,000
characters so one pathological line cannot bloat the table.

**Resume was implemented** even though the brief lists it as optional, because
once each batch commits its own checkpoint the remaining work is a byte offset
and a stored column order. Not resuming would mean re-reading up to 2 GB after a
restart — hard to justify when the checkpoint is already there.

**Multiple workers, likewise.** `FOR UPDATE SKIP LOCKED` was the claiming
mechanism anyway; supporting several workers is what that already does.

---

## What is deliberately not here

- **No queue broker.** Postgres is already a dependency and `SKIP LOCKED` is a
  proper work queue. Adding Redis or RabbitMQ would be a second thing to operate
  for no capability this service needs.
- **No ORM.** The two statements that matter are a `COPY` and a merge with a
  conditional `DO UPDATE`. Both are clearer as SQL than as anything generated.
- **Uploaded files are never deleted.** They are content-addressed on disk and a
  resumed ingest needs them. A retention job is the obvious next piece of work,
  and it is a policy decision rather than a technical one.
- **No per-merchant rate limits or quotas**, and no dry-run mode. Both are listed
  as optional and neither changes the shape of anything above.
- **Rejection reports are unpaginated in CSV form** (streamed, so memory is
  fine) and capped at 1,000 rows in JSON form, which exists for humans poking at
  it rather than for machines.

---

## Configuration

Copy `.env.example` to `.env` for local runs; `docker-compose.yml` sets these
itself.

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | Required |
| `JWT_SECRET` | — | Required, 32+ chars. The value in `docker-compose.yml` is a dev placeholder and says so; a real deployment supplies its own |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `UPLOAD_DIR` | `./uploads` | Shared volume between API and workers |
| `MAX_UPLOAD_BYTES` | `2147483648` | 2 GB |
| `INGEST_BATCH_ROWS` | `20000` | The memory/throughput dial |
| `LEASE_SECONDS` | `30` | How long a worker's claim survives without a heartbeat |
| `STAFF_REGISTRATION_CODE` | unset | Staff registration is refused when unset |
| `WORKER_ID` | hostname+pid | Recorded on the lease |

## Layout

```
migrations/            forward-only SQL
scripts/
  migrate.ts           migration runner
  generate-csv.ts      the generator from the brief
  benchmark.sh         end-to-end ingest benchmark
src/
  api.ts               HTTP entrypoint
  worker.ts            ingest worker entrypoint
  config.ts            all environment reading, validated once at boot
  db.ts                pool, transaction helpers, type parsers
  auth/                passwords, tokens
  http/                server, routes, guards, errors
  imports/             upload storage, import repository
  ingest/
    pipeline.ts        stream → parse → validate → batch → checkpoint
    row-validator.ts   the hot loop; pure, exhaustively tested
    copy-sink.ts       COPY + the merge statement + the checkpoint transaction
    currency.ts        ISO 4217 minor units
    worker-loop.ts     claim, run, finish, retry
tests/
  unit/                no database required
  integration/         real Postgres
```

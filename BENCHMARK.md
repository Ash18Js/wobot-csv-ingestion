# 2 GB ingest — measured

Produced by `./scripts/benchmark.sh ./tmp/huge.csv` (or `scripts/benchmark.ps1`
on Windows). Reproduce with:

```bash
npx tsx scripts/generate-csv.ts --out ./tmp/huge.csv \
  --size 2GB --bad-rate 0.05 --dupe-rate 0.10 --crlf --bom
```

## Hardware

| | |
| --- | --- |
| CPU | 2 vCPU, Intel Xeon @ 2.80 GHz |
| RAM | 7 GB |
| Disk | SSD-backed virtual disk |
| OS | Linux 6.18, Node 22.22, PostgreSQL 16 |
| Topology | API, worker **and Postgres all on the same 2 cores** |

That last row is the important one. The parser is CPU-bound and the database
write is I/O-bound, and on a two-core box they contend rather than overlap —
this is close to the worst case for the design. A machine that can run Node and
Postgres in parallel will do considerably better on the same code.

## Input

| | |
| --- | --- |
| Size | 2,147,483,731 bytes (2.00 GiB) |
| Rows | 24,708,106 |
| Line endings | CRLF, with a UTF-8 BOM |
| Malformed | 1,238,387 (5.01%) |
| Duplicate SKUs | 2,472,295 (10.01%) |

## Result

| | |
| --- | --- |
| Upload + SHA-256 + `202` response | **13.2 s** (~155 MB/s) |
| Ingest wall clock | **1,189.7 s** (19 min 50 s) |
| Throughput | **20,768 rows/sec** · 1.72 MB/sec |
| Peak worker RSS | **148 MB** (container limit 512 MB) |
| Attempts | 1 — no retries, no resumes |
| Bytes processed | 2,147,483,731 of 2,147,483,731 |

```
rows read    24,708,106
applied      21,189,124
superseded    2,280,595
rejected      1,238,387
             ───────────
             24,708,106   ✓ read == applied + superseded + rejected
```

Resulting state: 21,177,401 distinct products, 1,238,387 rejection rows,
4,150 MB of database.

The 1,238,387 rejections match the generator's own count of malformed rows
exactly — nothing was silently dropped and nothing was rejected twice.

## Notes

**Memory is flat.** RSS sat at 133 MB shortly after the first batch and peaked
at 148 MB nineteen minutes later. It is a function of `INGEST_BATCH_ROWS`, not
of file size: the same code used 124 MB for an 82 MB file.

**Upload is not the bottleneck.** 2 GB streamed to disk and hashed in 13
seconds, and the request returned `202` there — the caller never waits for the
ingest.

**Where the 20 minutes goes**, measured by running the stages in isolation on
the same box:

| Stage | Rows/sec |
| --- | --- |
| CSV parse only | 134,500 |
| parse + byte-offset tracking | ~120,000 |
| parse + validation | 78,900 |
| full pipeline (COPY + merge + commit) | 20,768 |

So the database side is roughly 28,000 rows/sec here and the parser 79,000, and
they are sharing two cores. Write pipelining is implemented and correct but buys
little in this configuration for exactly that reason; on hardware where the two
stages can run at the same time it is close to free throughput.

**Smaller reference point**, same box — 1,000,000 rows / 82 MB: 47.7 s,
20,973 rows/sec, peak RSS 124 MB.

---

## Your own run

Replace the tables above, or add a section, with numbers from the machine you
measure on. State the CPU, core count, RAM and disk type — the numbers mean
nothing without them.

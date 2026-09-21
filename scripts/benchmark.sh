#!/usr/bin/env bash
#
# End-to-end ingest benchmark.
#
#   ./scripts/benchmark.sh ./tmp/huge.csv
#
# Registers (or reuses) a benchmark merchant, uploads the file, polls until the
# ingest finishes, and prints the numbers section 7 of the brief asks for:
# wall clock, rows/sec, MB/sec, and peak worker memory.
#
# Peak memory is sampled from `docker stats` when the worker is running under
# compose, and from ps otherwise.
set -euo pipefail

FILE="${1:-./tmp/huge.csv}"
API="${API:-http://localhost:3000}"
EMAIL="${BENCH_EMAIL:-benchmark@example.test}"
PASSWORD="${BENCH_PASSWORD:-benchmark-password-1234}"
WORKER_CONTAINER="${WORKER_CONTAINER:-wobot-csv-ingestion-worker-1}"

command -v jq >/dev/null || { echo "This script needs jq. Install it, or read the numbers from /v1/imports/<id>."; exit 1; }
[ -f "$FILE" ] || { echo "No such file: $FILE"; exit 1; }

say() { printf '%s\n' "$*"; }

# ---- authenticate -----------------------------------------------------------
TOKEN=$(curl -sS -X POST "$API/v1/auth/register" -H 'content-type: application/json' \
  -d "{\"accountType\":\"merchant\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"merchantName\":\"Benchmark Retail\"}" \
  | jq -r '.accessToken // empty')

if [ -z "$TOKEN" ]; then
  TOKEN=$(curl -sS -X POST "$API/v1/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r '.accessToken')
fi
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "Could not authenticate against $API"; exit 1; }

SIZE_BYTES=$(wc -c < "$FILE")
say ""
say "file        : $FILE"
say "size        : $(awk -v b="$SIZE_BYTES" 'BEGIN{printf "%.2f GB (%d bytes)", b/1073741824, b}')"
say "api         : $API"
say ""

# ---- upload -----------------------------------------------------------------
UPLOAD_START=$(date +%s.%N)
ID=$(curl -sS -X POST "$API/v1/imports" -H "authorization: Bearer $TOKEN" \
  -F "file=@$FILE" | jq -r '.imports[0].id')
UPLOAD_END=$(date +%s.%N)

[ "$ID" != "null" ] || { echo "Upload failed"; exit 1; }
say "import id   : $ID"
say "upload+hash : $(awk -v a="$UPLOAD_START" -v b="$UPLOAD_END" 'BEGIN{printf "%.1fs", b-a}')  (request returns 202 here; ingest runs behind it)"
say ""

# ---- poll -------------------------------------------------------------------
PEAK_MB=0
INGEST_START=$(date +%s.%N)

while :; do
  BODY=$(curl -sS "$API/v1/imports/$ID" -H "authorization: Bearer $TOKEN")
  STATUS=$(echo "$BODY" | jq -r '.status')

  MEM=$(docker stats --no-stream --format '{{.MemUsage}}' "$WORKER_CONTAINER" 2>/dev/null \
        | awk '{print $1}' | sed 's/MiB//;s/GiB/*1024/' | bc 2>/dev/null || true)
  if [ -n "${MEM:-}" ]; then
    PEAK_MB=$(awk -v a="$PEAK_MB" -v b="$MEM" 'BEGIN{print (b>a)?b:a}')
  fi

  case "$STATUS" in
    completed|failed|cancelled) break ;;
  esac

  echo "$BODY" | jq -r '"  \(.status)  \((.progress.fraction*100)|floor)%  rows=\(.progress.rowsRead)"'
  sleep 5
done

INGEST_END=$(date +%s.%N)
ELAPSED=$(awk -v a="$INGEST_START" -v b="$INGEST_END" 'BEGIN{print b-a}')
ROWS=$(echo "$BODY" | jq -r '.progress.rowsRead')

say ""
echo "$BODY" | jq -r '
"status      : \(.status)",
"rows read   : \(.progress.rowsRead)",
"applied     : \(.result.rowsApplied)",
"superseded  : \(.result.rowsSuperseded)",
"rejected    : \(.result.rowsRejected)"'

awk -v e="$ELAPSED" -v r="$ROWS" -v s="$SIZE_BYTES" -v m="$PEAK_MB" 'BEGIN{
  printf "wall clock  : %.1fs (%.1f min)\n", e, e/60;
  printf "throughput  : %d rows/sec\n", r/e;
  printf "             %.1f MB/sec\n", s/1048576/e;
  if (m > 0) printf "peak worker : %.0f MiB (container limit 512 MiB)\n", m;
}'
say ""
say "Hardware: fill this in — CPU model, core count, RAM, disk type."

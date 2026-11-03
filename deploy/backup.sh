#!/usr/bin/env bash
# Sentinel-SLA v2.0.0 — backup (Postgres dump OR SQLite snapshot + data + config).
#
#   deploy/backup.sh [-o OUTDIR]
#
# Contents of every backup tarball (top dir: sentinel-backup/):
#   db.custom.db          SQLite snapshot (python3 stdlib backup API — safe
#                         while the engine writes) OR db.dump (pg_dump -Fc)
#   data/                 generated artefacts (report archive), run/ excluded
#   .env                  configuration (mode 600 preserved by tar)
#   manifest.txt          timestamp, product version, db kind, sizes
#   SHA256SUMS            checksums of the above — restore.sh verifies them
#                         (tamper-evidence pairs with the report SHA-256 block)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
sentinel_load_env "$ROOT/.env"
cd "$ROOT"

OUTDIR="${OUTDIR:-$ROOT/backups}"
while getopts "o:" opt; do case "$opt" in o) OUTDIR="$OPTARG" ;; *) exit 2 ;; esac; done
mkdir -p "$OUTDIR"

DB_KIND="$(sentinel_db_kind "$ROOT")"
[[ "$DB_KIND" == "unknown" ]] && { echo "FAIL: DATABASE_URL unset or unsupported ($DATABASE_URL)" >&2; exit 1; }
VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
DATA_DIR="${SENTINEL_DATA_DIR:-$ROOT/data}"

STAGE="$(mktemp -d "$ROOT/data/run/backup.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/sentinel-backup/data"

# ── database ─────────────────────────────────────────────────────────────────
case "$DB_KIND" in
  sqlite)
    DB_FILE="$(sentinel_db_file "$ROOT")"
    [[ -f "$DB_FILE" ]] || { echo "FAIL: database not found at $DB_FILE" >&2; exit 1; }
    # The sqlite3 CLI is not a dependency; python3's stdlib backup API copies
    # a consistent snapshot even while the engine holds the DB open.
    python3 - "$DB_FILE" "$STAGE/sentinel-backup/db.custom.db" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
with sqlite3.connect(src) as a, sqlite3.connect(dst) as b:
    a.backup(b)
PY
    ;;
  postgres)
    # Production path: pg_dump runs inside the compose postgres container.
    command -v docker >/dev/null 2>&1 || { echo "FAIL: docker required for Postgres backup" >&2; exit 1; }
    ( cd deploy && docker compose exec -T postgres pg_dump -Fc -U sentinel sentinel \
        > "$STAGE/sentinel-backup/db.dump" ) \
      || { echo "FAIL: pg_dump via docker compose failed" >&2; exit 1; }
    ;;
esac

# ── data dir (report archive; skip runtime pid/log dir) ──────────────────────
if [[ -d "$DATA_DIR" ]]; then
  ( cd "$DATA_DIR" && tar cf - --exclude='./run' . ) \
    | tar xf - -C "$STAGE/sentinel-backup/data"
fi

# ── config ───────────────────────────────────────────────────────────────────
[[ -f .env ]] && cp -p .env "$STAGE/sentinel-backup/.env"

# ── manifest + checksums ─────────────────────────────────────────────────────
cat > "$STAGE/sentinel-backup/manifest.txt" <<MAN
created_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
product=Sentinel-SLA
version=$VERSION
db_kind=$DB_KIND
mode=${SENTINEL_MODE:-unknown}
data_dir_bytes=$(du -sb "$STAGE/sentinel-backup/data" | awk '{print $1}')
MAN
( cd "$STAGE/sentinel-backup" && find . -type f ! -name SHA256SUMS -print0 \
    | sort -z | xargs -0 sha256sum > SHA256SUMS )

# ── tarball ──────────────────────────────────────────────────────────────────
TS="$(date -u '+%Y%m%dT%H%M%SZ')"
TARBALL="$OUTDIR/sentinel-backup-$TS.tar.gz"
tar czf "$TARBALL" -C "$STAGE" sentinel-backup
SUM="$(sha256sum "$TARBALL" | awk '{print $1}')"
echo "backup written: $TARBALL"
echo "sha256: $SUM"
echo "db kind: $DB_KIND · version: $VERSION"

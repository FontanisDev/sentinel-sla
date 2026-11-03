#!/usr/bin/env bash
# Sentinel-SLA v2.0.0 — restore a backup produced by deploy/backup.sh.
#
#   deploy/restore.sh <backup.tar.gz> [--force]
#
# Safety model:
#   1. verifies every SHA256SUMS entry before touching the target
#   2. refuses to overwrite an existing database/.env unless --force
#   3. restores into the release tree in place; data/run (pid/log dir) is kept
# After restore, start the stack the way install.sh does:
#   ( cd .. && bun run start )        # demo, single process
#   deploy/upgrade.sh --start-only    # or let upgrade.sh manage a full cycle
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

TARBALL="${1:-}"; FORCE="${2:-}"
[[ -f "$TARBALL" ]] || { echo "usage: deploy/restore.sh <backup.tar.gz> [--force]" >&2; exit 2; }
[[ -n "$FORCE" && "$FORCE" != "--force" ]] && { echo "unknown option: $FORCE" >&2; exit 2; }

sentinel_load_env "$ROOT/.env" 2>/dev/null || true

STAGE="$(mktemp -d "$ROOT/data/run/restore.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# ── 1. extract + verify checksums BEFORE touching anything ──────────────────
tar xzf "$TARBALL" -C "$STAGE"
B="$STAGE/sentinel-backup"
[[ -f "$B/SHA256SUMS" ]] || { echo "FAIL: backup has no SHA256SUMS (not a sentinel backup?)" >&2; exit 1; }
( cd "$B" && sha256sum --quiet --check SHA256SUMS ) \
  || { echo "FAIL: checksum verification failed — backup is corrupt or tampered with" >&2; exit 1; }
echo "checksums verified ($(wc -l < "$B/SHA256SUMS") files)"

DB_KIND="$(sed -n 's/^db_kind=//p' "$B/manifest.txt" 2>/dev/null || true)"
[[ -z "$DB_KIND" ]] && DB_KIND="$( [[ -f "$B/db.dump" ]] && echo postgres || echo sqlite )"

# ── 2. guard the target ──────────────────────────────────────────────────────
DB_FILE="$(sentinel_db_file "$ROOT")"
if [[ "$DB_KIND" == "sqlite" && -z "$DB_FILE" ]]; then
  echo "FAIL: target .env is missing or DATABASE_URL is not sqlite" >&2; exit 1
fi
if [[ -e "$DB_FILE" || -f "$ROOT/.env" ]]; then
  if [[ "$FORCE" != "--force" ]]; then
    echo "FAIL: target not clean ($([[ -e "$DB_FILE" ]] && echo db || echo .env) exists) — pass --force to overwrite" >&2
    exit 1
  fi
  echo "--force: removing existing state (db + .env) before restore"
  rm -f "$DB_FILE" "$ROOT/.env"
fi

# ── 3. restore ───────────────────────────────────────────────────────────────
mkdir -p "$ROOT/prisma" "$ROOT/db"
if [[ "$DB_KIND" == "sqlite" ]]; then
  cp "$B/db.custom.db" "$DB_FILE"
  echo "database restored → $DB_FILE ($(du -h "$DB_FILE" | awk '{print $1}'))"
else
  command -v docker >/dev/null 2>&1 || { echo "FAIL: docker required to restore a Postgres dump" >&2; exit 1; }
  ( cd deploy && docker compose exec -T postgres pg_restore -U sentinel -d sentinel --clean --if-exists --no-owner < "$B/db.dump" ) \
    || { echo "FAIL: pg_restore failed" >&2; exit 1; }
  echo "database restored via pg_restore"
fi

if [[ -d "$B/data" ]]; then
  DATA_DIR="${SENTINEL_DATA_DIR:-$ROOT/data}"
  mkdir -p "$DATA_DIR"
  ( cd "$B/data" && tar cf - . ) | tar xf - -C "$DATA_DIR"
  echo "data dir restored → $DATA_DIR"
fi

if [[ -f "$B/.env" ]]; then
  cp -p "$B/.env" "$ROOT/.env"
  chmod 600 "$ROOT/.env"
  echo ".env restored (mode 600)"
fi

echo
echo "restore complete — start the stack:"
echo "  cd $ROOT && bun run start          # demo (single process)"
echo "  # live: also start the worker (see deploy/lib.sh sentinel_start_worker)"

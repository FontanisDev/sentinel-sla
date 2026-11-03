#!/usr/bin/env bash
# Sentinel-SLA v2.0.0 — upgrade in place (backup → migrate → restart → health,
# with automatic rollback to the pre-upgrade backup on any failure).
#
#   deploy/upgrade.sh [--start-only]
#
# Native path (bun): pulls new deps if the lockfile moved, pushes the schema
# (additive prisma db push), rebuilds the standalone, restarts, waits for
# health. If any step fails the just-created backup is restored and the stack
# is restarted on the previous state — the loop never exits broken silently.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
sentinel_load_env "$ROOT/.env"
cd "$ROOT"

START_ONLY="${1:-}"
PORT="${PORT:-3000}"
log() { printf '\033[1;36m[sentinel-upgrade]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[sentinel-upgrade] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

stack_restart() {
  log "restarting the stack"
  sentinel_stop_stack "$ROOT"
  sentinel_start_web "$ROOT"
  [[ "${SENTINEL_MODE:-demo}" == "live" ]] && sentinel_start_worker "$ROOT"
  sentinel_wait_health "$PORT" 180 || fail "health check failed after restart — see data/run/web.log"
  log "healthy on :$PORT"
}

if [[ "$START_ONLY" == "--start-only" ]]; then
  stack_restart
  exit 0
fi

[[ -f .env ]] || fail "no .env — run deploy/install.sh first (this is not a fresh-install tool)"

# ── 1. backup (the rollback anchor) ──────────────────────────────────────────
log "step 1/4 — pre-upgrade backup"
BACKUP_TAR="$(bash "$(dirname "$0")/backup.sh" | sed -n 's/^backup written: //p')"
[[ -f "$BACKUP_TAR" ]] || fail "backup did not produce a tarball"
log "rollback anchor: $BACKUP_TAR"

rollback() {
  printf '\033[1;31m[sentinel-upgrade] FAIL:\033[0m %s\n' "$1" >&2
  log "rolling back to the pre-upgrade backup"
  bash "$(dirname "$0")/restore.sh" "$BACKUP_TAR" --force || true
  stack_restart || true
  exit 1
}

# ── 2. deps + schema ─────────────────────────────────────────────────────────
log "step 2/4 — dependencies + schema migration"
bun install --frozen-lockfile || rollback "bun install failed"
mkdir -p db data
bun x prisma db push || rollback "schema migration failed"

# ── 3. rebuild ───────────────────────────────────────────────────────────────
log "step 3/4 — rebuild standalone bundle"
bun run build || rollback "build failed"

# ── 4. restart + verify ──────────────────────────────────────────────────────
log "step 4/4 — restart + health"
stack_restart

cat <<EOF

════════════════════════════════════════════════════════════════════
  Upgrade complete. Backup kept for audit: $BACKUP_TAR
════════════════════════════════════════════════════════════════════
EOF

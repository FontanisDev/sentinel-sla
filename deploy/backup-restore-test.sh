#!/usr/bin/env bash
# Sentinel-SLA v2.0.0 — backup/restore clean-restore comparison test.
#
#   deploy/backup-restore-test.sh <install-root> [port]
#
# This is the substance of journey 10 ("Backup, destroy, restore: the data and
# the numbers are identical"), run against a SEPARATE scratch install created
# by deploy/install.sh (never the operator's live instance — the script
# refuses to run inside a git worktree for exactly that reason).
#
# Sequence:
#   1. fresh schema push + deterministic seed (tenant, service, incident,
#      alert, rule, window, owner, membership, integration setting)
#   2. boot the stack, let the engine tick, stop it (freeze the numbers)
#   3. snapshot A: every table's row count + .env hash + data-dir manifest
#   4. deploy/backup.sh
#   5. DESTROY: db, .env and the data dir are deleted (clean-machine state)
#   6. deploy/restore.sh <backup> --force
#   7. snapshot B, compared byte-for-byte against A — identical ⇒ PASS
set -euo pipefail

ROOT_OF_TEST="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

INSTALL="${1:-}"
PORT="${2:-3000}"
[[ -d "$INSTALL" ]] || { echo "usage: deploy/backup-restore-test.sh <install-root> [port]" >&2; exit 2; }
INSTALL="$(cd "$INSTALL" && pwd)"

# Guard: never run against the developer checkout / a live operator install.
# The install dir itself must not be a git repo root (a scratch install nested
# INSIDE a worktree is fine — rev-parse walks up, so compare the toplevel).
GIT_TOP="$(git -C "$INSTALL" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -n "$GIT_TOP" && "$GIT_TOP" == "$INSTALL" ]]; then
  echo "FAIL: refusing to run against a git worktree root ($INSTALL)." >&2
  echo "      Create a scratch install first: SENTINEL_NONINTERACTIVE=1 deploy/install.sh (see docs/OPERATIONS.md)." >&2
  exit 2
fi
[[ -f "$INSTALL/.env" && -d "$INSTALL/deploy" ]] || { echo "FAIL: $INSTALL is not a completed install (no .env/deploy)" >&2; exit 2; }

log() { printf '\033[1;36m[sentinel-brtest]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[sentinel-brtest] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

export PORT
sentinel_load_env "$INSTALL/.env"
export SENTINEL_MODE=demo DATABASE_URL

# ── 1. fresh schema + deterministic seed ─────────────────────────────────────
log "fresh schema push + deterministic seed"
( cd "$INSTALL" && bun x prisma db push ) || fail "schema push failed"
sentinel_prisma_eval "$INSTALL" '
  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient();
  await db.auditLog.deleteMany(); await db.membership.deleteMany();
  await db.session.deleteMany(); await db.apiToken.deleteMany();
  await db.alert.deleteMany(); await db.incident.deleteMany();
  await db.alertRule.deleteMany(); await db.maintenanceWindow.deleteMany();
  await db.service.deleteMany(); await db.tenant.deleteMany();
  await db.user.deleteMany(); await db.integrationSetting.deleteMany();
  const t = await db.tenant.create({ data: { key: "brtest-bank", name: "BRTest Bank" } });
  const s = await db.service.create({ data: {
    key: "brtest-payment", name: "Payment Gateway", tenantId: t.id,
    endpoint: "http://localhost:9900/health", tps: 120, avgTransactionValue: 310000,
    penaltyBase: 60000000, penaltyPerMinute: 8000000,
  } });
  const i = await db.incident.create({ data: {
    serviceId: s.id, status: "resolved", severity: "critical", source: "chaos",
    startedAt: new Date(Date.now() - 3600_000), detectedAt: new Date(Date.now() - 3540_000),
    resolvedAt: new Date(Date.now() - 3000_000), mttdSec: 60, mttrSec: 600,
    lostTransactions: 4200, revenueLossTomans: 1302000000, penaltyTomans: 8000000,
    events: JSON.stringify([{ ts: new Date().toISOString(), event: "opened", detail: "brtest seed" }]),
  } });
  await db.alert.create({ data: { incidentId: i.id, serviceId: s.id, channel: "telegram",
    audience: "technical", severity: "critical", title: "BRTest outage", message: "seed", status: "delivered" } });
  await db.alertRule.create({ data: { name: "brtest-rule", serviceId: s.id, metric: "uptime",
    operator: "lt", threshold: 0.99, severity: "critical" } });
  await db.maintenanceWindow.create({ data: { serviceId: s.id, reason: "BRTest window",
    startAt: new Date(Date.now() + 86_400_000), endAt: new Date(Date.now() + 90_000_000) } });
  await db.user.create({ data: { email: "owner@brtest.ir", name: "BRTest Owner",
    passwordHash: "argon2$brtest-placeholder", role: "owner" } });
  await db.integrationSetting.create({ data: { key: "brtest-marker", value: "\"v1\"", updatedBy: "brtest" } });
  await db.$disconnect();
'
log "seed complete"

# ── 2. boot, tick, freeze ────────────────────────────────────────────────────
sentinel_stop_stack "$INSTALL"
sentinel_start_web "$INSTALL"
sentinel_wait_health "$PORT" 180 || fail "stack did not become healthy on :$PORT"
log "engine ticking for 15 s (realistic live state)"
sleep 15
sentinel_stop_stack "$INSTALL"
sleep 1

# ── 3. snapshot A ────────────────────────────────────────────────────────────
snapshot() { # prints counts + .env sha + data manifest (data/run excluded)
  sentinel_prisma_eval "$INSTALL" '
    const { PrismaClient } = require("@prisma/client");
    const db = new PrismaClient();
    const models = ["tenant","service","selfTestRun","incident","integrationEvent",
      "integrationSetting","alert","chaosExperiment","metricSnapshot","slaReport",
      "maintenanceWindow","alertRule","notificationChannel","notificationOutbox",
      "deliveryLog","onCallEntry","escalationPolicy","reportSchedule","scheduleRun",
      "user","session","apiToken","membership","auditLog"];
    const lines = [];
    for (const m of models) lines.push(m + "=" + await db[m].count());
    console.log(lines.join("\n"));
    await db.$disconnect();
  '
  sha256sum "$INSTALL/.env" | awk '{print "env=" $1}'
  ( cd "${SENTINEL_DATA_DIR:-$INSTALL/data}" && find . -path ./run -prune -o -type f -print0 \
      | sort -z | xargs -0 sha256sum 2>/dev/null || true )
}
snapshot > "$INSTALL/brtest-A.txt"
log "snapshot A: $(grep -c '=' "$INSTALL/brtest-A.txt") lines, incidents=$(grep '^incident=' "$INSTALL/brtest-A.txt" | cut -d= -f2)"

# ── 4. backup ────────────────────────────────────────────────────────────────
log "backup"
BACKUP_OUT="$(bash "$INSTALL/deploy/backup.sh")"
BACKUP_TAR="$(printf '%s\n' "$BACKUP_OUT" | sed -n 's/^backup written: //p')"
[[ -f "$BACKUP_TAR" ]] || fail "backup produced no tarball"
log "backup: $(basename "$BACKUP_TAR") ($(du -h "$BACKUP_TAR" | awk '{print $1}'))"

# ── 5. destroy (clean-machine state) ─────────────────────────────────────────
log "DESTROY: removing db, .env and data artefacts"
DB_FILE="$(sentinel_db_file "$INSTALL")"
rm -f "$DB_FILE" "$INSTALL/.env"
find "${SENTINEL_DATA_DIR:-$INSTALL/data}" -mindepth 1 -maxdepth 1 ! -name run -exec rm -rf {} +

# ── 6. restore ───────────────────────────────────────────────────────────────
log "restore --force"
bash "$INSTALL/deploy/restore.sh" "$BACKUP_TAR" --force

# ── 7. snapshot B + comparison ───────────────────────────────────────────────
snapshot > "$INSTALL/brtest-B.txt"
if diff -u "$INSTALL/brtest-A.txt" "$INSTALL/brtest-B.txt" > "$INSTALL/brtest.diff"; then
  log "PASS — all counts, .env hash and data-dir checksums are IDENTICAL after destroy+restore"
  rm -f "$INSTALL/brtest-A.txt" "$INSTALL/brtest-B.txt" "$INSTALL/brtest.diff"
  exit 0
else
  fail "snapshot mismatch — see $INSTALL/brtest.diff"
fi

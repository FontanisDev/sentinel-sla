#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# Sentinel-SLA — sentinel-doctor: diagnostic bundle for remote help
# (support tooling).
#
#   ./deploy/doctor.sh              # writes doctor/sentinel-doctor-<ts>.txt
#   PORT=3000 ./deploy/doctor.sh    # probe a non-default port
#
# Collects NON-SECRET state only, redacted by construction — it NEVER prints:
#   .env values (only WHICH keys exist), bot/API tokens, session/token tables'
#   contents (counts only), database rows, report PDFs, backups' contents.
# The file is meant to be attached to a support request. SUPPORT.md's redaction
# rule ("never send .env or the database") is honoured by design.
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
# Load .env into THIS process's memory (values are used to resolve paths only
# and are never echoed). DATABASE_URL from .env wins over ambient exports —
# same rule as install/upgrade (lib.sh).
sentinel_load_env .env || true
PORT="${PORT:-3000}"

OUT_DIR="$ROOT/doctor"
mkdir -p "$OUT_DIR"
TS="$(date -u '+%Y%m%d-%H%M%S')"
OUT="$OUT_DIR/sentinel-doctor-$TS.txt"

emit()  { printf '%s\n' "$*"; }
section() { emit ""; emit "════ $* ════"; }
best()  { # best-effort: never aborts the bundle
  local label="$1"; shift
  if out="$("$@" 2>&1)"; then printf '%s\n' "$out"; else emit "  [unavailable: $label]"; fi
}

VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version' 2>/dev/null || echo '?')"
DB_KIND="$(sentinel_db_kind "$ROOT" 2>/dev/null || echo unknown)"

{
emit "Sentinel-SLA sentinel-doctor v${VERSION} — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
emit "Redacted by construction: no .env values, no tokens, no row contents — counts and health only."
section "host"
best "os"      sh -c 'uname -srm; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || true'
best "host"    sh -c 'hostname; whoami; uptime 2>/dev/null || true'
best "disk"    sh -c 'df -h . | tail -1; du -sh "$ROOT/data" 2>/dev/null || true'
best "tools"   sh -c 'bun --version 2>/dev/null; python3 --version 2>/dev/null; command -v curl >/dev/null && echo curl-ok'

section "runtime configuration (keys only — values redacted)"
if [[ -f "$ROOT/.env" ]]; then
  emit "  .env present; keys set:"
  grep -oE '^[A-Z][A-Z0-9_]*' "$ROOT/.env" | sed 's/^/    /'
  # non-secret operational values only
  for k in SENTINEL_MODE SENTINEL_ROLE PORT; do
    v="$(grep -E "^${k}=" "$ROOT/.env" | head -1 | cut -d= -f2-)"
    [[ -n "$v" ]] && emit "  ${k}=${v}"
  done
  case "$(grep -E '^DATABASE_URL=' "$ROOT/.env" | head -1)" in
    *file:*) emit "  database engine: sqlite (path redacted)" ;;
    *postgres*) emit "  database engine: postgres (host redacted)" ;;
    *) emit "  database engine: unknown" ;;
  esac
else
  emit "  [no .env — not installed here?]"
fi

section "processes"
RUN="$(sentinel_run_dir "$ROOT")"
for p in web worker; do
  if [[ -f "$RUN/$p.pid" ]]; then
    pid="$(cat "$RUN/$p.pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      emit "  $p: RUNNING (pid $pid, started $(ps -o lstart= -p "$pid" 2>/dev/null || echo '?'))"
    else
      emit "  $p: pid file exists ($pid) but the process is NOT running"
    fi
  else
    emit "  $p: no pid file under ${RUN#"$ROOT"/} (demo mode has no worker; run-dir may be elsewhere)"
  fi
done
best "listener" sh -c "curl -fsS -o /dev/null -w '  port ${PORT}: HTTP %{http_code}\n' --max-time 3 http://localhost:${PORT}/api/health/live || echo '  port ${PORT}: no answer'"

section "health endpoints (verbatim)"
best "live"  sh -c "curl -fsS --max-time 3 http://localhost:${PORT}/api/health/live  || true"
emit ""
best "ready" sh -c "curl -fsS --max-time 5 http://localhost:${PORT}/api/health/ready || true"

section "recent engine log (last 40 lines, [sentinel] lines only)"
if [[ -f "$RUN/web.log" ]]; then
  grep '\[sentinel\]' "$RUN/web.log" | tail -40 | sed 's/^/  /' || emit "  [no [sentinel] lines yet]"
else
  emit "  [no web.log under ${RUN#"$ROOT"/}]"
fi
if [[ -f "$RUN/worker.log" ]]; then
  emit "  ── worker ──"
  grep '\[sentinel\]' "$RUN/worker.log" | tail -20 | sed 's/^/  /' || true
fi

section "database ($DB_KIND — aggregate counts only, never rows)"
if [[ "$DB_KIND" == "sqlite" ]]; then
  DB_FILE="$(sentinel_db_file "$ROOT")"
  if [[ -n "$DB_FILE" && -f "$DB_FILE" ]]; then
    emit "  db file size: $(du -h "$DB_FILE" | cut -f1)"
    best "counts" python3 - "$DB_FILE" <<'PY'
import sqlite3, sys
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
tables = ["Tenant","Service","Incident","Alert","User","Session","ApiToken","Membership",
          "NotificationChannel","NotificationOutbox","MaintenanceWindow","SlaReport",
          "IntegrationSetting","ReportSchedule","OnCallEntry","AuditLog"]
for t in tables:
    try:
        n = con.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
        extra = ""
        if t == "NotificationOutbox":
            # status names mirror src/server/notify/outbox.ts (open = pending/delivering)
            pend = con.execute("SELECT COUNT(*) FROM \"NotificationOutbox\" WHERE status IN ('pending','delivering')").fetchone()[0]
            dead = con.execute("SELECT COUNT(*) FROM \"NotificationOutbox\" WHERE status = 'dead'").fetchone()[0]
            extra = f" (pending/queued: {pend}, dead: {dead})"
        if t == "Incident":
            open_ = con.execute('SELECT COUNT(*) FROM "Incident" WHERE resolvedAt IS NULL').fetchone()[0]
            extra = f" (open: {open_})"
        print(f"  {t}: {n}{extra}")
    except Exception as e:
        print(f"  {t}: unavailable ({type(e).__name__})")
PY
  else
    emit "  [sqlite db file not found]"
  fi
else
  emit "  postgres counts need the compose container (docker) — best effort:"
  best "pg-counts" sh -c 'docker compose -f '"$ROOT"'/deploy/docker-compose.yml exec -T postgres psql -U postgres -d sentinel -tAc "SELECT '\''incidents: '\''||count(*) FROM \"Incident\"" 2>/dev/null || echo "  [unavailable: no docker daemon (D3) — run on the deploy host]"'
fi

section "backups (names only — contents never inspected)"
if [[ -d "$ROOT/backups" ]]; then
  ls -1 "$ROOT/backups" 2>/dev/null | tail -10 | sed 's/^/  /'
else
  emit "  [no backups/ directory yet — see docs/OPERATIONS.md]"
fi

section "what to send to support"
emit "  Attach THIS file. It contains health JSON, aggregate counts, config key"
emit "  names and recent engine log lines — no secrets by construction. Never"
emit "  attach .env, the database, or report PDFs (docs/SUPPORT.md redaction rule)."
} > "$OUT"

SUM="$(sha256sum "$OUT" | cut -d' ' -f1)"
echo "sentinel-doctor bundle written: ${OUT#"$ROOT"/}"
echo "  sha256: $SUM"
echo "  size:   $(du -h "$OUT" | cut -f1)"

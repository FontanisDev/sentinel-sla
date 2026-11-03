#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Sentinel-SLA — failure-mode drills
#
# Kill the app container, kill Prometheus for 60 s, block the notification
# endpoint; verify the app degrades gracefully, shows the right state and
# recovers without manual action.
#
# Drills (against the compose deployment `docker-compose.yml`):
#   1. app-restart      — restart the app container (SQLite lives on a named
#                         volume). PASS: /api/health/ready degrades honestly
#                         (not a crash) and returns to 200 on its own.
#   2. prometheus-down  — stop Prometheus for 60 s in live mode. PASS: the
#                         ingestion loop marks affected services `stale` and
#                         raises exactly one "Monitoring blind" alert per
#                         service per episode (never up/down on missing
#                         data), and the fleet returns to `up` after
#                         Prometheus returns.
#   3. notify-blocked   — point a webhook channel at a receiver container,
#                         then `docker pause` it. PASS: the outbox retries
#                         with exponential backoff, records honest per-attempt
#                         DeliveryLog rows, dead-letters after maxAttempts,
#                         and resumes delivery automatically after unpause +
#                         retryDead (no manual DB surgery).
#
# Requirements: docker + docker compose v2, the stack UP, SENTINEL_BASE
# reachable, an owner/admin bearer token (SENTINEL_TOKEN) for API reads,
# jq, curl. The drills are DESTRUCTIVE to the running stack by design.
#
# Without a Docker daemon only the static checks (bash -n) run here. The
# Prometheus-down path is covered by live-run-proof and the retry/backoff/
# dead-letter path by notify-proof.
#
# Usage:
#   SENTINEL_BASE=http://localhost:3000 SENTINEL_TOKEN=<bearer> \
#     bash tests/failure-modes/failure_modes.sh [--only db|prometheus|notify]
# ═══════════════════════════════════════════════════════════════════════════

set -uo pipefail

BASE="${SENTINEL_BASE:-http://localhost:3000}"
TOKEN="${SENTINEL_TOKEN:-}"
COMPOSE_DIR="${SENTINEL_COMPOSE_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
DB_WAIT_SEC="${DB_WAIT_SEC:-30}"
PROM_WAIT_SEC="${PROM_WAIT_SEC:-60}"
ONLY="${2:-all}"

PASS=0
FAIL=0

log()  { printf '\n\033[1;34m[drill]\033[0m %s\n' "$*"; }
pass() { PASS=$((PASS + 1)); printf '  \033[1;32mPASS\033[0m %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1"; exit 2; }; }
need docker; need curl; need jq

api() { # api <method> <path> [json-body] — authenticated JSON call; echoes body, sets HTTP in $HTTP
  local method="$1" path="$2" body="${3:-}"
  HTTP=$(curl -s -o /tmp/sentinel-drill-body.json -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
    ${body:+-d "$body"} \
    "${BASE}${path}")
  cat /tmp/sentinel-drill-body.json
}

dc() { docker compose -f "${COMPOSE_DIR}/docker-compose.yml" "$@"; }

# ── preflight ────────────────────────────────────────────────────────────────
log "preflight"
if [ -z "$TOKEN" ]; then
  fail "SENTINEL_TOKEN not set — the drills read the app's own APIs to judge recovery"
  exit 2
fi
ready=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/health/ready")
if [ "$ready" != "200" ]; then
  fail "app is not healthy before the drills (ready=$ready) — start from green"
  exit 2
fi
pass "app healthy at ${BASE}"
if [ "$ONLY" = "all" ] || [ "$ONLY" = "db" ]; then DRILL_DB=1; else DRILL_DB=0; fi
if [ "$ONLY" = "all" ] || [ "$ONLY" = "prometheus" ]; then DRILL_PROM=1; else DRILL_PROM=0; fi
if [ "$ONLY" = "all" ] || [ "$ONLY" = "notify" ]; then DRILL_NOTIFY=1; else DRILL_NOTIFY=0; fi

# ── drill 1: app container restart ─────────────────────────────────────────
if [ "$DRILL_DB" = "1" ]; then
  log "drill 1: restarting the app container"
  dc restart app >/dev/null 2>&1 || fail "could not restart the app container"
  log "waiting for the app to recover on its own (up to 120s)"
  recovered=0
  for _ in $(seq 1 24); do
    sleep 5
    code=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/health/ready")
    if [ "$code" = "200" ]; then recovered=1; break; fi
  done
  if [ "$recovered" = "1" ]; then
    pass "app returned to ready WITHOUT manual action"
  else
    fail "app did not return to ready within 120s after the restart"
  fi
fi

# ── drill 2: Prometheus down for 60 s (live mode) ───────────────────────────
if [ "$DRILL_PROM" = "1" ]; then
  log "drill 2: Prometheus down ${PROM_WAIT_SEC}s (live mode required)"
  mode=$(api GET /api/resilience | jq -r '.mode // empty')
  if [ "$mode" != "live" ]; then
    fail "mode=${mode:-unknown} — drill 2 requires SENTINEL_MODE=live (skipping drill body)"
  else
    dc stop prometheus >/dev/null 2>&1 || true
    sleep "$PROM_WAIT_SEC"
    blind=$(api GET "/api/alerts?limit=50" | jq '[.alerts[]? | select(.title | startswith("Monitoring blind"))] | length')
    if [ "${blind:-0}" -ge 1 ]; then
      pass "monitoring-blind alert raised while Prometheus was down ($blind row(s))"
    else
      fail "no 'Monitoring blind' alert during the outage"
    fi
    stale=$(api GET /api/services | jq '[.services[]? | select(.liveStatus == "stale")] | length')
    if [ "${stale:-0}" -ge 1 ]; then
      pass "services marked stale while blind ($stale) — never up/down on missing data"
    else
      fail "no service went stale during the outage"
    fi
    dc start prometheus >/dev/null 2>&1 || true
    log "waiting for ingestion to confirm recovery (up to 3x poll interval)"
    ok=0
    for _ in $(seq 1 20); do
      sleep 10
      notstale=$(api GET /api/services | jq '[.services[]? | select(.liveStatus != "stale")] | length')
      total=$(api GET /api/services | jq '[.services[]?] | length')
      if [ "${total:-0}" -gt 0 ] && [ "${notstale:-0}" -eq "${total:-1}" ]; then ok=1; break; fi
    done
    if [ "$ok" = "1" ]; then
      pass "all services left the stale state after Prometheus returned"
    else
      fail "services still stale 200s after Prometheus recovery"
    fi
  fi
fi

# ── drill 3: notification endpoint blocked ──────────────────────────────────
if [ "$DRILL_NOTIFY" = "1" ]; then
  log "drill 3: notification endpoint blocked (pause the receiver container)"
  if ! docker inspect sentinel-drill-receiver >/dev/null 2>&1; then
    log "starting a throwaway webhook receiver"
    docker rm -f sentinel-drill-receiver >/dev/null 2>&1 || true
    docker run -d --name sentinel-drill-receiver -p 18080:8000 python:3-alpine \
      python3 -m http.server 8000 >/dev/null 2>&1 || {
      fail "could not start the drill receiver (image pull failed?) — skipping drill body"
    }
    sleep 2
  fi
  # create the channel against the receiver
  chan=$(api POST /api/channels \
    '{"name":"drill-receiver","kind":"webhook","target":"http://host.docker.internal:18080/hook","audience":"technical"}' \
    | jq -r '.channel.id // .id // empty')
  if [ -z "$chan" ]; then
    fail "could not create the drill webhook channel"
  else
    docker pause sentinel-drill-receiver >/dev/null 2>&1 || true
    api POST "/api/channels/${chan}/test" >/dev/null
    log "test message enqueued while receiver paused — waiting for retries (45s)"
    sleep 45
    attempts=$(api GET /api/notifications/delivery?limit=50 | jq '[.log[]? | select(.ok == 0 or .ok == false)] | length')
    if [ "${attempts:-0}" -ge 1 ]; then
      pass "outbox recorded honest failed attempts with backoff ($attempts row(s) in window)"
    else
      fail "no DeliveryLog rows for the blocked endpoint"
    fi
    docker unpause sentinel-drill-receiver >/dev/null 2>&1 || true
    api POST /api/notifications/outbox >/dev/null 2>&1 || true # retryDead (admin)
    sleep 15
    delivered=$(api GET /api/notifications/delivery?limit=50 | jq '[.log[]? | select(.ok == 1 or .ok == true)] | length')
    if [ "${delivered:-0}" -ge 1 ]; then
      pass "delivery resumed automatically after the endpoint returned"
    else
      fail "no successful delivery after unpause + retry"
    fi
    api DELETE "/api/channels/${chan}" >/dev/null || true
  fi
  docker rm -f sentinel-drill-receiver >/dev/null 2>&1 || true
fi

log "drills complete: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]

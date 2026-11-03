#!/usr/bin/env bash
# Sentinel self-test — run weekly: 0 3 * * 1 root /opt/sentinel/chaos/auto_chaos.sh >> /var/log/sentinel-chaos.log 2>&1
#
# ═══════════════════════════════════════════════════════════════════════════
# Sentinel-SLA (سنتیل-SLA) — automated chaos self-test loop
# Owner: Sentinel-SLA
#
# Iterates over every monitored service in the Sentinel dashboard and runs
# one chaos experiment per service (default type: outage, the worst case).
# Every result is appended to the log; the script exits non-zero if ANY
# experiment fails the MTTD gate — wire that exit code into your monitoring
# (cron mails it, or systemd OnFailure) so a regression is impossible to miss.
#
# Requires: bash, python3 (3.8+, stdlib only). No jq, no curl needed.
# ═══════════════════════════════════════════════════════════════════════════

set -uo pipefail

BASE="${SENTINEL_BASE:-http://localhost:3000}"
CHAOS_TYPE="${SENTINEL_CHAOS_TYPE:-outage}"
GATE="${SENTINEL_CHAOS_GATE:-60}"
DURATION="${SENTINEL_CHAOS_DURATION:-45}"
# v2.0.0: the dashboard/chaos APIs require authentication. Mint a Bearer API
# token once (`bun scripts/mint-loadtest-token.mjs --name chaos`) and export
# SENTINEL_TOKEN for the cron/systemd unit; without it every request gets 401.
TOKEN="${SENTINEL_TOKEN:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPERIMENT="$HERE/chaos_experiment.py"

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

log "=== Sentinel auto-chaos run starting (base=$BASE type=$CHAOS_TYPE gate=${GATE}s) ==="

if ! command -v python3 >/dev/null 2>&1; then
  log "FATAL: python3 not found — the chaos runner requires Python 3.8+."
  exit 2
fi

# Discover the monitored services (keys) from the dashboard API via python3
# (kept stdlib-only and jq-free; one service per line). Sends the Bearer token
# when SENTINEL_TOKEN is set (required on v2.0.0 authenticated apps).
SERVICES="$(SENTINEL_TOKEN="$TOKEN" python3 - "$BASE" <<'PY'
import json, os, sys, urllib.request
base = sys.argv[1].rstrip("/")
headers = {}
token = os.environ.get("SENTINEL_TOKEN", "").strip()
if token:
    headers["Authorization"] = "Bearer %s" % token
try:
    req = urllib.request.Request(base + "/api/dashboard", headers=headers)
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    for svc in data.get("services") or []:
        key = svc.get("key") or svc.get("id")
        if key:
            print(key)
except Exception as exc:  # noqa: BLE001 — report and fail cleanly
    print("auto-chaos: could not list services: %s" % exc, file=sys.stderr)
    sys.exit(2)
PY
)" || {
  log "FATAL: could not discover services from $BASE — is the Sentinel app up, and is SENTINEL_TOKEN set (v2.0.0 requires a Bearer API token)?"
  exit 2
}

if [ -z "$SERVICES" ]; then
  log "FATAL: dashboard at $BASE reports no services."
  exit 2
fi

FAILURES=0
TOTAL=0

while IFS= read -r svc; do
  [ -n "$svc" ] || continue
  TOTAL=$((TOTAL + 1))
  log "--- chaos experiment: service=$svc type=$CHAOS_TYPE duration=${DURATION}s gate=${GATE}s"
  if python3 "$EXPERIMENT" --base "$BASE" --service "$svc" \
      --type "$CHAOS_TYPE" --duration "$DURATION" --gate "$GATE" \
      --token "$TOKEN"; then
    log "PASS: $svc met the MTTD gate (< ${GATE}s)."
  else
    rc=$?
    if [ "$rc" -eq 2 ]; then
      log "ERROR: experiment on $svc could not run (bad target / connection)."
    else
      log "FAIL: $svc missed the MTTD gate (>= ${GATE}s) — detection regression!"
    fi
    FAILURES=$((FAILURES + 1))
  fi
done <<< "$SERVICES"

log "=== auto-chaos run finished: $((TOTAL - FAILURES))/$TOTAL passed, $FAILURES failed ==="

if [ "$FAILURES" -gt 0 ]; then
  log "RESULT: FAIL — $FAILURES service(s) breached the MTTD gate. Action required."
  exit 1
fi

log "RESULT: PASS — all services detected outages within the gate. سنتیل سالم است."
exit 0

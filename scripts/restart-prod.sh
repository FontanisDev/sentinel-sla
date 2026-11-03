#!/usr/bin/env bash
# Sentinel-SLA — restart the production standalone safely (cron-loop runbook).
#
# Round-26 lesson: pkill-by-pattern leaves stale `next-server (v1)` processes
# holding :3001; a new server then logs EADDRINUSE and the OLD build keeps
# serving (in-memory manifests referencing chunks the fresh disk no longer
# has → random 500s on /_next/static chunks and blank pages).
#
# This script kills the LISTENER ON THE PORT (by pid, pattern-independent),
# starts the standalone, and FAILS LOUDLY if the bind was refused or the
# health check does not pass.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-3001}"
LOG="${2:-prod.log}"
HEALTH_PATH="${HEALTH_PATH:-/api/health/live}"
URL="http://localhost:${PORT}${HEALTH_PATH}"

# 1. kill whatever LISTENS on the port (works regardless of argv disguise)
pid=$(ss -tlnp 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p {print $NF}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
if [ -n "${pid:-}" ]; then
  echo "[restart-prod] killing stale listener pid=${pid} on :${PORT}"
  kill "$pid" 2>/dev/null || true
  sleep 2
fi

# 2. start the standalone and verify the bind actually happened
: > "$LOG"
nohup env PORT="$PORT" node .next/standalone/server.js > "$LOG" 2>&1 &
sleep 6
if head -5 "$LOG" | grep -q EADDRINUSE; then
  echo "[restart-prod] FAIL: EADDRINUSE — a listener survived on :${PORT}; inspect ss -tlnp" >&2
  exit 1
fi

# 3. health check
for _ in 1 2 3 4 5; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL" || true)
  if [ "$code" = "200" ]; then
    echo "[restart-prod] OK — :${PORT} healthy ($URL)"
    exit 0
  fi
  sleep 3
done
echo "[restart-prod] FAIL: health never returned 200 on $URL" >&2
tail -20 "$LOG" >&2
exit 1

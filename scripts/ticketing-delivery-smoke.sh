#!/usr/bin/env bash
# Live smoke test for the ticketing/chat delivery kinds (Mattermost, Jira,
# Redmine).
#
# Self-contained: copies the dev DB to a throwaway file, starts three local
# mock receivers (mattermost/jira/redmine), starts a Sentinel server on :3111
# with SENTINEL_NOTIFY_TRANSPORT=real, then drives the REAL channel → outbox →
# dispatcher → adapter journey:
#   1  unauthenticated channel create → 401
#   2  mattermost channel create → 201, settings echoed, secret never echoed
#   3  test-send → delivery log ok:true + mock receiver got text + props
#   4  jira (email:token) → test-send → ref=OPS-771 + Basic auth + project key
#   5  redmine → test-send → ref=#771 + X-Redmine-API-Key + project_id
#   6  jira create WITHOUT settings → 400 (settings refine at the API floor)
#   7  executive jira channel + send-digest-now → NO outbox row for it
#      (ticket systems are for actionable incidents, not digests)
#   8  cleanup deletes the channels; receivers' request logs asserted
#
# Run: bash scripts/ticketing-delivery-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=3111
BASE="http://localhost:${PORT}"
MM_PORT=3191; JIRA_PORT=3192; RM_PORT=3193
SMOKE_DB=/tmp/ticketing-smoke-$$.db
LOG_DIR=/tmp/ticketing-smoke-$$.logs
mkdir -p "$LOG_DIR"
SERVER_PID=""
MM_PID=""; JIRA_PID=""; RM_PID=""

kill_by_port() { # kill whatever holds :$1 (next dev spawns a child server)
  local pids
  pids=$(ss -tlnp 2>/dev/null | awk -v p=":$1" '$4 ~ p {print $NF}' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)
  for p in $pids; do kill "$p" 2>/dev/null || true; done
  return 0
}

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  kill_by_port "$PORT"
  [ -n "$MM_PID" ] && kill "$MM_PID" 2>/dev/null || true
  [ -n "$JIRA_PID" ] && kill "$JIRA_PID" 2>/dev/null || true
  [ -n "$RM_PID" ] && kill "$RM_PID" 2>/dev/null || true
  rm -f "$SMOKE_DB" "$LOG_DIR"/*.log 2>/dev/null || true
  rmdir "$LOG_DIR" 2>/dev/null || true
  bun scripts/mint-loadtest-token.mjs --revoke --name ticketing-smoke >/dev/null 2>&1 || true
  exit 0
}
trap cleanup EXIT

fail() { echo "FAIL: $1"; exit 1; }

# ── mock receivers ──────────────────────────────────────────────────────────
start_mock() { # $1 port  $2 status  $3 body  $4 logfile
  python3 - "$1" "$2" "$3" "$4" <<'PYEOF' >/dev/null 2>&1 &
import http.server, json, sys
port, status, body, logf = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        raw = self.rfile.read(n).decode('utf-8', 'replace')
        with open(logf, 'a', encoding='utf-8') as f:
            f.write(json.dumps({'path': self.path, 'headers': {k.lower(): v for k, v in self.headers.items()}, 'body': raw}) + '\n')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body.encode())
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()
PYEOF
}
start_mock $MM_PORT 200 'ok' "$LOG_DIR/mm.log";            MM_PID=$!
start_mock $JIRA_PORT 201 '{"id":"10001","key":"OPS-771"}' "$LOG_DIR/jira.log"; JIRA_PID=$!
start_mock $RM_PORT 201 '{"issue":{"id":771}}' "$LOG_DIR/rm.log";               RM_PID=$!
sleep 0.6

# ── throwaway DB + server (transport forced REAL for this instance only) ────
cp db/custom.db "$SMOKE_DB"
PORT=$PORT DATABASE_URL="file:$SMOKE_DB" SENTINEL_NOTIFY_TRANSPORT=real \
  nohup bun run dev >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 60); do
  code=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "$BASE/api/health/ready" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && break
  [ "$i" = "60" ] && { tail -5 "$LOG_DIR/server.log"; fail "server never became ready on :$PORT"; }
  sleep 1
done
echo "── server ready on :$PORT (transport=real, throwaway db)"

TOKEN=$(DATABASE_URL="file:$SMOKE_DB" bun scripts/mint-loadtest-token.mjs --name ticketing-smoke --days 1 2>/dev/null | tail -1)
[ -n "$TOKEN" ] || fail "could not mint smoke token"
AUTH="Authorization: Bearer $TOKEN"

# delivery log poller: wait for an ok row of $1 kind for $2 channelId; print ref (or OK)
poll_delivery() {
  for _ in $(seq 1 45); do
    ref=$(curl -s --max-time 10 "$BASE/api/notifications/delivery?limit=40" -H "$AUTH" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
for r in rows:
    if r.get('kind')=='$1' and r.get('channelId')=='$2' and r.get('ok'):
        print(r.get('ref') or 'OK'); break
" 2>/dev/null || true)
    [ -n "${ref:-}" ] && { echo "$ref"; return 0; }
    sleep 1
  done
  echo "── diagnosis: recent delivery rows for $1 channel $2:"
  curl -s --max-time 10 "$BASE/api/notifications/delivery?channelId=$2&limit=10" -H "$AUTH" | python3 -m json.tool | head -30
  return 1
}

# ── 1: unauthenticated → 401 ────────────────────────────────────────────────
code=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" -X POST "$BASE/api/channels" -H 'Content-Type: application/json' -d '{"name":"x","kind":"jira","target":"https://j.example.com"}')
[ "$code" = "401" ] || fail "expected 401 unauthenticated, got $code"
echo "✓ 1/8 unauthenticated channel create → 401"

# ── 2: mattermost channel create (settings echoed, secret never echoed) ─────
body=$(curl -s --max-time 10 -X POST "$BASE/api/channels" -H "$AUTH" -H 'Content-Type: application/json' -d "{
  \"name\":\"MM smoke\", \"kind\":\"mattermost\", \"audience\":\"technical\",
  \"target\":\"http://127.0.0.1:${MM_PORT}/hooks/abc123\",
  \"settings\":{\"channel\":\"ops-alerts\",\"username\":\"Sentinel\"}}")
MM_ID=$(echo "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['id'])")
[ -n "$MM_ID" ] || fail "mattermost create failed: $body"
echo "$body" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assert d['settings']=={'channel':'ops-alerts','username':'Sentinel'}, d['settings']
assert 'secret' not in d or d.get('secret') is None, 'secret echoed!'
print('ok')" >/dev/null || fail "mattermost DTO wrong: $body"
echo "✓ 2/8 mattermost channel created — settings echoed, secret NOT echoed"

# ── 3: mattermost test-send → real dispatch to the mock ─────────────────────
curl -s -o /dev/null -X POST "$BASE/api/channels/$MM_ID/test" -H "$AUTH"
ref=$(poll_delivery mattermost "$MM_ID") || fail "no ok delivery for mattermost"
python3 - "$LOG_DIR/mm.log" <<'PYEOF' || fail "mattermost payload mismatch"
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1], encoding='utf-8')]
assert rows, 'mock receiver saw nothing'
p=json.loads(rows[-1]['body'])
assert 'CRITICAL' in p['text'] or 'Sentinel' in p['text'], p
assert p['channel']=='ops-alerts' and p['username']=='Sentinel', p
assert p['props']['sentinel']['topic']=='test', p
PYEOF
echo "✓ 3/8 mattermost test-send delivered (text + channel/username + sentinel props)"

# ── 4: jira with email:token → Basic, ref = issue key ───────────────────────
body=$(curl -s --max-time 10 -X POST "$BASE/api/channels" -H "$AUTH" -H 'Content-Type: application/json' -d "{
  \"name\":\"Jira smoke\", \"kind\":\"jira\", \"audience\":\"technical\",
  \"target\":\"http://127.0.0.1:${JIRA_PORT}\",
  \"secret\":\"ops@example.com:ATATT-smoke-secret\",
  \"settings\":{\"projectKey\":\"OPS\",\"issueTypeName\":\"Task\"}}")
JIRA_ID=$(echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$JIRA_ID" ] || fail "jira create failed: $body"
curl -s -o /dev/null -X POST "$BASE/api/channels/$JIRA_ID/test" -H "$AUTH"
ref=$(poll_delivery jira "$JIRA_ID") || fail "no ok delivery for jira"
[ "$ref" = "OPS-771" ] || fail "expected ref OPS-771, got '$ref'"
python3 - "$LOG_DIR/jira.log" <<'PYEOF' || fail "jira request mismatch"
import json,sys,base64
rows=[json.loads(l) for l in open(sys.argv[1], encoding='utf-8')]
assert rows, 'jira mock saw nothing'
r=rows[-1]
assert r['path']=='/rest/api/2/issue', r['path']
expected='Basic '+base64.b64encode(b'ops@example.com:ATATT-smoke-secret').decode()
assert r['headers'].get('authorization')==expected, r['headers'].get('authorization')
f=json.loads(r['body'])['fields']
assert f['project']['key']=='OPS' and f['issuetype']['name']=='Task', f
assert 'Sentinel-SLA' in f['description'], f
PYEOF
echo "✓ 4/8 jira issue created through the real dispatcher (Basic auth, ref OPS-771 in the delivery log)"

# ── 5: redmine → API key header, ref = #id ──────────────────────────────────
body=$(curl -s --max-time 10 -X POST "$BASE/api/channels" -H "$AUTH" -H 'Content-Type: application/json' -d "{
  \"name\":\"Redmine smoke\", \"kind\":\"redmine\", \"audience\":\"technical\",
  \"target\":\"http://127.0.0.1:${RM_PORT}\",
  \"secret\":\"redmine-smoke-key-01\",
  \"settings\":{\"projectId\":\"sentinel\"}}")
RM_ID=$(echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$RM_ID" ] || fail "redmine create failed: $body"
curl -s -o /dev/null -X POST "$BASE/api/channels/$RM_ID/test" -H "$AUTH"
ref=$(poll_delivery redmine "$RM_ID") || fail "no ok delivery for redmine"
[ "$ref" = "#771" ] || fail "expected ref #771, got '$ref'"
python3 - "$LOG_DIR/rm.log" <<'PYEOF' || fail "redmine request mismatch"
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1], encoding='utf-8')]
assert rows, 'redmine mock saw nothing'
r=rows[-1]
assert r['path']=='/issues.json', r['path']
assert r['headers'].get('x-redmine-api-key')=='redmine-smoke-key-01', r['headers']
assert json.loads(r['body'])['issue']['project_id']=='sentinel'
PYEOF
echo "✓ 5/8 redmine issue created (X-Redmine-API-Key, ref #771 in the delivery log)"

# ── 6: jira WITHOUT settings → 400 at the API floor ─────────────────────────
code=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" -X POST "$BASE/api/channels" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Jira bad","kind":"jira","target":"http://127.0.0.1:'"$JIRA_PORT"'","secret":"some-secret-1"}')
[ "$code" = "400" ] || fail "expected 400 for jira without settings, got $code"
echo "✓ 6/8 jira channel without settings.projectKey refused (400)"

# ── 7: digest never creates tickets (executive jira channel excluded) ───────
body=$(curl -s --max-time 10 -X POST "$BASE/api/channels" -H "$AUTH" -H 'Content-Type: application/json' -d "{
  \"name\":\"Jira exec\", \"kind\":\"jira\", \"audience\":\"executive\",
  \"target\":\"http://127.0.0.1:${JIRA_PORT}\", \"secret\":\"exec-token-1234567\",
  \"settings\":{\"projectKey\":\"OPS\"}}")
EXEC_ID=$(echo "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$EXEC_ID" ] || fail "executive jira create failed: $body"
curl -s -o /dev/null -X POST "$BASE/api/integrations/digest" -H "$AUTH"
sleep 6  # let the dispatcher drain anything enqueued
outbox_hits=$(curl -s --max-time 10 "$BASE/api/notifications/outbox?limit=100" -H "$AUTH" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
print(sum(1 for r in rows if r.get('channelId')=='$EXEC_ID'))")
[ "$outbox_hits" = "0" ] || fail "digest enqueued $outbox_hits row(s) to the jira channel — exclusion broken"
echo "✓ 7/8 send-digest-now skipped the ticket-system channel (0 outbox rows for it)"

# ── 8: cleanup + final receiver-log sanity ──────────────────────────────────
for id in "$MM_ID" "$JIRA_ID" "$RM_ID" "$EXEC_ID"; do
  code=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" -X DELETE "$BASE/api/channels/$id" -H "$AUTH")
  [ "$code" = "200" ] || fail "channel delete $id → $code"
done
mm_lines=$(wc -l < "$LOG_DIR/mm.log"); jira_lines=$(wc -l < "$LOG_DIR/jira.log"); rm_lines=$(wc -l < "$LOG_DIR/rm.log")
[ "$mm_lines" -ge 1 ] && [ "$jira_lines" -ge 1 ] && [ "$rm_lines" -ge 1 ] || fail "receiver logs empty"
echo "✓ 8/8 cleanup: 4 channels deleted; receiver logs present (mm=$mm_lines jira=$jira_lines redmine=$rm_lines)"

echo ""
echo "ALL 8/8 TICKETING DELIVERY CHECKS PASSED — Mattermost/Jira/Redmine live through the real outbox dispatcher."
exit 0

#!/usr/bin/env bash
# Live smoke test for the Shaparak/PSP tps-profile endpoints (dev :3000):
# 401 unauthenticated → dry-run parses the shipped sample with ZERO writes →
# commit of a broken sheet aborts 422 (all-or-nothing) → clean commit stores
# the profile → service detail reports it active → audit row exists →
# DELETE reverts → second DELETE is an idempotent removed:false. The targeted
# service's original state (no profile) is restored by the final DELETE.
#
# Run: bash scripts/shaparak-import-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SENTINEL_PORT:-3000}"
BASE="http://localhost:${PORT}"

TOKEN=$(bun scripts/mint-loadtest-token.mjs --name shaparak-smoke --days 1 2>/dev/null | tail -1)
trap 'bun scripts/mint-loadtest-token.mjs --revoke --name shaparak-smoke >/dev/null 2>&1' EXIT

fail() { echo "FAIL: $1"; exit 1; }
jqget() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval('d'+sys.argv[1]))" "$1"; }
stored_state() {
  bun -e "const {PrismaClient}=require('@prisma/client'); const db=new PrismaClient(); db.service.findUnique({where:{key:'$1'}, select:{tpsProfile:true}}).then(s=>{console.log(s.tpsProfile===null?'clean':'written'); return db.\$disconnect()})"
}

KEY=$(bun -e "const {PrismaClient}=require('@prisma/client'); const db=new PrismaClient(); db.service.findFirst({where:{tpsProfile:null}, select:{key:true}}).then(s=>{console.log(s.key); return db.\$disconnect()})")
[ -n "$KEY" ] && [ "$KEY" != "None" ] && [ "$KEY" != "null" ] || fail "no service without a profile found"
echo "── target service: $KEY"

AUTH="Authorization: Bearer $TOKEN"
SAMPLE_JSON=/tmp/shaparak-smoke-sample.json
BROKEN_JSON=/tmp/shaparak-smoke-broken.json
COMMIT_JSON=/tmp/shaparak-smoke-commit.json
python3 -c "
import json
csv = open('public/templates/shaparak-tx-counts-sample.csv', encoding='utf-8').read()
json.dump({'csv': csv}, open('$SAMPLE_JSON', 'w'))
broken = 'date,hour,tx_count\n1404/07/07,00:00,100\n1404/07/07,25:00,100'
json.dump({'csv': broken, 'mode': 'commit'}, open('$BROKEN_JSON', 'w'))
"

# 1: unauthenticated → 401
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/services/$KEY/tps-profile" \
  -H 'Content-Type: application/json' -d '{"csv":"x"}')
[ "$code" = "401" ] || fail "expected 401 unauthenticated, got $code"
echo "✓ 1/7 unauthenticated → 401"

# 2: dry-run of the shipped sample → parsed, zero writes
body=$(curl -s -X POST "$BASE/api/services/$KEY/tps-profile" -H "$AUTH" -H 'Content-Type: application/json' \
  --data-binary @"$SAMPLE_JSON")
[ -n "$body" ] || fail "empty dry-run response"
rows=$(echo "$body" | jqget "['rowsUsed']")
committed=$(echo "$body" | jqget "['committed']")
nbuckets=$(echo "$body" | jqget "['buckets']" | python3 -c "import sys; print(len(sys.stdin.read().split(',')))")
[ "$rows" = "168" ] || fail "expected 168 rows parsed, got $rows"
[ "$committed" = "False" ] || fail "dry-run must not commit (committed=$committed)"
[ "$nbuckets" = "168" ] || fail "expected 168 buckets in preview, got $nbuckets"
[ "$(stored_state "$KEY")" = "clean" ] || fail "dry-run wrote to the database"
echo "✓ 2/7 dry-run parsed the Persian/Jalali sample (168 rows, 168 buckets) — zero writes"

# 3: broken sheet commit → 422, all-or-nothing
http=$(curl -s -o "$BROKEN_JSON.resp" -w "%{http_code}" -X POST "$BASE/api/services/$KEY/tps-profile" \
  -H "$AUTH" -H 'Content-Type: application/json' --data-binary @"$BROKEN_JSON")
[ "$http" = "422" ] || fail "expected 422 on broken commit, got $http"
rej=$(jqget "['rowsRejected']" < "$BROKEN_JSON.resp")
[ "$rej" = "1" ] || fail "expected exactly 1 rejected row reported, got $rej"
[ "$(stored_state "$KEY")" = "clean" ] || fail "aborted commit wrote to the database"
echo "✓ 3/7 broken commit → 422, rejection reported by line, nothing written"

# 4: commit the clean sample → profile stored
python3 -c "
import json
csv = open('public/templates/shaparak-tx-counts-sample.csv', encoding='utf-8').read()
json.dump({'csv': csv, 'mode': 'commit'}, open('$COMMIT_JSON', 'w'))
"
http=$(curl -s -o "$SAMPLE_JSON.resp" -w "%{http_code}" -X POST "$BASE/api/services/$KEY/tps-profile" \
  -H "$AUTH" -H 'Content-Type: application/json' --data-binary @"$COMMIT_JSON")
[ "$http" = "200" ] || fail "expected 200 on clean commit, got $http"
committed=$(jqget "['committed']" < "$SAMPLE_JSON.resp")
[ "$committed" = "True" ] || fail "clean commit did not commit"
mean=$(jqget "['meanTps']" < "$SAMPLE_JSON.resp")
peak=$(jqget "['peak']['tps']" < "$SAMPLE_JSON.resp")
echo "   committed profile: meanTps=$mean peakTps=$peak"
valid=$(bun -e "const {PrismaClient}=require('@prisma/client'); const db=new PrismaClient(); db.service.findUnique({where:{key:'$KEY'}, select:{tpsProfile:true}}).then(s=>{const p=JSON.parse(s.tpsProfile); console.log(p.buckets.length===168 && p.tzOffsetMinutes===210 ? 'valid' : 'invalid'); return db.\$disconnect()})")
[ "$valid" = "valid" ] || fail "stored profile invalid"
echo "✓ 4/7 clean commit → profile stored (168 buckets, Tehran offset)"

# 5: service detail reports the profile active
body=$(curl -s -H "$AUTH" "$BASE/api/services/$KEY")
active=$(echo "$body" | jqget "['tpsProfile']['active']")
covered=$(echo "$body" | jqget "['tpsProfile']['coveredBuckets']")
[ "$active" = "True" ] || fail "service detail does not report the profile active"
[ "$covered" = "168" ] || fail "detail coverage expected 168, got $covered"
echo "✓ 5/7 service detail reports the profile active (coverage 168/168)"

# 6: audit trail rows exist
count=$(bun -e "const {PrismaClient}=require('@prisma/client'); const db=new PrismaClient(); db.auditLog.count({where:{action:'service.tps-profile.imported', detail:{contains:'service=$KEY'}}}).then(c=>{console.log(c); return db.\$disconnect()})")
[ "$count" -ge 1 ] || fail "expected at least 1 imported audit row, got $count"
echo "✓ 6/7 audit trail records the import"

# 7: DELETE → removed, second DELETE idempotent
body=$(curl -s -X DELETE "$BASE/api/services/$KEY/tps-profile" -H "$AUTH")
removed=$(echo "$body" | jqget "['removed']")
[ "$removed" = "True" ] || fail "DELETE did not remove (removed=$removed)"
[ "$(stored_state "$KEY")" = "clean" ] || fail "profile still stored after DELETE"
body=$(curl -s -X DELETE "$BASE/api/services/$KEY/tps-profile" -H "$AUTH")
removed=$(echo "$body" | jqget "['removed']")
[ "$removed" = "False" ] || fail "second DELETE should be idempotent removed:false"
echo "✓ 7/7 DELETE reverts to flat; second DELETE idempotent (removed:false)"

rm -f "$SAMPLE_JSON" "$BROKEN_JSON" "$COMMIT_JSON" "$SAMPLE_JSON.resp" "$BROKEN_JSON.resp"
echo ""
echo "SHAPARAK IMPORT SMOKE — 7/7 PASSED (service $KEY restored to flat)"

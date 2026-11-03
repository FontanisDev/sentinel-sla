# Live smoke test for POST /api/services/import (dev :3000).
# Covers: 401 unauthenticated → dry-run (all rows ok, zero writes) →
# commit (201, serviceIds) → re-commit (422 all-or-nothing abort with
# per-row 409s) → broken sheet (per-row validation errors with physical
# line numbers) → rows visible in GET /api/services → cleanup (Prisma
# delete of smoke-* rows + token revoke).
#
# Run: bash scripts/csv-import-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SENTINEL_PORT:-3000}"
BASE="http://localhost:${PORT}"

TOKEN=$(bun scripts/mint-loadtest-token.mjs --name csv-import-smoke --days 1 2>/dev/null | tail -1)
trap 'bun scripts/mint-loadtest-token.mjs --revoke --name csv-import-smoke >/dev/null 2>&1; bun scripts/cleanup-smoke-services.mjs' EXIT

fail() { echo "FAIL: $1"; exit 1; }
jqget() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval('d'+sys.argv[1]))" "$1"; }

# ── 1. unauthenticated → 401 ─────────────────────────────────────────────
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/services/import" \
  -H 'Content-Type: application/json' -d '{"csv":"key,name\na1,A1\n"}')
[ "$CODE" = "401" ] || fail "unauthenticated import → $CODE (want 401)"
echo "ok 1: unauthenticated 401"

# ── 2. dry-run the template sheet (tenant → sabz-pay, smoke-* keys) ──────
CSV=$(sed 's/acme-bank/sabz-pay/g; s/^psp-gateway,/smoke-psp-gateway,/; s/^core-ledger,/smoke-core-ledger,/; s/^mobile-wallet,/smoke-mobile-wallet,/' public/templates/services-import-template.csv)
python3 - "$CSV" <<'EOF' > /tmp/smoke-dryrun.json
import json, sys
print(json.dumps({"csv": sys.argv[1], "mode": "dryRun"}))
EOF
DRY=$(curl -s -X POST "$BASE/api/services/import" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data-binary @/tmp/smoke-dryrun.json)
echo "$DRY" > /tmp/smoke-dry-resp.json
[ "$(echo "$DRY" | jqget "['committed']")" = "False" ] || fail "dry-run claims committed"
[ "$(echo "$DRY" | jqget "['ok']")" = "3" ] || fail "dry-run ok=$(echo "$DRY" | jqget "['ok']") (want 3)"
[ "$(echo "$DRY" | jqget "['failed']")" = "0" ] || fail "dry-run failed=$(echo "$DRY" | jqget "['failed']")"
[ "$(echo "$DRY" | jqget "['rows'][0]['line']")" = "2" ] || fail "first data row line != 2"
echo "ok 2: dry-run 3/3 ready, committed=False"

# ── 3. dry-run wrote nothing ─────────────────────────────────────────────
COUNT_BEFORE=$(curl -s "$BASE/api/services" -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; print(sum(1 for s in json.load(sys.stdin)['services'] if s['key'].startswith('smoke-')))")
[ "$COUNT_BEFORE" = "0" ] || fail "dry-run wrote rows ($COUNT_BEFORE smoke services exist)"
echo "ok 3: dry-run wrote nothing"

# ── 4. commit → 201, 3 serviceIds ────────────────────────────────────────
python3 - "$CSV" <<'EOF' > /tmp/smoke-commit.json
import json, sys
print(json.dumps({"csv": sys.argv[1], "mode": "commit"}))
EOF
COMMIT=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/services/import" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data-binary @/tmp/smoke-commit.json)
CODE=$(echo "$COMMIT" | tail -1)
BODY=$(echo "$COMMIT" | head -n -1)
[ "$CODE" = "201" ] || fail "commit → $CODE (want 201): $BODY"
IDS=$(echo "$BODY" | jqget "['serviceIds']")
N=$(echo "$IDS" | python3 -c "import ast,sys; print(len(ast.literal_eval(sys.argv[1])))" "$IDS")
[ "$N" = "3" ] || fail "commit created $N services (want 3)"
echo "ok 4: commit 201, serviceIds=$IDS"

# ── 5. rows visible via GET /api/services ────────────────────────────────
GOT=$(curl -s "$BASE/api/services" -H "Authorization: Bearer $TOKEN" | python3 -c "
import json,sys
keys = {s['key'] for s in json.load(sys.stdin)['services']}
print(','.join(k for k in ('smoke-psp-gateway','smoke-core-ledger','smoke-mobile-wallet') if k in keys))")
[ "$(echo "$GOT" | tr ',' '\n' | wc -l)" = "3" ] || fail "GET /api/services missing smoke rows: $GOT"
echo "ok 5: GET /api/services shows all 3 imported services"

# ── 6. re-commit the same sheet → 422 all-or-nothing (per-row 409) ───────
RECOMMIT=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/services/import" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data-binary @/tmp/smoke-commit.json)
CODE=$(echo "$RECOMMIT" | tail -1)
BODY=$(echo "$RECOMMIT" | head -n -1)
[ "$CODE" = "422" ] || fail "re-commit → $CODE (want 422)"
[ "$(echo "$BODY" | jqget "['failed']")" = "3" ] || fail "re-commit failed=$(echo "$BODY" | jqget "['failed']") (want 3)"
echo "$BODY" | jqget "['rows'][0]['error']" | grep -q "already exists" || fail "re-commit row error not the duplicate message"
echo "ok 6: re-commit aborted 422 (all-or-nothing, duplicate keys per-row)"

# ── 7. broken sheet → per-row validation errors, line numbers, no commit ─
BAD=$'key,name,nameFa,tenant,slaTarget,penaltyBase,criticality\nbad key!,Broken Name,,sabz-pay,0.999,100,critical\n,Missing Key,,sabz-pay,0.999,100,high\nghost-tenant,Valid Name,,no-such-tenant,0.999,100,low\nsmoke-psp-gateway,Duplicate,,sabz-pay,0.999,100,medium'
python3 - "$BAD" <<'EOF' > /tmp/smoke-bad.json
import json, sys
print(json.dumps({"csv": sys.argv[1], "mode": "commit"}))
EOF
BADRES=$(curl -s -X POST "$BASE/api/services/import" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data-binary @/tmp/smoke-bad.json)
echo "$BADRES" > /tmp/smoke-bad-resp.json
[ "$(echo "$BADRES" | jqget "['failed']")" = "4" ] || fail "bad sheet failed=$(echo "$BADRES" | jqget "['failed']") (want 4)"
ERR2=$(echo "$BADRES" | jqget "['rows'][0]['error']")
echo "$ERR2" | grep -q "key" || fail "row-2 error should name the key field: $ERR2"
echo "$BADRES" | jqget "['rows'][2]['error']" | grep -q "not found" || fail "row-4 error should be tenant-not-found"
echo "$BADRES" | jqget "['rows'][3]['error']" | grep -q "already exists" || fail "row-5 error should be duplicate"
COUNT_AFTER_BAD=$(curl -s "$BASE/api/services" -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; print(sum(1 for s in json.load(sys.stdin)['services'] if s['key'].startswith('ghost-')))")
[ "$COUNT_AFTER_BAD" = "0" ] || fail "aborted commit wrote rows"
echo "ok 7: broken sheet → 4 per-row errors (validation / tenant / duplicate), nothing written"

echo "ALL CSV-IMPORT SMOKE CHECKS PASSED"

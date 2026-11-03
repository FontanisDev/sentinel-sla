# Live smoke test for POST /api/rules/import (Grafana alert-rule import,
# dev :3000). Covers: 401 unauthenticated → dry-run (4/4 mapped, zero
# writes) → broken export with an unmappable rule, commit → 422
# all-or-nothing abort → commit of the sample (201, 4 ruleIds) → rules
# visible in GET /api/rules → re-commit (422, duplicate names per row) →
# cleanup (SMOKE-prefixed rules deleted, token revoked).
#
# Run: bash scripts/grafana-import-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SENTINEL_PORT:-3000}"
BASE="http://localhost:${PORT}"

TOKEN=$(bun scripts/mint-loadtest-token.mjs --name grafana-import-smoke --days 1 2>/dev/null | tail -1)
trap 'bun scripts/mint-loadtest-token.mjs --revoke --name grafana-import-smoke >/dev/null 2>&1; bun scripts/cleanup-smoke-rules.mjs' EXIT

fail() { echo "FAIL: $1"; exit 1; }
jqget() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval('d'+sys.argv[1]))" "$1"; }

# Build the smoke export: sample rules renamed "SMOKE …" + one unmappable
# rule (filesystem family — not one of Sentinel's four metrics).
python3 - <<'EOF' > /tmp/grafana-smoke.json
import json

sample = json.load(open('public/templates/grafana-alerts-sample.json'))
for r in sample['rules']:
    r['title'] = 'SMOKE ' + r['title']
sample['rules'].append({
    'uid': 'gr-smoke-disk',
    'title': 'SMOKE disk pressure (unmappable family)',
    'condition': 'A',
    'labels': {'severity': 'warning'},
    'data': [{'refId': 'A', 'model': {'expr': 'node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1'}}],
})
print(json.dumps(sample))
EOF

# ── 1. unauthenticated → 401 ─────────────────────────────────────────────
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/rules/import" \
  -H 'Content-Type: application/json' -d '{"json":"{\"rules\":[]}"}')
[ "$CODE" = "401" ] || fail "unauthenticated import → $CODE (want 401)"
echo "ok 1: unauthenticated 401"

# ── 2. dry-run → 4/4 mapped, committed=False ─────────────────────────────
python3 - <<'EOF' > /tmp/grafana-dryrun-req.json
import json
print(json.dumps({"json": open('/tmp/grafana-smoke.json').read(), "mode": "dryRun"}))
EOF
DRY=$(curl -s -X POST "$BASE/api/rules/import" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data-binary @/tmp/grafana-dryrun-req.json)
echo "$DRY" > /tmp/grafana-dry-resp.json
[ "$(echo "$DRY" | jqget "['committed']")" = "False" ] || fail "dry-run claims committed"
[ "$(echo "$DRY" | jqget "['total']")" = "5" ] || fail "dry-run total=$(echo "$DRY" | jqget "['total']") (want 5)"
[ "$(echo "$DRY" | jqget "['ok']")" = "4" ] || fail "dry-run ok=$(echo "$DRY" | jqget "['ok']") (want 4)"
[ "$(echo "$DRY" | jqget "['failed']")" = "1" ] || fail "dry-run failed=$(echo "$DRY" | jqget "['failed']") (want 1)"
echo "$DRY" | grep -q 'not recognisably' || fail "unmapped rule reason missing from the report"
echo "ok 2: dry-run 4 mapped + 1 honestly unmapped, committed=False"

# ── 3. dry-run wrote nothing ─────────────────────────────────────────────
COUNT_BEFORE=$(curl -s "$BASE/api/rules" -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; print(sum(1 for r in json.load(sys.stdin) if r['name'].startswith('SMOKE ')))")
[ "$COUNT_BEFORE" = "0" ] || fail "dry-run wrote rules ($COUNT_BEFORE SMOKE rules exist)"
echo "ok 3: dry-run wrote nothing"

# ── 4. commit with the unmapped rule → 422, nothing written ──────────────
python3 - <<'EOF' > /tmp/grafana-bad-commit-req.json
import json
print(json.dumps({"json": open('/tmp/grafana-smoke.json').read(), "mode": "commit"}))
EOF
BAD=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/rules/import" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data-binary @/tmp/grafana-bad-commit-req.json)
CODE=$(echo "$BAD" | tail -1)
[ "$CODE" = "422" ] || fail "broken commit → $CODE (want 422 all-or-nothing abort)"
COUNT_MID=$(curl -s "$BASE/api/rules" -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; print(sum(1 for r in json.load(sys.stdin) if r['name'].startswith('SMOKE ')))")
[ "$COUNT_MID" = "0" ] || fail "abort still wrote $COUNT_MID rules"
echo "ok 4: commit aborted 422 — zero partial writes"

# ── 5. commit the clean sample (no unmapped rule) → 201, 4 ruleIds ───────
python3 - <<'EOF' > /tmp/grafana-clean.json
import json
sample = json.load(open('public/templates/grafana-alerts-sample.json'))
for r in sample['rules']:
    r['title'] = 'SMOKE ' + r['title']
print(json.dumps(sample))
EOF
python3 - <<'EOF' > /tmp/grafana-commit-req.json
import json
print(json.dumps({"json": open('/tmp/grafana-clean.json').read(), "mode": "commit"}))
EOF
COMMIT=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/rules/import" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data-binary @/tmp/grafana-commit-req.json)
CODE=$(echo "$COMMIT" | tail -1)
BODY=$(echo "$COMMIT" | head -n -1)
[ "$CODE" = "201" ] || fail "commit → $CODE (want 201): $BODY"
N=$(echo "$BODY" | jqget "['ruleIds']" | python3 -c "import ast,sys; print(len(ast.literal_eval(sys.argv[1])))" "$(echo "$BODY" | jqget "['ruleIds']")")
[ "$N" = "4" ] || fail "commit created $N rules (want 4)"
echo "ok 5: commit 201, 4 ruleIds"

# ── 6. rules visible in GET /api/rules with mapped fields ────────────────
VIS=$(curl -s "$BASE/api/rules" -H "Authorization: Bearer $TOKEN" | python3 -c "
import json, sys
rules = [r for r in json.load(sys.stdin) if r['name'].startswith('SMOKE ')]
by = {r['name']: r for r in rules}
print(len(rules),
      by['SMOKE Payment Gateway down (probe failed)']['metric'],
      by['SMOKE Payment Gateway down (probe failed)']['threshold'],
      by['SMOKE Core Banking p95 latency above one second']['threshold'],
      by['SMOKE Wallet API server error ratio']['cooldownMin'],
      by['SMOKE KYC traffic floor breached']['severity'],
      by['SMOKE Payment Gateway down (probe failed)']['serviceName'])
")
[ "$(echo "$VIS" | awk '{print $1}')" = "4" ] || fail "expected 4 SMOKE rules in the registry, got: $VIS"
[ "$(echo "$VIS" | cut -d' ' -f2-)" = "uptime 1 1000 5 critical Payment Gateway" ] || fail "mapped fields wrong: $VIS"
echo "ok 6: registry shows uptime lt 1 / latency 1000 ms / cooldown 5 / severity critical / service bound"

# ── 7. re-commit → 422 with per-row duplicate 409s ───────────────────────
RE=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/rules/import" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data-binary @/tmp/grafana-commit-req.json)
CODE=$(echo "$RE" | tail -1)
[ "$CODE" = "422" ] || fail "re-commit → $CODE (want 422)"
echo "$RE" | grep -q 'already exists' || fail "re-commit report lacks duplicate-name reasons"
echo "ok 7: re-commit 422 — per-row duplicate detection"

echo "grafana-import smoke: ALL CHECKS PASSED"

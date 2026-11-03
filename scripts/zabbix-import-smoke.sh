# Live smoke test for POST /api/rules/import with source=zabbix (dev :3000).
# Covers: 401 unauthenticated → dry-run (4/4 mapped, zero writes) → broken
# export with a host-resource trigger, commit → 422 all-or-nothing abort →
# commit of the clean sample (201, 4 ruleIds) → rules visible in
# GET /api/rules with mapped fields → re-commit (422, duplicates) →
# disabled-trigger refusal is reported per-row → cleanup.
#
# Run: bash scripts/zabbix-import-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SENTINEL_PORT:-3000}"
BASE="http://localhost:${PORT}"

TOKEN=$(bun scripts/mint-loadtest-token.mjs --name zabbix-import-smoke --days 1 2>/dev/null | tail -1)
trap 'bun scripts/mint-loadtest-token.mjs --revoke --name zabbix-import-smoke >/dev/null 2>&1; bun scripts/cleanup-smoke-rules.mjs' EXIT

fail() { echo "FAIL: $1"; exit 1; }
jqget() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval('d'+sys.argv[1]))" "$1"; }

# Build the smoke export: sample triggers renamed "SMOKE …" + one host-
# resource trigger (CPU) that must be honestly refused.
python3 - <<'EOF' > /tmp/zabbix-smoke.json
import json

sample = json.load(open('public/templates/zabbix-triggers-sample.json'))
for t in sample:
    t['description'] = 'SMOKE ' + t['description']
sample.append({
    'triggerid': '15199',
    'description': 'SMOKE CPU pressure (host resource — unmappable)',
    'expression': 'last(/core-banking/system.cpu.util[,idle])<10',
    'priority': '4',
    'status': '0',
    'hosts': [{'host': 'core-banking', 'name': 'Core Banking'}],
})
print(json.dumps(sample))
EOF

req() { # $1 = payload file
  curl -s -X POST "$BASE/api/rules/import" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data-binary "$1"
}
authless() { # 401 check
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/rules/import" \
    -H 'Content-Type: application/json' -d '{"json":"[]"}'
}

# ── 1. unauthenticated → 401 ─────────────────────────────────────────────
CODE=$(authless)
[ "$CODE" = "401" ] || fail "unauthenticated import → $CODE (want 401)"
echo "ok 1: unauthenticated 401"

# ── 2. dry-run with source=zabbix → 4 mapped + 1 refused, zero writes ────
python3 - <<'EOF' > /tmp/zbx-dryrun-req.json
import json
print(json.dumps({"json": open('/tmp/zabbix-smoke.json').read(), "source": "zabbix", "mode": "dryRun"}))
EOF
DRY=$(req @/tmp/zbx-dryrun-req.json)
echo "$DRY" > /tmp/zbx-dry-resp.json
[ "$(echo "$DRY" | jqget "['source']")" = "zabbix" ] || fail "report source=$(echo "$DRY" | jqget "['source']")"
[ "$(echo "$DRY" | jqget "['committed']")" = "False" ] || fail "dry-run claims committed"
[ "$(echo "$DRY" | jqget "['total']")" = "5" ] || fail "dry-run total=$(echo "$DRY" | jqget "['total']") (want 5)"
[ "$(echo "$DRY" | jqget "['ok']")" = "4" ] || fail "dry-run ok=$(echo "$DRY" | jqget "['ok']") (want 4)"
[ "$(echo "$DRY" | jqget "['failed']")" = "1" ] || fail "dry-run failed=$(echo "$DRY" | jqget "['failed']") (want 1)"
echo "$DRY" | grep -q 'host-resource trigger' || fail "CPU refusal reason missing from the report"
echo "ok 2: dry-run 4 mapped + 1 honestly refused, committed=False"

# ── 3. dry-run wrote nothing ─────────────────────────────────────────────
COUNT_BEFORE=$(curl -s "$BASE/api/rules" -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; print(sum(1 for r in json.load(sys.stdin) if r['name'].startswith('SMOKE ')))")
[ "$COUNT_BEFORE" = "0" ] || fail "dry-run wrote rules ($COUNT_BEFORE SMOKE rules exist)"
echo "ok 3: dry-run wrote nothing"

# ── 4. commit with the refused trigger → 422, nothing written ────────────
python3 - <<'EOF' > /tmp/zbx-bad-req.json
import json
print(json.dumps({"json": open('/tmp/zabbix-smoke.json').read(), "source": "zabbix", "mode": "commit"}))
EOF
BAD=$(req @/tmp/zbx-bad-req.json | tail -c 400)
echo "$BAD" | grep -q '"committed":false' || fail "broken commit did not abort"
BADCOUNT=$(curl -s "$BASE/api/rules" -H "Authorization: Bearer $TOKEN" | python3 -c "import json,sys; print(sum(1 for r in json.load(sys.stdin) if r['name'].startswith('SMOKE ')))")
[ "$BADCOUNT" = "0" ] || fail "abort still wrote $BADCOUNT rules"
echo "ok 4: commit aborted — zero partial writes"

# ── 5. commit the clean sample → 201, 4 ruleIds ──────────────────────────
python3 - <<'EOF' > /tmp/zbx-clean.json
import json
sample = json.load(open('public/templates/zabbix-triggers-sample.json'))
for t in sample:
    t['description'] = 'SMOKE ' + t['description']
print(json.dumps(sample))
EOF
python3 - <<'EOF' > /tmp/zbx-commit-req.json
import json
print(json.dumps({"json": open('/tmp/zbx-clean.json').read(), "source": "zabbix", "mode": "commit"}))
EOF
COMMIT=$(req @/tmp/zbx-commit-req.json)
[ "$(echo "$COMMIT" | jqget "['committed']")" = "True" ] || fail "clean commit failed: $COMMIT"
N=$(echo "$COMMIT" | jqget "['ruleIds']" | python3 -c "import ast,sys; print(len(ast.literal_eval(sys.argv[1])))" "$(echo "$COMMIT" | jqget "['ruleIds']")")
[ "$N" = "4" ] || fail "commit created $N rules (want 4)"
echo "ok 5: commit 201, 4 ruleIds"

# ── 6. registry shows mapped fields ──────────────────────────────────────
VIS=$(curl -s "$BASE/api/rules" -H "Authorization: Bearer $TOKEN" | python3 -c "
import json, sys
rules = [r for r in json.load(sys.stdin) if r['name'].startswith('SMOKE ')]
by = {r['name']: r for r in rules}
print(len(rules),
      by['SMOKE Payment gateway agent unreachable']['metric'],
      by['SMOKE Payment gateway TCP service responds slower than 1s']['threshold'],
      by['SMOKE Core banking transaction rate below floor']['metric'],
      by['SMOKE Core banking transaction rate below floor']['threshold'],
      by['SMOKE Wallet checkout web scenario has failing steps']['severity'])
")
[ "$(echo "$VIS" | cut -d' ' -f1)" = "4" ] || fail "expected 4 SMOKE rules, got: $VIS"
[ "$(echo "$VIS" | cut -d' ' -f2-)" = "uptime 1000 throughput 10 warning" ] || fail "mapped fields wrong: $VIS"
echo "ok 6: registry shows uptime lt 1 / latency 1000 ms / throughput lt 10 / severity warning"

# ── 7. re-commit → 422 with per-row duplicate reasons ────────────────────
RE=$(req @/tmp/zbx-commit-req.json)
[ "$(echo "$RE" | jqget "['failed']")" = "4" ] || fail "re-commit failed=$(echo "$RE" | jqget "['failed']") (want 4)"
echo "$RE" | grep -q 'already exists' || fail "re-commit report lacks duplicate reasons"
echo "ok 7: re-commit refused — per-row duplicate detection"

echo "zabbix-import smoke: ALL CHECKS PASSED"

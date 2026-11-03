#!/usr/bin/env bash
# Integration tests — run on a host with docker/helm; the heavy stack is not started by the default test run.
#
# ═══════════════════════════════════════════════════════════════════════════
# Sentinel-SLA (سنتیل-SLA) — deployment artifact validation
# Owner: Sentinel-SLA
#
# Validates that every configuration file in the industrial deployment tree
# exists and parses, WITHOUT starting the stack:
#   * docker compose config -q     (if docker is available)
#   * YAML syntax for every config (python3 + PyYAML)
#   * JSON syntax for the Grafana dashboard + JSON Schema
#   * helm lint                    (if helm is available)
#   * gofmt cleanliness            (if go is available)
#   * python3 -m py_compile for the chaos + load scripts
# Exit code: 0 = all green, 1 = at least one check failed.
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

PASS=0
FAIL=0
FAILED_NAMES=()

ok()  { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL + 1)); FAILED_NAMES+=("$1"); }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }

run() { # run <name> <command...>
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi
}

header() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# ── 0. tooling ─────────────────────────────────────────────────────────────
header "Tooling"
command -v python3 >/dev/null 2>&1 && ok "python3 available" || { bad "python3 available"; }
if command -v docker >/dev/null 2>&1; then ok "docker available"; else skip "docker available (compose validation will be skipped)"; fi
if command -v helm   >/dev/null 2>&1; then ok "helm available";   else skip "helm available (chart lint will be skipped)"; fi
if command -v go     >/dev/null 2>&1; then ok "go available";    else skip "go available (gofmt check will be skipped)"; fi

# ── 1. expected files exist ────────────────────────────────────────────────
header "Artifact presence"
EXPECTED_FILES=(
  deploy/docker-compose.yml
  deploy/README.md
  deploy/prometheus/prometheus.yml
  deploy/prometheus/rules/sentinel-alerts.yml
  deploy/alertmanager/alertmanager.yml
  deploy/loki/loki-config.yml
  deploy/promtail/promtail-config.yml
  deploy/blackbox/blackbox.yml
  deploy/grafana/provisioning/datasources/prometheus.yml
  deploy/grafana/provisioning/datasources/loki.yml
  deploy/grafana/provisioning/dashboards/dashboards-provider.yml
  deploy/grafana/provisioning/dashboards/sentinel-overview.json
  deploy/helm/sentinel-sla/Chart.yaml
  deploy/helm/sentinel-sla/values.yaml
  deploy/helm/sentinel-sla/templates/deployment.yaml
  deploy/helm/sentinel-sla/templates/service.yaml
  deploy/helm/sentinel-sla/templates/secret.yaml
  deploy/helm/sentinel-sla/templates/pvc.yaml
  deploy/helm/sentinel-sla/templates/ingress.yaml
  deploy/helm/sentinel-sla/templates/servicemonitor.yaml
  deploy/helm/sentinel-sla/templates/NOTES.txt
  deploy/helm/sentinel-sla/.helmignore
  exporter/main.go
  exporter/go.mod
  exporter/internal/collector/collector.go
  exporter/Dockerfile
  chaos/chaos_experiment.py
  chaos/auto_chaos.sh
  chaos/requirements-note.md
  openapi/openapi.yaml
  schemas/incident-event.schema.json
  tests/integration/test_stack.sh
  tests/load/load_test.py
  # product packaging
  Dockerfile
  .dockerignore
  docker-compose.yml
  docker-compose.dev.yml
  .env.example
  src/worker/index.ts
  src/server/config.ts
  src/server/locks.ts
  prisma/schema.postgres.prisma
  scripts/prisma-postgres.sh
)
for f in "${EXPECTED_FILES[@]}"; do
  [ -f "$ROOT/$f" ] && ok "exists: $f" || bad "exists: $f"
done

# ── 2. YAML parse checks (PyYAML) ─────────────────────────────────────────
header "YAML syntax"
YAML_FILES=(
  deploy/docker-compose.yml
  deploy/prometheus/prometheus.yml
  deploy/prometheus/rules/sentinel-alerts.yml
  deploy/alertmanager/alertmanager.yml
  deploy/loki/loki-config.yml
  deploy/promtail/promtail-config.yml
  deploy/blackbox/blackbox.yml
  deploy/grafana/provisioning/datasources/prometheus.yml
  deploy/grafana/provisioning/datasources/loki.yml
  deploy/grafana/provisioning/dashboards/dashboards-provider.yml
  deploy/helm/sentinel-sla/Chart.yaml
  deploy/helm/sentinel-sla/values.yaml
  openapi/openapi.yaml
  docker-compose.yml
  docker-compose.dev.yml
)
for f in "${YAML_FILES[@]}"; do
  run "yaml parse: $f" python3 -c "import sys, yaml; yaml.safe_load(open(sys.argv[1]))" "$ROOT/$f"
done
# helm templates are Go templates — check they at least contain no tabs (YAML rule)
for f in "$ROOT"/deploy/helm/sentinel-sla/templates/*.yaml; do
  if grep -q "$(printf '\t')" "$f"; then bad "no tabs in helm template: ${f#"$ROOT"/}"; else ok "no tabs in helm template: ${f#"$ROOT"/}"; fi
done

# ── 3. JSON parse checks ───────────────────────────────────────────────────
header "JSON syntax"
run "json parse: grafana dashboard" \
  python3 -c "import sys, json; d = json.load(open(sys.argv[1])); assert d['uid'] == 'sentinel-overview' and d['schemaVersion'] == 39 and len(d['panels']) == 11" \
  "$ROOT/deploy/grafana/provisioning/dashboards/sentinel-overview.json"
run "json parse: incident-event schema" \
  python3 -c "import sys, json; json.load(open(sys.argv[1]))" \
  "$ROOT/schemas/incident-event.schema.json"

# ── 4. docker compose validates ────────────────────────────────────────────
header "Docker Compose"
if command -v docker >/dev/null 2>&1; then
  run "docker compose config -q" docker compose -f "$ROOT/deploy/docker-compose.yml" config -q
else
  skip "docker compose config -q (docker not installed in this environment)"
fi

# ── 5. helm lint ────────────────────────────────────────────────────────────
header "Helm chart"
if command -v helm >/dev/null 2>&1; then
  run "helm lint sentinel-sla chart" helm lint "$ROOT/deploy/helm/sentinel-sla"
else
  skip "helm lint (helm not installed in this environment)"
fi

# ── 6. Go formatting ────────────────────────────────────────────────────────
header "Go exporter"
if command -v gofmt >/dev/null 2>&1; then
  UNFORMATTED="$(gofmt -l "$ROOT/exporter/")"
  if [ -z "$UNFORMATTED" ]; then ok "gofmt clean: exporter/"; else bad "gofmt clean: exporter/ ($UNFORMATTED)"; fi
else
  skip "gofmt check (go not installed in this environment)"
fi

# ── 7. Python compile checks ────────────────────────────────────────────────
header "Python"
run "py_compile: chaos/chaos_experiment.py" python3 -m py_compile "$ROOT/chaos/chaos_experiment.py"
run "py_compile: tests/load/load_test.py" python3 -m py_compile "$ROOT/tests/load/load_test.py"

# ── 8. Packaging invariants ────────────────────────────────────────
header "Packaging"
run "Dockerfile is multi-stage" grep -q "^FROM.*AS runtime" "$ROOT/Dockerfile"
run "Dockerfile is non-root" grep -q "USER sentinel" "$ROOT/Dockerfile"
run "Dockerfile declares HEALTHCHECK" grep -q "HEALTHCHECK" "$ROOT/Dockerfile"
run "compose: worker overrides command" grep -q "src/worker/index.ts" "$ROOT/docker-compose.yml"
run "compose: migrate job wired" grep -q "prisma\", \"db\", \"push" "$ROOT/docker-compose.yml"
run "compose: sqlite on the shared data volume" grep -q "file:/data/sentinel.db" "$ROOT/docker-compose.yml"
run "worker: refuses web role" grep -q "refusing to start" "$ROOT/src/worker/index.ts"
run "reportgen: no cwd-joined data paths" bash -c '! grep -q "path.join(process.cwd()" "$0/src/server/reportgen.ts"' "$ROOT"
run "prisma postgres schema derived" grep -q 'provider = "postgresql"' "$ROOT/prisma/schema.postgres.prisma"
run "postgres schema in sync with sqlite schema" bash -c "diff -q <(sed 's/\"postgresql\"/\"sqlite\"/' \"$ROOT/prisma/schema.postgres.prisma\") \"$ROOT/prisma/schema.prisma\""

# ── 9. Security invariants ─────────────────────────────────────────
header "Security"
run "proxy: CSP header set on every response" grep -q "Content-Security-Policy" "$ROOT/src/proxy.ts"
run "proxy: frame-ancestors none" grep -q "frame-ancestors 'none'" "$ROOT/src/proxy.ts"
run "proxy: HSTS gated on SENTINEL_TLS" grep -q "SENTINEL_TLS" "$ROOT/src/proxy.ts"
run "ratelimit: login route throttled" grep -q "RATE_RULES.login" "$ROOT/src/app/api/auth/login/route.ts"
run "ratelimit: report generation throttled" grep -q "RATE_RULES.reportGenerate" "$ROOT/src/app/api/reports/route.ts"
run "ratelimit: exports throttled" grep -q "RATE_RULES.export" "$ROOT/src/app/api/export/incidents/route.ts"
run "authz: tenant scope resolver exists" grep -q "resolveTenantScope" "$ROOT/src/server/authz.ts"
run "authz: dashboard enforces tenant scope" grep -q "resolveTenantScope" "$ROOT/src/app/api/dashboard/route.ts"
run "authz: reports enforces tenant scope" grep -q "resolveTenantScope" "$ROOT/src/app/api/reports/route.ts"
run "authz: services POST enforces tenant scope" grep -q "requireTenantAccess" "$ROOT/src/app/api/services/route.ts"
run "authz: users API is admin-floored" grep -q "requireRole(req, 'admin')" "$ROOT/src/app/api/users/route.ts"
run "authz: audit API is admin-floored" grep -q "requireRole(req, 'admin')" "$ROOT/src/app/api/audit/route.ts"
run "authz: user deletes are owner-only" grep -q "deletion is owner-only" "$ROOT"/src/app/api/users/[id]/route.ts
run "authz: generated matrix exists" test -x "$ROOT/tests/integration/authz-matrix.mjs"

# Live authz matrix (needs a running server + credentials in untracked .env.test).
# Exit 77 = skipped → not a failure; run it explicitly against a live server.
if [ -f "$ROOT/.env.test" ] && curl -sf -o /dev/null --max-time 3 http://127.0.0.1:3000/api/health/live; then
  run "authz matrix (live server, all routes)" node "$ROOT/tests/integration/authz-matrix.mjs"
else
  printf '  SKIP  authz matrix (no .env.test or no live server on :3000)\n'
fi

# ── 10. Domain invariants ──────────────────────────────────────────
header "Domain"
run "domain: pure package exists (no db/http imports)" test "$(grep -rEl "from '@/lib/db'|from 'next'|node:fs" "$ROOT"/src/domain/*.ts 2>/dev/null | wc -l)" -eq 0
run "domain: integer-rials core exports half-even rounding" grep -q "divRoundHalfEven" "$ROOT/src/domain/money.ts"
run "domain: versioned money model with 3 tps sources" grep -q "TpsHourOfWeekProfile" "$ROOT/src/domain/money-model.ts"
run "domain: contract tiers + fixedPerMinute modes" grep -q "'fixedPerMinute'" "$ROOT/src/domain/contract.ts"
run "domain: overlap winner rule documented in code" grep -q "chargeable: 2, external: 1, planned: 0" "$ROOT/src/domain/outage.ts"
run "domain: evaluation returns evidence lines" grep -q "evidence" "$ROOT/src/domain/availability.ts"
run "domain: 18 golden scenarios on disk" test "$(ls "$ROOT"/tests/golden/*.json 2>/dev/null | wc -l)" -ge 12
run "domain: golden runner wired into vitest" test -f "$ROOT/tests/unit/golden.test.ts"
run "domain: property tests cover the 6 domain invariants" test -f "$ROOT/tests/unit/domain-property.test.ts"
run "domain: coverage threshold at 95 % in vitest config" grep -q "branches: 95" "$ROOT/vitest.config.ts"
run "domain: coverage script exists" grep -q '"test:domain"' "$ROOT/package.json"
run "domain: docs/DOMAIN.md complete" grep -q "Banker-neutral rounding at the final step only" "$ROOT/docs/DOMAIN.md"
run "domain: engine penalty delegates to the domain" grep -q "penaltyFixedPerMinute" "$ROOT/src/server/engine.ts"
run "domain: DOMAIN.md documents every golden id" node -e '
const fs=require("fs"),path=require("path");
const dir="tests/golden";
const md=fs.readFileSync("docs/DOMAIN.md","utf8");
const missing=fs.readdirSync(dir).filter(f=>f.endsWith(".json")&&!md.includes("### "+f.replace(".json","")));
if(missing.length){console.error("missing in DOMAIN.md:",missing.join(", "));process.exit(1);}
'

# ── 11. Live-mode invariants ───────────────────────────────────────
header "Live mode"
run "live: probe source + state on Service schema" grep -q "liveIncidentOpen" "$ROOT/prisma/schema.prisma"
run "live: Incident evidence column" grep -q "evidence" "$ROOT/prisma/schema.prisma"
run "live: IntegrationEvent dedup table" grep -q "model IntegrationEvent" "$ROOT/prisma/schema.prisma"
run "live: IntegrationSetting table" grep -q "model IntegrationSetting" "$ROOT/prisma/schema.prisma"
run "live: pure detection state machine in domain" grep -q "applyStale" "$ROOT/src/domain/detection.ts"
run "live: getEngine refuses to tick in live mode" grep -q "simulation NEVER ticks in live mode" "$ROOT/src/server/engine.ts"
run "live: instrumentation gates on SENTINEL_MODE" grep -q "simulation disabled" "$ROOT/src/instrumentation.ts"
run "live: worker starts ingestion + standalone scheduler" grep -q "runDueReportSchedules" "$ROOT/src/worker/index.ts"
run "live: ingestion treats unreachable as stale" grep -q "monitoring blind" "$ROOT/src/server/ingestion.ts"
run "live: prometheus settings API (admin)" grep -q "requireRole(req, 'admin')" "$ROOT/src/app/api/integrations/prometheus/route.ts"
run "live: test-connection route exists" test -f "$ROOT/src/app/api/integrations/prometheus/test/route.ts"
run "live: alertmanager webhook bearer-gated" grep -q "SENTINEL_WEBHOOK_BEARER" "$ROOT/src/app/api/integrations/alertmanager/route.ts"
run "live: webhook fingerprint dedup" grep -q "source_fingerprint" "$ROOT/src/app/api/integrations/alertmanager/route.ts"
run "live: ModeBadge in the shell top bar" grep -q "ModeBadge" "$ROOT/src/components/sentinel/app-shell.tsx"
run "live: i18n has both FA + EN badge strings" test "$(cat "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts" | grep -c "mode.badge.live'")" -ge 2
run "live: env example documents the knobs" grep -q "SENTINEL_WEBHOOK_BEARER" "$ROOT/.env.example"
run "live: end-to-end proof script exists" test -f "$ROOT/scripts/live-run-proof.mjs"

# ── 12. Wizard, exporter & Grafana #2 invariants ───────────────────
header "Wizard + exporter + Grafana #2"
run "wizard: probe source schema (3 kinds)" grep -q "z.discriminatedUnion('kind'" "$ROOT/src/server/validation.ts"
run "wizard: createServiceSchema stores probe source" grep -q "probeSource: probeSourceSchema.optional()" "$ROOT/src/server/validation.ts"
run "wizard: services POST persists probe source JSON" grep -q "probeSource: parsed.probeSource ? JSON.stringify" "$ROOT/src/app/api/services/route.ts"
run "wizard: preview route is engineer-gated" grep -q "requireRole(req, 'engineer')" "$ROOT/src/app/api/services/preview/route.ts"
run "wizard: preview fails named when unconfigured" grep -q "prometheus-not-configured" "$ROOT/src/app/api/services/preview/route.ts"
run "wizard: 1h range query in ingestion" grep -q "api/v1/query_range" "$ROOT/src/server/ingestion.ts"
run "wizard: alertmanager preview is honest (webhook note)" grep -q "webhook-driven" "$ROOT/src/server/ingestion.ts"
run "wizard: settings services page exists" test -f "$ROOT/src/app/settings/services/page.tsx"
run "wizard: integrations settings page exists" test -f "$ROOT/src/app/settings/integrations/page.tsx"
run "wizard: settings pages are bilingual" test "$(cat "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts" | grep -c "settings.wizard.title'")" -ge 2
run "wizard: DTO carries liveStatus + probeSource" grep -q "liveStatus: 'up' | 'down' | 'stale' | null" "$ROOT/src/lib/types.ts"
run "exporter: tenant money rollup metric" grep -q "sentinel_tenant_penalty_tomans_total" "$ROOT/exporter/internal/collector/collector.go"
run "exporter: live state metrics" grep -q "sentinel_service_live_stale" "$ROOT/exporter/internal/collector/collector.go"
run "exporter: outbox depth never invented" grep -qE "OutboxDepth[[:space:]]+\\*float64" "$ROOT/exporter/internal/collector/collector.go"
run "exporter: metrics-mapping unit test exists" test -f "$ROOT/exporter/internal/collector/collector_test.go"
run "exporter: executive-brief unit test exists" test -f "$ROOT/exporter/main_test.go"
run "grafana: Contracts & Money dashboard provisioned" test -f "$ROOT/deploy/grafana/provisioning/dashboards/sentinel-contracts-money.json"
run "grafana: dashboard #2 is valid JSON + per-tenant" node -e '
const d = require("'"$ROOT"'/deploy/grafana/provisioning/dashboards/sentinel-contracts-money.json");
if (d.uid !== "sentinel-contracts-money") process.exit(1);
if (!d.templating.list.some(v => v.name === "tenant")) process.exit(1);
if (!JSON.stringify(d.panels).includes("sentinel_tenant_penalty_tomans_total")) process.exit(1);
if (!JSON.stringify(d.panels).includes("sentinel_outbox_depth")) process.exit(1);
'
run "grafana: exporter metric names match dashboard #2" node -e '
const fs = require("fs");
const dash = JSON.parse(fs.readFileSync("'"$ROOT"'/deploy/grafana/provisioning/dashboards/sentinel-contracts-money.json","utf8"));
const col = fs.readFileSync("'"$ROOT"'/exporter/internal/collector/collector.go","utf8");
const names = [...new Set([...JSON.stringify(dash).matchAll(/sentinel_[a-z_]+/g)].map(m => m[0]))];
const missing = names.filter(n => !col.includes("\"" + n + "\"") && !col.includes("ns+\"" + n.slice("sentinel".length) + "\""));
if (missing.length) { console.error("metrics in dashboard missing from exporter:", missing.join(", ")); process.exit(1); }
'
run "grafana: provider loads the whole folder" grep -q "path: /etc/grafana/provisioning/dashboards" "$ROOT/deploy/grafana/provisioning/dashboards/dashboards-provider.yml"

# ── 13. Notification outbox invariants ─────────────────────────────
header "Notification outbox"
run "notify: outbox table in schema" grep -q "model NotificationOutbox" "$ROOT/prisma/schema.prisma"
run "notify: delivery log table in schema" grep -q "model DeliveryLog" "$ROOT/prisma/schema.prisma"
run "notify: channel secret column" grep -q "secret         String?" "$ROOT/prisma/schema.prisma"
run "notify: rule quiet-hours columns" grep -q "quietStartMin Int?" "$ROOT/prisma/schema.prisma"
run "notify: postgres schema derived in sync" grep -q "model NotificationOutbox" "$ROOT/prisma/schema.postgres.prisma"
run "notify: bilingual templates module" grep -q "executive → formal FA" "$ROOT/src/server/notify/templates.ts"
run "notify: pure policy module (backoff/dead/quiet/ack)" test -f "$ROOT/src/server/notify/policy.ts"
run "notify: adapters for 5 transports" test "$(grep -c "case '" "$ROOT/src/server/notify/adapters.ts")" -ge 5
run "notify: webhook HMAC signature header" grep -q "x-sentinel-signature" "$ROOT/src/server/notify/adapters.ts"
run "notify: SMTP payload ends with RFC 5321 terminator" grep -q "CRLF.CRLF" "$ROOT/src/server/notify/adapters.ts"
run "notify: bot ack button rides on detection pages" grep -q "buildAckKeyboard" "$ROOT/src/server/notify/adapters.ts"
run "notify: outbox emit + dispatch surface" grep -q "export async function emitNotification" "$ROOT/src/server/notify/outbox.ts"
run "notify: dispatcher uses exponential backoff" grep -q "30_000 \* 2 \*\*" "$ROOT/src/server/notify/outbox.ts"
run "notify: dispatcher prunes delivered history" grep -q "DELETE FROM NotificationOutbox" "$ROOT/src/server/notify/outbox.ts"
run "notify: test-send targets one channel directly" grep -q "export async function sendTestMessage" "$ROOT/src/server/notify/outbox.ts"
run "notify: alerts.ts routes through the outbox" grep -q "emitNotification" "$ROOT/src/server/alerts.ts"
run "notify: engine rule fires go through the outbox" grep -q "emitNotification" "$ROOT/src/server/engine.ts"
run "notify: dashboard exposes outboxDepth + outboxDead" grep -q "outboxDepth: outboxCounts.depth" "$ROOT/src/server/engine.ts"
run "notify: engine starts the dispatcher with its loops" grep -q "startOutboxDispatcher" "$ROOT/src/server/engine.ts"
run "notify: worker runs the dispatcher in live mode" grep -q "startOutboxDispatcher" "$ROOT/src/worker/index.ts"
run "notify: channels PATCH (edit) route" grep -q "export async function PATCH" "$ROOT/src/app/api/channels/[id]/route.ts"
run "notify: test-send goes through the real outbox path" grep -q "sendTestMessage" "$ROOT/src/server/alertgovernance.ts"
run "notify: bale is a first-class channel kind" grep -q "'telegram', 'bale', 'webhook', 'email'" "$ROOT/src/server/validation.ts"
run "notify: channel update schema exists" grep -q "updateChannelSchema" "$ROOT/src/server/validation.ts"
run "notify: templates preview API (authed read)" grep -q "requireUser(req)" "$ROOT/src/app/api/notifications/templates/route.ts"
run "notify: delivery log API (authed read)" grep -q "requireUser(req)" "$ROOT/src/app/api/notifications/delivery/route.ts"
run "notify: outbox API + admin dead-letter retry" grep -q "requireRole(req, 'admin')" "$ROOT/src/app/api/notifications/outbox/route.ts"
run "notify: /ack signed-link page is public" grep -q "'/ack'" "$ROOT/src/proxy.ts"
run "notify: /ack verifies the HMAC token" grep -q "verifyAckToken" "$ROOT/src/app/ack/route.ts"
run "notify: telegram callback is secret-gated" grep -q "x-telegram-bot-api-secret-token" "$ROOT/src/app/api/integrations/telegram/callback/route.ts"
run "notify: callback acknowledges via the signed token" grep -q "parseAckCallbackData" "$ROOT/src/app/api/integrations/telegram/callback/route.ts"
run "notify: integrations notify API is admin-gated" grep -q "requireRole(req, 'admin')" "$ROOT/src/app/api/integrations/notify/route.ts"
run "notify: notify secret changes are audit-logged" grep -q "integration.notify.updated" "$ROOT/src/app/api/integrations/notify/route.ts"
run "notify: exporter emits the dead-letter metric" grep -q "outbox_dead_total" "$ROOT/exporter/internal/collector/collector.go"
run "notify: env example documents the transport knobs" grep -q "SENTINEL_NOTIFY_TRANSPORT" "$ROOT/.env.example"
run "notify: unit tests cover the dispatcher policy" test -f "$ROOT/tests/unit/notify-outbox.test.ts"
run "notify: unit tests cover the adapters against mock servers" test -f "$ROOT/tests/unit/notify-adapters.test.ts"

# ── 14. Digest + channel-page invariants ───────────────
header "Digest + channel page"
run "digest: scheduler module exists" test -f "$ROOT/src/server/notify/digest.ts"
run "digest: pure due/window math" grep -q "export function digestDueInstant" "$ROOT/src/server/notify/digest.ts"
run "digest: catch-up-once semantics" grep -q "withSchedulerLock('digest-scheduler'" "$ROOT/src/server/notify/digest.ts"
run "digest: config defaults to off" grep -q "frequency: 'off'" "$ROOT/src/server/notify/digest.ts"
run "digest: money summary from the incident ledger" grep -q "SUM(revenueLossTomans)" "$ROOT/src/server/notify/digest.ts"
run "digest: executive audience only" grep -q "audiences: \['executive'\]" "$ROOT/src/server/notify/digest.ts"
run "digest: engine tick fires due digests" grep -q "runDueDigests" "$ROOT/src/server/engine.ts"
run "digest: engine starts the scheduler with its loops" grep -q "startDigestScheduler" "$ROOT/src/server/engine.ts"
run "digest: worker runs the scheduler in live mode" grep -q "runDueDigests" "$ROOT/src/worker/index.ts"
run "digest: admin API exists" test -f "$ROOT/src/app/api/integrations/digest/route.ts"
run "digest: API is admin-gated" test "$(grep -c "requireRole(req, 'admin')" "$ROOT/src/app/api/integrations/digest/route.ts")" -ge 3
run "digest: config changes audit-logged" grep -q "integration.digest.updated" "$ROOT/src/app/api/integrations/digest/route.ts"
run "digest: run-now is audit-logged" grep -q "integration.digest.run_now" "$ROOT/src/app/api/integrations/digest/route.ts"
run "digest: PDF attach in the dispatcher for bot channels" grep -q "primary.topic === 'digest'" "$ROOT/src/server/notify/outbox.ts"
run "digest: newest archived report lookup" grep -q "export async function latestReportDocument" "$ROOT/src/server/notify/outbox.ts"
run "digest: sendDocument multipart adapter" grep -q "export async function botApiSendDocument" "$ROOT/src/server/notify/adapters.ts"
run "digest: Bot API caption limit respected" grep -q "slice(0, 1024)" "$ROOT/src/server/notify/adapters.ts"
run "digest: unit tests cover the scheduler" test -f "$ROOT/tests/unit/notify-digest.test.ts"
run "channel-page: notifications settings page exists" test -f "$ROOT/src/app/settings/notifications/page.tsx"
run "channel-page: reachable from the alerting nav" grep -q "alerting.nav.channels" "$ROOT/src/components/sentinel/app-shell.tsx"
run "channel-page: test-send route exists" test -f "$ROOT/src/app/api/channels/[id]/test/route.ts"
run "channel-page: test-send is engineer-gated" grep -q "requireRole(req, 'engineer')" "$ROOT/src/app/api/channels/[id]/test/route.ts"
run "channel-page: template preview component" test -f "$ROOT/src/components/sentinel/template-preview.tsx"
run "channel-page: bilingual keys present" test "$(cat "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts" | grep -c "settings.notif.")" -ge 100
run "gitignore: route files named test/ stay tracked" bash -c 'cd "$0" && git ls-files --error-unmatch "src/app/api/integrations/prometheus/test/route.ts" >/dev/null 2>&1 && git ls-files --error-unmatch "src/app/api/channels/[id]/test/route.ts" >/dev/null 2>&1' "$ROOT"

# ── Resilience / self-test / chaos hooks / load test ───────────────
header "Resilience, self-test, chaos hooks"
run "selftest: module exists" test -f "$ROOT/src/server/resilience/selftest.ts"
run "selftest: 60s gate constant is pinned" grep -q "SELFTEST_GATE_SEC = 60" "$ROOT/src/server/resilience/selftest.ts"
run "selftest: synthetic target key defined" grep -q "SELFTEST_SERVICE_KEY = 'selftest-synthetic'" "$ROOT/src/server/resilience/selftest.ts"
run "selftest: schema model in the sqlite schema" grep -q "model SelfTestRun" "$ROOT/prisma/schema.prisma"
run "selftest: schema model in the postgres schema" grep -q "model SelfTestRun" "$ROOT/prisma/schema.postgres.prisma"
run "selftest: engine starts the scheduler with its loops" grep -q "startSelfTestScheduler" "$ROOT/src/server/engine.ts"
run "selftest: engine stops it on shutdown" grep -q "stopSelfTestScheduler" "$ROOT/src/server/engine.ts"
run "selftest: worker runs the scheduler in live mode" grep -q "runDueSelfTests" "$ROOT/src/worker/index.ts"
run "selftest: run-now API exists" test -f "$ROOT/src/app/api/resilience/route.ts"
run "selftest: API GET is authed" grep -q "requireUser(req)" "$ROOT/src/app/api/resilience/route.ts"
run "selftest: API PUT is admin-gated" grep -q "requireRole(req, 'admin')" "$ROOT/src/app/api/resilience/route.ts"
run "selftest: API POST is engineer-gated" grep -q "requireRole(req, 'engineer')" "$ROOT/src/app/api/resilience/route.ts"
run "selftest: run-now is audit-logged" grep -q "resilience.selftest.run_now" "$ROOT/src/app/api/resilience/route.ts"
run "selftest: schedule changes audit-logged" grep -q "resilience.selftest.updated" "$ROOT/src/app/api/resilience/route.ts"
run "selftest: /resilience page exists" test -f "$ROOT/src/app/resilience/page.tsx"
run "selftest: page wired into the settings nav" grep -q "'/resilience'" "$ROOT/src/components/sentinel/settings-nav.tsx"
run "selftest: bilingual keys present" test "$(cat "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts" | grep -c "resilience\.")" -ge 80
run "selftest: failure alert template EN" grep -q "SELF-TEST FAILED" "$ROOT/src/server/notify/templates.ts"
run "selftest: failure alert template FA" grep -q "شکست خودسنجی" "$ROOT/src/server/notify/templates.ts"
run "selftest: catalog exposes the template" grep -q "{ topic: 'selftest', severity: 'critical' }" "$ROOT/src/server/notify/templates.ts"
run "selftest: synthetic probe kind in validation union" grep -q "kind: z.literal('synthetic')" "$ROOT/src/server/validation.ts"
run "selftest: synthetic probe branch in the ingestion loop" grep -q "sentinel:selftest-synthetic" "$ROOT/src/server/ingestion.ts"
run "selftest: synthetic target excluded from spontaneous simulation" grep -q "SELFTEST_SERVICE_KEY) return 'up'" "$ROOT/src/server/engine.ts"
run "selftest: auto-chaos is demo-only in live mode" grep -q "mode === 'live'" "$ROOT/src/server/engine.ts"
run "selftest: proof script exists" test -f "$ROOT/scripts/resilience-proof.mjs"
run "chaos-hook: hook fields on Service (sqlite)" grep -q "chaosHookUrl" "$ROOT/prisma/schema.prisma"
run "chaos-hook: hook fields on Service (postgres)" grep -q "chaosHookUrl" "$ROOT/prisma/schema.postgres.prisma"
run "chaos-hook: dispatcher module exists" test -f "$ROOT/src/server/resilience/chaoshook.ts"
run "chaos-hook: HMAC signature on hook payloads" grep -q "X-Sentinel-Chaos-Signature" "$ROOT/src/server/resilience/chaoshook.ts"
run "chaos-hook: live chaos refuses un-hooked services" grep -q "chaos-hook-not-configured" "$ROOT/src/server/resilience/chaoshook.ts"
run "chaos-hook: engine routes live chaos through the hook" grep -q "launchLiveChaos" "$ROOT/src/server/engine.ts"
run "chaos-hook: live experiments finalize on incident resolve" grep -q "finalizeLiveChaosExperiment" "$ROOT/src/server/resilience/chaoshook.ts"
run "load: test script accepts a bearer token" grep -q '\-\-token' "$ROOT/tests/load/load_test.py"
run "load: token minting script exists" test -f "$ROOT/scripts/mint-loadtest-token.mjs"
run "load: proxy pre-filter lets machine auth through" grep -q "hasBearer" "$ROOT/src/proxy.ts"
run "failure-modes: drill script present and valid" bash -n "$ROOT/tests/failure-modes/failure_modes.sh"

# ── /contracts page invariants ────────────────────────────────────
header "contracts view"
run "contracts: pure math module exists" test -f "$ROOT/src/server/contracts.ts"
run "contracts: Jalali window derives from the jalali core" grep -q "jalaliMonthWindow" "$ROOT/src/server/contracts.ts"
run "contracts: penalty uses the pure domain rule" grep -q "penaltyFixedPerMinute" "$ROOT/src/server/contracts.ts"
run "contracts: ledger values for contained incidents" grep -q "penaltyTomans" "$ROOT/src/server/contracts.ts"
run "contracts: projection guard (5 % elapsed)" grep -q "minFraction = 0.05" "$ROOT/src/server/contracts.ts"
run "contracts: API route exists" test -f "$ROOT/src/app/api/contracts/route.ts"
run "contracts: API authed" grep -q "requireUser(req)" "$ROOT/src/app/api/contracts/route.ts"
run "contracts: API tenant-scoped" grep -q "resolveTenantScope" "$ROOT/src/app/api/contracts/route.ts"
run "contracts: page route exists" test -f "$ROOT/src/app/contracts/page.tsx"
run "contracts: client wired to the hook" grep -q "useContracts" "$ROOT/src/components/sentinel/contracts-client.tsx"
run "contracts: money figures use MoneyValue" grep -q "MoneyValue" "$ROOT/src/components/sentinel/contracts-client.tsx"
run "contracts: FormulaPopover on money + percent" grep -q "FormulaPopover" "$ROOT/src/components/sentinel/contracts-client.tsx"
run "contracts: DataTable engine reused" grep -q "DataTable" "$ROOT/src/components/sentinel/contracts-client.tsx"
run "contracts: nav entry present" grep -q "'/contracts'" "$ROOT/src/components/sentinel/app-shell.tsx"
run "contracts: palette entry + g c shortcut" grep -q "'g', 'c'" "$ROOT/src/components/sentinel/command-palette-data.tsx"
run "contracts: bilingual keys EN" grep -q "'page.contracts.title': 'Client contracts'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"
run "contracts: bilingual keys FA" grep -q "'page.contracts.title': 'قراردادهای مشتریان'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"
run "contracts: unit tests exist" test -f "$ROOT/tests/unit/contracts-view.test.ts"

# ── /incidents/[id] detail route invariants ───────────────────────
header "incident detail route"
run "incident-detail: detail API exists" test -f "$ROOT/src/app/api/incidents/[id]/route.ts"
run "incident-detail: API authed" grep -q "requireUser(req)" "$ROOT/src/app/api/incidents/[id]/route.ts"
run "incident-detail: API tenant-scoped via owning service" grep -q "resolveTenantScope" "$ROOT/src/app/api/incidents/[id]/route.ts"
run "incident-detail: missing id is an honest 404" grep -q "Incident not found" "$ROOT/src/app/api/incidents/[id]/route.ts"
run "incident-detail: payload carries evidence + related" grep -q "IncidentDetailDTO" "$ROOT/src/lib/types.ts"
run "incident-detail: page route exists" test -f "$ROOT/src/app/incidents/[id]/page.tsx"
run "incident-detail: page auth-gated" grep -q "resolveSessionUserFromCookies" "$ROOT/src/app/incidents/[id]/page.tsx"
run "incident-detail: shared parts extracted (dialog + page)" test -f "$ROOT/src/components/sentinel/incident-detail-parts.tsx"
run "incident-detail: dialog composes the shared parts" grep -q "incident-detail-parts" "$ROOT/src/components/sentinel/incident-detail-dialog.tsx"
run "incident-detail: client uses the detail hook" grep -q "useIncidentDetail" "$ROOT/src/components/sentinel/incident-detail-client.tsx"
run "incident-detail: evidence panel on the page" grep -q "incd.evidence.title" "$ROOT/src/components/sentinel/incident-detail-client.tsx"
run "incident-detail: related incidents link between pages" grep -q '/incidents/\${rel.id}' "$ROOT/src/components/sentinel/incident-detail-client.tsx"
run "incident-detail: ack/resolve gated to operator roles" grep -q "OPERATOR_ROLES" "$ROOT/src/components/sentinel/incident-detail-client.tsx"
run "incident-detail: dialog links to the full page" grep -q "incd.openFullPage" "$ROOT/src/components/sentinel/incident-detail-dialog.tsx"
run "incident-detail: palette navigates to detail pages" grep -q '/incidents/\${encodeURIComponent(inc.id)}' "$ROOT/src/components/sentinel/command-dialog.tsx"
run "incident-detail: mutations invalidate the detail cache" grep -q "INCIDENT_DETAIL_KEY" "$ROOT/src/hooks/use-sentinel.ts"
run "incident-detail: bilingual keys EN" grep -q "'incd.notFound.title': 'Incident not found'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"
run "incident-detail: bilingual keys FA" grep -q "'incd.notFound.title': 'اختلال یافت نشد'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"

# ── /services/[key] detail route invariants ───────────────────────
header "service detail route"
run "service-detail: detail API exists" test -f "$ROOT/src/app/api/services/[key]/route.ts"
run "service-detail: API authed" grep -q "requireUser(req)" "$ROOT/src/app/api/services/[key]/route.ts"
run "service-detail: API tenant-scoped via owning tenant" grep -q "resolveTenantScope" "$ROOT/src/app/api/services/[key]/route.ts"
run "service-detail: missing key is an honest 404" grep -q "Service not found" "$ROOT/src/app/api/services/[key]/route.ts"
run "service-detail: contract row reuses the /contracts math" grep -q "getServiceContractRow" "$ROOT/src/app/api/services/[key]/route.ts"
run "service-detail: contract helper delegates to buildContractRows" grep -q "buildContractRows" "$ROOT/src/server/contracts.ts"
run "service-detail: payload carries evidence + chaos" grep -q "ServiceDetailDTO" "$ROOT/src/lib/types.ts"
run "service-detail: page route exists" test -f "$ROOT/src/app/services/[key]/page.tsx"
run "service-detail: page auth-gated" grep -q "resolveSessionUserFromCookies" "$ROOT/src/app/services/[key]/page.tsx"
run "service-detail: client uses the detail hook" grep -q "useServiceDetail" "$ROOT/src/components/sentinel/service-detail-client.tsx"
run "service-detail: contract card with compliance chip" grep -q "contracts.compliance" "$ROOT/src/components/sentinel/service-detail-client.tsx"
run "service-detail: money popovers on availability + penalty" grep -q "FormulaPopover" "$ROOT/src/components/sentinel/service-detail-client.tsx"
run "service-detail: incidents link into detail pages" grep -q '/incidents/\${inc.id}' "$ROOT/src/components/sentinel/service-detail-client.tsx"
run "service-detail: palette navigates to detail pages" grep -q '/services/\${encodeURIComponent(s.key)}' "$ROOT/src/components/sentinel/command-dialog.tsx"
run "service-detail: service dialog links to the full page" grep -q "svcd.openFullPageAria" "$ROOT/src/components/sentinel/incident-detail-dialog.tsx"
run "service-detail: services client chains incident dialog (bug fixed)" grep -q "setSelectedIncident" "$ROOT/src/components/sentinel/services-client.tsx"
run "service-detail: mutations invalidate the detail cache" grep -q "SERVICE_DETAIL_KEY" "$ROOT/src/hooks/use-sentinel.ts"
run "service-detail: bilingual keys EN" grep -q "'svcd.notFound.title': 'Service not found'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"
run "service-detail: bilingual keys FA" grep -q "'svcd.notFound.title': 'سرویس یافت نشد'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"

# ── /alerting/* IA consolidation invariants ──────────────────
header "alerting IA"
run "alerting: channels page exists" test -f "$ROOT/src/app/alerting/channels/page.tsx"
run "alerting: rules page exists" test -f "$ROOT/src/app/alerting/rules/page.tsx"
run "alerting: oncall page exists" test -f "$ROOT/src/app/alerting/oncall/page.tsx"
run "alerting: maintenance page exists" test -f "$ROOT/src/app/alerting/maintenance/page.tsx"
run "alerting: index redirects to channels" grep -q "redirect('/alerting/channels')" "$ROOT/src/app/alerting/page.tsx"
run "alerting: all pages auth-gated" test "$(grep -l resolveSessionUserFromCookies "$ROOT"/src/app/alerting/*/page.tsx | wc -l)" -eq 4
run "alerting: legacy settings route redirects" grep -q "redirect('/alerting/channels')" "$ROOT/src/app/settings/notifications/page.tsx"
run "alerting: notifications body is a shared parts module" grep -q "export function NotificationsBody" "$ROOT/src/components/sentinel/alerting/notifications-parts.tsx"
run "alerting: parts module exports all four cards" test "$(grep -c '^export function \(Digest\|Channels\|DeliveryLog\|Outbox\)Card' "$ROOT/src/components/sentinel/alerting/notifications-parts.tsx")" -eq 4
run "alerting: sub-nav covers the four routes" test "$(grep -c "href: '/alerting/" "$ROOT/src/components/sentinel/alerting/alerting-nav.tsx")" -eq 4
run "alerting: app-shell has the alerting group" grep -q "nav.group.alerting" "$ROOT/src/components/sentinel/app-shell.tsx"
run "alerting: app-shell drops the settings notifications item" test "$(grep -c "'/settings/notifications'" "$ROOT/src/components/sentinel/app-shell.tsx")" -eq 0
run "alerting: palette lists the alerting pages" test "$(grep -c "href: '/alerting/" "$ROOT/src/components/sentinel/command-palette-data.tsx")" -eq 4
run "alerting: settings-nav drops notifications" test "$(grep -c "notifications" "$ROOT/src/components/sentinel/settings-nav.tsx")" -eq 0
run "alerting: rules page uses the DataTable engine" grep -q "DataTable" "$ROOT/src/components/sentinel/alerting/rules-client.tsx"
run "alerting: rules page reuses the gov.rules vocabulary" grep -q "gov.rules" "$ROOT/src/components/sentinel/alerting/rules-client.tsx"
run "alerting: rules toggle via the shared hook" grep -q "useToggleAlertRule" "$ROOT/src/components/sentinel/alerting/rules-client.tsx"
run "alerting: rules delete confirm names the object" grep -q "gov.rules.deleteConfirmTitle" "$ROOT/src/components/sentinel/alerting/rules-client.tsx"
run "alerting: oncall page wires rotation + escalation" grep -q "useCreateOnCall" "$ROOT/src/components/sentinel/alerting/oncall-client.tsx"
run "alerting: escalation editor saves via the shared hook" grep -q "useUpdateEscalationPolicy" "$ROOT/src/components/sentinel/alerting/oncall-client.tsx"
run "alerting: maintenance page reuses the shared panel" grep -q "MaintenancePanel" "$ROOT/src/components/sentinel/alerting/maintenance-client.tsx"
run "alerting: panel accepts the optional refresh hook" grep -q "onChanged" "$ROOT/src/components/sentinel/maintenance-panel.tsx"
run "alerting: quiet-hours display from real DTO minutes" grep -q "quietStartMin" "$ROOT/src/components/sentinel/alerting/rules-client.tsx"
run "alerting: bilingual nav keys EN" grep -q "'alerting.nav.channels': 'Channels'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"
run "alerting: bilingual nav keys FA" grep -q "'alerting.nav.channels': 'کانال‌ها'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"
run "alerting: sub-nav labels are translated (not raw keys)" grep -q "{t(item.label)}" "$ROOT/src/components/sentinel/alerting/alerting-nav.tsx"

# ── StatCard + TimeRange binding components ───────────
header "statcard + timerange"
run "stat: StatCard binding component exists" test -f "$ROOT/src/components/sentinel/stat-card.tsx"
run "stat: delta, spark and explain props present" test "$(grep -c 'delta?: StatDelta\|spark?: readonly number\[\]\|explain?: StatExplain' "$ROOT/src/components/sentinel/stat-card.tsx")" -eq 3
run "stat: explain popover reuses FormulaPopover" grep -q "FormulaPopover" "$ROOT/src/components/sentinel/stat-card.tsx"
run "stat: KpiCard delegates to StatCard" grep -q "StatCard" "$ROOT/src/components/sentinel/kpi-card.tsx"
run "stat: KpiCard keeps its historical API" grep -q "value: React.ReactNode" "$ROOT/src/components/sentinel/kpi-card.tsx"
run "stat: delta core lives in the unit-tested lib" grep -q "deltaLabel" "$ROOT/src/lib/stat-range.ts"
run "stat: unit tests pin the delta sign contract" test -f "$ROOT/tests/unit/stat-range.test.ts"
run "range: TimeRange binding component exists" test -f "$ROOT/src/components/sentinel/time-range.tsx"
run "range: four presets plus custom" test "$(grep -c "'1h'\|'24h'\|'7d'\|'30d'" "$ROOT/src/lib/stat-range.ts")" -ge 4
run "range: custom consumes the shared JalaliDatePicker" grep -q "JalaliDatePicker" "$ROOT/src/components/sentinel/time-range.tsx"
run "range: range core lives in the unit-tested lib" grep -q "export function resolveRange" "$ROOT/src/lib/stat-range.ts"
run "range: picked To day widened to be inclusive" grep -q "endOfDay" "$ROOT/src/components/sentinel/time-range.tsx"
run "range: presets rendered as aria-pressed buttons" grep -q "aria-pressed" "$ROOT/src/components/sentinel/time-range.tsx"
run "range: incidents page is the first consumer" grep -q "TimeRange value={range}" "$ROOT/src/components/sentinel/incidents-client.tsx"
run "range: incidents page filters via resolveRange" grep -q "resolveRange(range)" "$ROOT/src/components/sentinel/incidents-client.tsx"
run "range: API accepts since/until bounds" grep -q "since" "$ROOT/src/server/validation.ts"
run "range: API applies the startedAt filter" grep -q "startedAt: {" "$ROOT/src/app/api/incidents/route.ts"
run "range: bilingual keys EN" grep -q "'timeRange.30d': 'Last 30d'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"
run "range: bilingual keys FA" grep -q "'timeRange.30d': '۳۰ روز گذشته'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"
run "range: picker honours the calendar preference" grep -q "useCalendarPref" "$ROOT/src/components/sentinel/jalali-date-picker.tsx"
run "range: calendar pref hook exported from date-text" grep -q "export function useCalendarPref" "$ROOT/src/components/sentinel/date-text.tsx"
run "range: stat sparkline has an accessible name" grep -q "'stat.sparkAlt'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"
run "stat: executive trend card consumes StatCard directly" grep -q "StatCard" "$ROOT/src/components/sentinel/penalty-trend-card.tsx"
run "stat: trend card spark is the real hourly penalty series" grep -q "p.penaltyTomans" "$ROOT/src/components/sentinel/penalty-trend-card.tsx"
run "stat: trend delta is honest (last vs previous bucket)" grep -q "prev.penaltyTomans" "$ROOT/src/components/sentinel/penalty-trend-card.tsx"
run "stat: trend card hides when analytics is absent" grep -q "if (!analytics || analytics.trends.length === 0) return null" "$ROOT/src/components/sentinel/penalty-trend-card.tsx"
run "stat: bilingual trend keys EN" grep -q "'fin.trend.label': 'SLA penalties — display window'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"
run "stat: bilingual trend keys FA" grep -q "'fin.trend.label': 'جریمه‌های SLA — بازهٔ نمایش'" "$ROOT/src/lib/i18n/en.ts" "$ROOT/src/lib/i18n/fa.ts"


# ── raw-SQL DateTime storage normalization (journey-suite find) ────
header "raw-sql datetime storage"
# DateTimes must travel through JS Date bound params so the ORM normalizes
# them to its native storage; ISO strings become TEXT rows that never match
# integer-normalized comparisons (the planned-window bug).
run "dtstore: maintenance writes Date objects" test "$(grep -c 'now.toISOString()\|startAt.toISOString()' "$ROOT/src/server/maintenance.ts")" -eq 0
run "dtstore: expiry compares via a Date param" grep -q "endAt <= \${now}" "$ROOT/src/server/maintenance.ts"
run "dtstore: active-window query uses a Date param" grep -q "m.endAt > \${now}" "$ROOT/src/server/maintenance.ts"
run "dtstore: escalation writes Date objects" bash -c "grep -q 'lastEscalatedAt = \${now}' '$ROOT/src/server/escalation.ts' && ! grep -q 'lastEscalatedAt = \${.*toISOString' '$ROOT/src/server/escalation.ts'"
run "dtstore: tenants write Date objects" test "$(grep -c 'toISOString()' "$ROOT/src/server/tenants.ts")" -eq 0
run "dtstore: alertgovernance writes Date objects" test "$(grep -c 'now = new Date().toISOString()' "$ROOT/src/server/alertgovernance.ts")" -eq 0
run "dtstore: reportscheduling writes Date objects" test "$(grep -c 'lastRunAt = \${new Date(report.generatedAt).toISOString()}' "$ROOT/src/server/reportscheduling.ts")" -eq 0
run "dtstore: fixup script exists and is idempotent-by-construction" grep -q "typeof" "$ROOT/scripts/fix-datetime-storage.cjs"
run "dtstore: journeys cover the maintenance contract note" grep -q "plannedWindows" "$ROOT/tests/e2e/journeys.spec.ts"
run "dtstore: journeys suite covers all 10 core journeys" test "$(grep -c "^test('J\|journey 6\|journey 8" "$ROOT/tests/e2e/journeys.spec.ts")" -ge 10

# ── report service (WeasyPrint pipeline) ──────────────────────
header "report service"
run "reports: weasy renderer exists and drives weasyprint" bash -c "grep -q 'from weasyprint import HTML' '$ROOT/reports/render_weasy.py'"
run "reports: renderer refuses missing input and empty output" grep -q "input HTML not found" "$ROOT/reports/render_weasy.py"
run "reports: config exposes reportWeasyScript default" grep -q "reportWeasyScript" "$ROOT/src/server/config.ts"
run "reports: render bridge validates REPORT_PYTHON with a named error" grep -q "set REPORT_PYTHON" "$ROOT/src/server/reports/render.ts"
run "reports: report file names keep the digest-attach prefix for executive" grep -q "sentinel-sla-report" "$ROOT/src/server/reports/render.ts"
run "reports: snapshot hash is sha256 over canonical json" grep -q "createHash('sha256')" "$ROOT/src/server/reports/snapshot.ts"
run "reports: snapshots exclude generation metadata from the hash" grep -q "hash pins the data" "$ROOT/src/server/reports/snapshot.ts"
run "reports: schema carries kind/language on SlaReport" grep -q "kind         String   @default(\"executive\")" "$ROOT/prisma/schema.prisma"
run "reports: schema carries the snapshot hash + params" grep -q "snapshotHash String   @default(\"\")" "$ROOT/prisma/schema.prisma"
run "reports: schema carries kind/language on ReportSchedule" bash -c "grep -q 'kind        String    @default(\"executive\") // executive | statement | incident' '$ROOT/prisma/schema.prisma'"
run "reports: templates render rtl for fa" grep -q "dir=\"rtl\"" "$ROOT/src/server/reports/templates.ts"
run "reports: fa page numbers use the persian counter style" grep -q "counter(page, persian)" "$ROOT/src/server/reports/templates.ts"
run "reports: bundled woff2 fonts referenced (portable, offline)" grep -q "public/fonts/vazirmatn-arabic-wght-normal.woff2" "$ROOT/src/server/reports/templates.ts"
run "reports: statement template has the signature block" grep -q "signSignature" "$ROOT/src/server/reports/templates.ts"
run "reports: incident template has the formula appendix" grep -q "formulaTitle" "$ROOT/src/server/reports/templates.ts"
run "reports: executive trend chart is server-side svg" grep -q "trendSvg" "$ROOT/src/server/reports/templates.ts"
run "reports: hypotheses are localized via keys, not raw english" grep -q "hypothesisLine" "$ROOT/src/server/reports/templates.ts"
run "reports: timeline events localized (raw keys never leak)" grep -q "eventLabel" "$ROOT/src/server/reports/templates.ts"
run "reports: statement requires a tenant" grep -q "kind=statement requires tenantId" "$ROOT/src/app/api/reports/route.ts"
run "reports: incident requires incidentId" grep -q "kind=incident requires incidentId" "$ROOT/src/app/api/reports/route.ts"
run "reports: generation is audit-logged" grep -q "action: 'report.generate'" "$ROOT/src/app/api/reports/route.ts"
run "reports: downloads are audit-logged" grep -q "action: 'report.download'" "$ROOT/src/app/api/reports/[id]/download/route.ts"
run "reports: regenerate route is audit-logged + executive floor" bash -c "grep -q \"action: 'report.regenerate'\" '$ROOT/src/app/api/reports/[id]/regenerate/route.ts' && grep -q \"requireRole(req, 'executive')\" '$ROOT/src/app/api/reports/[id]/regenerate/route.ts'"
run "reports: regenerate never overwrites history (new row)" grep -q "history is never overwritten" "$ROOT/src/server/reportgen.ts"
run "reports: scheduler passes kind/language through" grep -q "generatedByName: \`schedule: " "$ROOT/src/server/reportscheduling.ts"
run "reports: statement schedules require a tenant scope" grep -q "statement schedules require tenantId" "$ROOT/src/server/reportscheduling.ts"
run "reports: bilingual report UI keys EN" bash -c "grep -q \"'reports.kind.executive': 'Executive monthly'\" '$ROOT/src/lib/i18n/en.ts' '$ROOT/src/lib/i18n/fa.ts' && grep -q \"'reports.regenerate': 'Regenerate'\" '$ROOT/src/lib/i18n/en.ts' '$ROOT/src/lib/i18n/fa.ts'"
run "reports: bilingual report UI keys FA" bash -c "grep -q \"'reports.kind.executive': 'ماهانه مدیران'\" '$ROOT/src/lib/i18n/en.ts' '$ROOT/src/lib/i18n/fa.ts' && grep -q \"'reports.regenerate': 'بازتولید'\" '$ROOT/src/lib/i18n/en.ts' '$ROOT/src/lib/i18n/fa.ts'"
run "reports: openapi documents the regenerate endpoint" grep -q "regenerateReport" "$ROOT/openapi/openapi.yaml"
run "reports: openapi GenerateReportPayload carries kind/language" grep -q "enum: \[executive, statement, incident\]" "$ROOT/openapi/openapi.yaml"
run "reports: unit tests pin the snapshot + template invariants" test -f "$ROOT/tests/unit/reports.test.ts"



# ── visual-regression harness + schedules kind/language ─
header "visual regression + schedules wiring"
run "reports: pixel-diff tool exists with tolerance budget" grep -q "budget" "$ROOT/scripts/report-pixel-diff.py"
run "reports: harness renders through the REAL weasy pipeline" grep -q "reportWeasyScript" "$ROOT/scripts/report-visual-regression.ts"
run "reports: harness uses frozen fixtures (deterministic input)" grep -q "report-snapshots" "$ROOT/scripts/report-visual-regression.ts"
run "reports: baselines exist for all 6 combos" test "$(ls "$ROOT/tests/visual/reports-baseline"/*-page1.png 2>/dev/null | wc -l)" -eq 6
run "reports: unit tests import the shared fixture module" grep -q "fixtures/report-snapshots" "$ROOT/tests/unit/reports.test.ts"
run "reports: npm script wires the visual check" grep -q "report-visual-regression" "$ROOT/package.json"
run "reports: schedules create dialog carries kind" bash -c "grep -q \"setKind(v as 'executive' | 'statement')\" \"$ROOT/src/components/sentinel/schedules-card.tsx\" && grep -q 'sched.kindLabel' \"$ROOT/src/lib/i18n/en.ts\" \"$ROOT/src/lib/i18n/fa.ts\""
run "reports: schedules create dialog carries language" bash -c "grep -q \"setLang(v as 'en' | 'fa')\" \"$ROOT/src/components/sentinel/schedules-card.tsx\" && grep -q 'sched.langLabel' \"$ROOT/src/lib/i18n/en.ts\" \"$ROOT/src/lib/i18n/fa.ts\""
run "reports: statement schedules blocked fleet-side in the UI" grep -q "sched.kindNeedsTenant" "$ROOT/src/components/sentinel/schedules-card.tsx"
run "reports: schedule rows show kind + language chips" bash -c "grep -q \"schedule.kind === 'statement'\" '$ROOT/src/components/sentinel/schedules-card.tsx' && grep -q \"schedule.language === 'fa'\" '$ROOT/src/components/sentinel/schedules-card.tsx'"

run "reports: schedule create schema accepts kind/language" bash -c "grep -q \"kind: z.enum(\\['executive', 'statement'\\])\" '$ROOT/src/server/validation.ts' && grep -q \"language: z.enum(\\['en', 'fa'\\])\" '$ROOT/src/server/validation.ts'"
run "reports: schema refines statement schedules need a tenant" grep -q "kind=statement schedules require tenantId" "$ROOT/src/server/validation.ts"

# ── Release engineering — install/backup/restore/upgrade ─────
header "Ops scripts (install/backup/restore/upgrade)"
for s in install.sh backup.sh restore.sh upgrade.sh backup-restore-test.sh lib.sh; do
  run "release: deploy/$s exists and parses" bash -n "$ROOT/deploy/$s"
done
run "release: deploy scripts are portable (no machine absolute paths)" bash -c "! grep -rn '/home/\|/Users/' '$ROOT/deploy'/*.sh"
run "release: install.sh asks exactly the 5 operator questions" bash -c "test \"\$(grep -cE '^[[:space:]]*ask [A-Z_]+ ' '$ROOT/deploy/install.sh')\" -eq 5"
run "release: install.sh writes .env with mode 600" bash -c "grep -q 'chmod 600 .env' '$ROOT/deploy/install.sh' && grep -q 'umask 077' '$ROOT/deploy/install.sh'"
run "release: install.sh generates real secrets (openssl)" grep -q 'sentinel_gen_hex' "$ROOT/deploy/install.sh"
run "release: install.sh refuses to clobber an existing install" grep -q 'SENTINEL_ALLOW_REINSTALL' "$ROOT/deploy/install.sh"
run "release: install.sh omits empty optional secrets" grep -q 'Optional keys are OMITTED when empty' "$ROOT/deploy/install.sh"
run "release: install.sh seeds prometheus connection in live mode" grep -q 'key: "prometheus"' "$ROOT/deploy/install.sh"
run "release: DATABASE_URL always comes from the install .env" grep -q 'ALWAYS taken from the file' "$ROOT/deploy/lib.sh"
run "release: standalone resolution handles flat AND nested layouts" grep -q 'workspace-nested\|nested' "$ROOT/deploy/lib.sh"
run "release: start web runs the standalone entry directly" grep -q 'bun server.js' "$ROOT/deploy/lib.sh"
run "release: backup.sh uses a consistent SQLite snapshot" grep -q 'a.backup(b)' "$ROOT/deploy/backup.sh"
run "release: backup.sh verifies nothing — restore.sh verifies SHA256SUMS first" bash -c "grep -q 'sha256sum --quiet --check SHA256SUMS' '$ROOT/deploy/restore.sh' && grep -q 'checksum verification failed' '$ROOT/deploy/restore.sh'"
run "release: restore refuses non-clean targets without --force" grep -q 'pass --force to overwrite' "$ROOT/deploy/restore.sh"
run "release: upgrade.sh backs up first and rolls back on failure" bash -c "grep -q 'pre-upgrade backup' '$ROOT/deploy/upgrade.sh' && grep -q 'rollback()' '$ROOT/deploy/upgrade.sh'"
run "release: clean-restore test refuses git worktree roots" grep -q 'refusing to run against a git worktree root' "$ROOT/deploy/backup-restore-test.sh"
run "release: clean-restore test compares snapshots byte-identical" grep -q 'diff -u "$INSTALL/brtest-A.txt" "$INSTALL/brtest-B.txt"' "$ROOT/deploy/backup-restore-test.sh"
run "release: standalone build is self-contained (reports/ copied in)" grep -q 'cp -r reports .next/standalone/' "$ROOT/package.json"
run "release: health checks the pipeline of record (weasy)" grep -q 'reportWeasyScript' "$ROOT/src/app/api/health/ready/route.ts"
run "release: workspace hygiene — scratch trees ignored by git" bash -c "grep -q 'tmp-\*/' '$ROOT/.gitignore' && grep -q '/backups/' '$ROOT/.gitignore'"
run "release: workspace hygiene — scratch trees excluded from tsc+eslint" bash -c "grep -q 'tmp-\*' '$ROOT/tsconfig.json' && grep -q 'tmp-\*/\*\*' '$ROOT/eslint.config.mjs'"

# ── release packaging (chart, wrappers, docs, version) ──────
run "release: chart appVersion is 2.0.0" grep -q 'appVersion: "2.0.0"' "$ROOT/deploy/helm/sentinel-sla/Chart.yaml"
run "release: chart probes hit the public health endpoints (never authed /api/dashboard)" bash -c "grep -q 'path: /api/health/live' '$ROOT/deploy/helm/sentinel-sla/templates/deployment.yaml' && grep -q 'path: /api/health/ready' '$ROOT/deploy/helm/sentinel-sla/templates/deployment.yaml' && ! grep -q 'path: /api/dashboard' '$ROOT/deploy/helm/sentinel-sla/templates/deployment.yaml'"
run "release: chart env names match the zod config contract" bash -c "grep -q 'name: SENTINEL_MODE' '$ROOT/deploy/helm/sentinel-sla/templates/deployment.yaml' && grep -q 'name: SENTINEL_TELEGRAM_BOT_TOKEN' '$ROOT/deploy/helm/sentinel-sla/templates/deployment.yaml' && grep -q 'name: SENTINEL_BALE_BOT_TOKEN' '$ROOT/deploy/helm/sentinel-sla/templates/deployment.yaml' && grep -q 'name: DATABASE_URL' '$ROOT/deploy/helm/sentinel-sla/templates/deployment.yaml'"
run "release: chart mounts the persistence volume at SENTINEL_DATA_DIR=/data" bash -c "grep -q 'name: SENTINEL_DATA_DIR' '$ROOT/deploy/helm/sentinel-sla/templates/deployment.yaml' && grep -q 'mountPath: /data' '$ROOT/deploy/helm/sentinel-sla/templates/deployment.yaml'"
run "release: chart ships the notification/ack Secret template" grep -q 'kind: Secret' "$ROOT/deploy/helm/sentinel-sla/templates/secret.yaml"
run "release: chart PVC template guarded by persistence.enabled" bash -c "grep -q 'kind: PersistentVolumeClaim' '$ROOT/deploy/helm/sentinel-sla/templates/pvc.yaml' && grep -q '.Values.persistence.enabled' '$ROOT/deploy/helm/sentinel-sla/templates/pvc.yaml'"
run "release: chart has no dead application.yml configmap (app is env-only)" bash -c "! test -f '$ROOT/deploy/helm/sentinel-sla/templates/configmap.yaml' && ! grep -rq 'application.yml' '$ROOT/deploy/helm/sentinel-sla/templates/'"
run "release: chart has no phantom env vars (prometheus URL is DB-managed)" bash -c "! grep -q 'SENTINEL_PROMETHEUS_URL\|SENTINEL_API_BASE=\|SLACK' '$ROOT/deploy/helm/sentinel-sla/templates/deployment.yaml'"
run "release: root entrypoints exist and exec the deploy scripts" bash -c "grep -q 'deploy/install.sh' '$ROOT/install.sh' && grep -q 'deploy/upgrade.sh' '$ROOT/upgrade.sh' && grep -q 'deploy/backup.sh' '$ROOT/backup.sh' && grep -q 'deploy/restore.sh' '$ROOT/restore.sh'"
run "release: release version is 2.0.0 (package.json + chart agree)" bash -c "grep -q '\"version\": \"2.0.0\"' '$ROOT/package.json' && grep -q 'appVersion: \"2.0.0\"' '$ROOT/deploy/helm/sentinel-sla/Chart.yaml'"
run "release: root CHANGELOG.md documents the 2.0.0 release" bash -c "grep -q '^## \[2.0.0\]' '$ROOT/CHANGELOG.md' && grep -q 'Removed' '$ROOT/CHANGELOG.md'"
run "release: INSTALL.md covers the five questions + TLS reverse proxy" bash -c "grep -q 'five questions' '$ROOT/docs/INSTALL.md' && grep -q 'reverse_proxy 127.0.0.1:3000' '$ROOT/docs/INSTALL.md' && grep -q 'proxy_pass         http://127.0.0.1:3000;' '$ROOT/docs/INSTALL.md'"
run "release: OPERATIONS.md covers backup/restore/upgrade/logs/troubleshooting" bash -c "grep -q './backup.sh' '$ROOT/docs/OPERATIONS.md' && grep -q './restore.sh' '$ROOT/docs/OPERATIONS.md' && grep -q './upgrade.sh' '$ROOT/docs/OPERATIONS.md' && grep -q 'Troubleshooting' '$ROOT/docs/OPERATIONS.md'"
run "release: docs set presence check (item 5 delivered or tracked)" bash -c "test -f '$ROOT/docs/INSTALL.md' && test -f '$ROOT/docs/OPERATIONS.md' && test -f '$ROOT/docs/SECURITY.md' && test -f '$ROOT/docs/DOMAIN.md'"
# ── doc set (user guides fa/en, admin guide) + users admin UI ──
run "release: USER-GUIDE ships in English AND Persian" bash -c "test -f '$ROOT/docs/USER-GUIDE.md' && test -f '$ROOT/docs/USER-GUIDE.fa.md'"
run "release: Persian guide is real Persian (RTL, natural formal)" grep -q "راهنمای کاربری" "$ROOT/docs/USER-GUIDE.fa.md"
run "release: user guide covers ack-from-message + formula popovers" bash -c "grep -q 'Acknowledge' '$ROOT/docs/USER-GUIDE.md' && grep -q 'formula popover' '$ROOT/docs/USER-GUIDE.md' && grep -q 'MTTD' '$ROOT/docs/USER-GUIDE.md'"
run "release: ADMIN-GUIDE covers users page + audit + backups-as-credentials" bash -c "grep -q '/settings/users' '$ROOT/docs/ADMIN-GUIDE.md' && grep -q 'audit' '$ROOT/docs/ADMIN-GUIDE.md' && grep -q 'credential' '$ROOT/docs/ADMIN-GUIDE.md'"
run "release: settings/users admin page exists and is wired" bash -c "test -f '$ROOT/src/app/settings/users/page.tsx' && test -f '$ROOT/src/components/sentinel/settings/users-client.tsx' && grep -q \"href: '/settings/users'\" '$ROOT/src/components/sentinel/app-shell.tsx' && grep -q 'nav.settings.users' '$ROOT/src/components/sentinel/command-palette-data.tsx'"
run "release: users nav entry is admin-gated" bash -c "grep -q \"minRole: 'admin'\" '$ROOT/src/components/sentinel/app-shell.tsx'"
run "release: users page i18n complete (EN and FA keys)" bash -c "grep -q \"'users.title': 'کاربران و نقش‌ها'\" '$ROOT/src/lib/i18n/en.ts' '$ROOT/src/lib/i18n/fa.ts' && grep -q \"'users.title': 'Users & roles'\" '$ROOT/src/lib/i18n/en.ts' '$ROOT/src/lib/i18n/fa.ts'"

# ── OpenAPI contract layer (document + linter + parity + generated docs) ────
run "release: openapi/openapi.yaml exists and parses (PyYAML)" python3 -c "import yaml; yaml.safe_load(open('$ROOT/openapi/openapi.yaml'))"
run "release: OpenAPI document pins release version + OAS 3.0.3" bash -c "grep -q '^openapi: 3.0.3' '$ROOT/openapi/openapi.yaml' && grep -q '^  version: 2.0.0' '$ROOT/openapi/openapi.yaml'"
run "release: OpenAPI ↔ routes parity (65 files, bidirectional)" python3 "$ROOT/scripts/openapi-parity.py"
run "release: spectral ruleset exists with Sentinel truth rules" bash -c "grep -q 'sentinel/spec-version-matches-release' '$ROOT/openapi/spectral.yaml' && grep -q 'sentinel/error-envelope-on-401' '$ROOT/openapi/spectral.yaml'"
run "release: lint:spec wired to the two-layer linter" bash -c "grep -q '\"lint:spec\": \"bun scripts/lint-openapi.mjs\"' '$ROOT/package.json' && test -f '$ROOT/scripts/lint-openapi.mjs'"
run "release: contract harness exists and is wired (test:contract + CI)" bash -c "test -f '$ROOT/tests/integration/api-contract.mjs' && grep -q '\"test:contract\": \"bun tests/integration/api-contract.mjs\"' '$ROOT/package.json' && grep -q 'api-contract.mjs' '$ROOT/.github/workflows/ci.yml'"
run "release: CI lints the OpenAPI document (OpenAPI linter in CI)" bash -c "grep -q 'bun run lint:spec' '$ROOT/.github/workflows/ci.yml' && grep -q 'generate-api-docs.mjs --check' '$ROOT/.github/workflows/ci.yml'"
run "release: docs/API.md is generated from the OpenAPI document (stamp + sync)" bash -c "grep -q 'Generated from \`openapi/openapi.yaml\`' '$ROOT/docs/API.md' && grep -q 'v2.0.0' '$ROOT/docs/API.md'"
run "release: API.md documents every operation (87 sections)" bash -c "test \"\$(grep -c '^### ' '$ROOT/docs/API.md')\" -eq 87"
run "release: API.md generator --check passes (no drift)" node "$ROOT/scripts/generate-api-docs.mjs" --check
run "release: contract harness exercises every operation (coverage accounting)" grep -q 'NOT covered and NOT skipped' "$ROOT/tests/integration/api-contract.mjs"

# ── release documentation set — architecture, notices, support ──
run "release: ARCHITECTURE.md covers C4 levels 1-3 with 3 mermaid diagrams" bash -c "grep -q '## 2. C4 Level 1 — System context' '$ROOT/docs/ARCHITECTURE.md' && grep -q '## 3. C4 Level 2 — Containers' '$ROOT/docs/ARCHITECTURE.md' && grep -q '## 4. C4 Level 3 — Components' '$ROOT/docs/ARCHITECTURE.md' && test \"\$(grep -c '^flowchart' '$ROOT/docs/ARCHITECTURE.md')\" -ge 3"
run "release: ARCHITECTURE.md quotes the real engine constants" bash -c "grep -q '2500 ms' '$ROOT/docs/ARCHITECTURE.md' && grep -q 'accrueLoss' '$ROOT/docs/ARCHITECTURE.md' && grep -q 'computePenalty' '$ROOT/docs/ARCHITECTURE.md' && grep -q 'lostValueRials' '$ROOT/docs/ARCHITECTURE.md'"
run "release: ARCHITECTURE.md documents both runtime modes and topologies" bash -c "grep -q 'SENTINEL_MODE=demo' '$ROOT/docs/ARCHITECTURE.md' && grep -q 'deploy/helm/sentinel-sla' '$ROOT/docs/ARCHITECTURE.md' && grep -q '/api/health/ready' '$ROOT/docs/ARCHITECTURE.md'"
run "release: THIRD_PARTY_NOTICES.md lists the AGPL components with pinned sources" bash -c "grep -q 'grafana/grafana:11.1.0' '$ROOT/docs/THIRD_PARTY_NOTICES.md' && grep -q 'grafana/loki:3.1.0' '$ROOT/docs/THIRD_PARTY_NOTICES.md' && grep -q 'grafana/promtail:3.1.0' '$ROOT/docs/THIRD_PARTY_NOTICES.md' && grep -q 'github.com/grafana/grafana/tree/v11.1.0' '$ROOT/docs/THIRD_PARTY_NOTICES.md'"
run "release: THIRD_PARTY_NOTICES.md carries the libvips LGPL note" bash -c "grep -q 'LGPL-3.0-or-later' '$ROOT/docs/THIRD_PARTY_NOTICES.md' && grep -q 'libvips' '$ROOT/docs/THIRD_PARTY_NOTICES.md'"
run "release: THIRD_PARTY_NOTICES.md is backed by the real licence sweep" bash -c "test -f '$ROOT/scripts/licence-sweep.mjs' && test -f '$ROOT/scripts/licence-sweep.json' && grep -q 'scripts/licence-sweep.mjs' '$ROOT/docs/THIRD_PARTY_NOTICES.md'"
run "release: THIRD_PARTY_NOTICES.md covers Apache monitoring + fonts + python" bash -c "grep -q 'prom/prometheus:v2.53.1' '$ROOT/docs/THIRD_PARTY_NOTICES.md' && grep -q 'GNU FreeFont' '$ROOT/docs/THIRD_PARTY_NOTICES.md' && grep -q 'reportlab' '$ROOT/docs/THIRD_PARTY_NOTICES.md' && grep -q 'matplotlib' '$ROOT/docs/THIRD_PARTY_NOTICES.md'"
run "release: SUPPORT.md points users at GitHub Issues and warns about secrets" bash -c "test \"\$(grep -c 'GitHub Issues' '$ROOT/docs/SUPPORT.md')\" -ge 1 && grep -q 'never send' '$ROOT/docs/SUPPORT.md'"
run "release: SUPPORT.md states scope honestly (in and out)" bash -c "grep -q 'What is supported in v2.0.0' '$ROOT/docs/SUPPORT.md' && grep -q 'not\*\* supported' '$ROOT/docs/SUPPORT.md' && grep -q 'High availability' '$ROOT/docs/SUPPORT.md'"
run "release: golden money scenarios present (18 fixtures)" test "$(ls "$ROOT/tests/golden/"g*.json 2>/dev/null | wc -l)" -eq 18

run "release: synthetic Iranian-fintech scenario exists and is marked synthetic" bash -c "test -f '$ROOT/tests/scenarios/iranian-fintech-synthetic.json' && grep -q '\"synthetic\": true' '$ROOT/tests/scenarios/iranian-fintech-synthetic.json' && grep -q 'never be used as market data' '$ROOT/tests/scenarios/iranian-fintech-synthetic.json'"
run "release: scenario unit test wired (7 checks over profile rules + computeLoss)" bash -c "test -f '$ROOT/tests/unit/scenario-iranian.test.ts' && grep -q 'computeLoss' '$ROOT/tests/unit/scenario-iranian.test.ts'"

# ── developer guide + exporter auth ───────────
run "release: DEVELOPMENT guide targets Fedora 44 AND Ubuntu 24.04" bash -c "grep -q 'Fedora 44' '$ROOT/docs/DEVELOPMENT.md' && grep -q 'Ubuntu 24.04' '$ROOT/docs/DEVELOPMENT.md' && grep -q 'Fedora 44' '$ROOT/docs/DEVELOPMENT.md' && grep -q 'Ubuntu 24.04' '$ROOT/docs/DEVELOPMENT.md'"
run "release: DEVELOPMENT no longer claims the app has no Dockerfile" bash -c "! grep -q 'no Dockerfile for the app' '$ROOT/docs/DEVELOPMENT.md' && ! grep -q 'No Dockerfile for the app' '$ROOT/docs/DEVELOPMENT.md' && test -f '$ROOT/Dockerfile'"
run "release: DEVELOPMENT run guide documents worker + /setup + public health endpoints" bash -c "grep -q 'bun run worker' '$ROOT/docs/DEVELOPMENT.md' && grep -q '/setup' '$ROOT/docs/DEVELOPMENT.md' && grep -q '/api/health/ready' '$ROOT/docs/DEVELOPMENT.md' && grep -q '.env.example' '$ROOT/docs/DEVELOPMENT.md'"
run "release: DEVELOPMENT run guide does not teach unauthenticated dashboard curls" bash -c "! grep -q 'curl -s http://localhost:3000/api/dashboard' '$ROOT/docs/DEVELOPMENT.md'"
run "release: DEVELOPMENT pdf guide documents the WeasyPrint pipeline + bundled fonts" bash -c "grep -q 'render_weasy.py' '$ROOT/docs/DEVELOPMENT.md' && grep -qi weasyprint '$ROOT/docs/DEVELOPMENT.md' && grep -q 'public/fonts' '$ROOT/docs/DEVELOPMENT.md'"
run "release: DEVELOPMENT tests guide documents token auth for chaos/load" bash -c "grep -q 'mint-loadtest-token' '$ROOT/docs/DEVELOPMENT.md' && grep -q 'SENTINEL_TOKEN' '$ROOT/docs/DEVELOPMENT.md' && grep -q 'SENTINEL_TOKEN' '$ROOT/chaos/auto_chaos.sh'"
run "release: chaos runner supports Bearer tokens (--token / SENTINEL_TOKEN)" bash -c "grep -q 'Authorization' '$ROOT/chaos/chaos_experiment.py' && grep -q 'os.environ.get(\"SENTINEL_TOKEN\"' '$ROOT/chaos/chaos_experiment.py' && grep -q '\\-\\-token' '$ROOT/chaos/chaos_experiment.py'"
run "release: exporter authenticates to the protected dashboard API" bash -c "grep -q 'SetAuthToken' '$ROOT/exporter/internal/collector/collector.go' && grep -q 'SENTINEL_API_TOKEN' '$ROOT/exporter/main.go' && grep -q 'Bearer ' '$ROOT/exporter/internal/collector/collector.go'"
run "release: compose wires SENTINEL_API_TOKEN to the exporter + env example documents it" bash -c "grep -q 'SENTINEL_API_TOKEN' '$ROOT/deploy/docker-compose.yml' && grep -q 'SENTINEL_API_TOKEN' '$ROOT/deploy/.env.example' && grep -q 'mint-loadtest-token' '$ROOT/deploy/.env.example'"
run "release: exporter Go tests cover the Bearer header contract" grep -q 'TestFetchSendsBearerToken' "$ROOT/exporter/internal/collector/collector_test.go"
run "release: DEVELOPMENT known-limitations is honest (simulation, single-node, untested cluster)" bash -c "grep -q 'Demo mode is a simulation' '$ROOT/docs/DEVELOPMENT.md' && grep -q 'not tested on a live cluster\|linted and rendered, not cluster-tested' '$ROOT/docs/DEVELOPMENT.md' && grep -q 'Single-node' '$ROOT/docs/DEVELOPMENT.md'"
run "release: DEVELOPMENT troubleshooting covers the v2.0.0 auth surface" bash -c "grep -q '401' '$ROOT/docs/DEVELOPMENT.md' && grep -q 'mint-loadtest-token' '$ROOT/docs/DEVELOPMENT.md' && grep -q 'SENTINEL_API_TOKEN' '$ROOT/docs/DEVELOPMENT.md'"
run "release: root README tells the product story + quick start + third-party notices" bash -c "grep -q 'contract-aware SLA monitoring platform on top of Prometheus' '$ROOT/README.md' && grep -q 'cp .env.example .env' '$ROOT/README.md' && grep -q 'docs/THIRD_PARTY_NOTICES.md' '$ROOT/README.md'"
run "release: .github templates present (PR checklist + bug/feature issues)" bash -c "test -f '$ROOT/.github/PULL_REQUEST_TEMPLATE.md' && test -f '$ROOT/.github/ISSUE_TEMPLATE/bug_report.md' && test -f '$ROOT/.github/ISSUE_TEMPLATE/feature_request.md' && grep -q 'bun run check' '$ROOT/.github/PULL_REQUEST_TEMPLATE.md'"

# ── release artefacts ───────────────────────────────────
run "release: release tooling exists and parses (sbom gen, build, docker-save)" bash -c "test -x '$ROOT/scripts/build-release.sh' && test -x '$ROOT/scripts/docker-save-release.sh' && bash -n '$ROOT/scripts/build-release.sh' && bash -n '$ROOT/scripts/docker-save-release.sh' && node --check '$ROOT/scripts/gen-sbom.mjs'"
run "release: package.json wires the release scripts" bash -c "grep -q '\"sbom\": \"bun scripts/gen-sbom.mjs\"' '$ROOT/package.json' && grep -q '\"release\": \"bash scripts/build-release.sh\"' '$ROOT/package.json' && grep -q '\"release:images\": \"bash scripts/docker-save-release.sh\"' '$ROOT/package.json'"
run "release: SBOM is CycloneDX 1.5 for sentinel-sla@2.0.0 with valid serial + purls" node -e "const b=require('$ROOT/release/sentinel-sla-2.0.0.cdx.json');if(b.bomFormat!=='CycloneDX'||b.specVersion!=='1.5')process.exit(1);if(b.metadata.component.name!=='sentinel-sla'||b.metadata.component.version!=='2.0.0')process.exit(1);if(!/^urn:uuid:[0-9a-f-]{36}\$/.test(b.serialNumber))process.exit(1);const p=new Set(b.components.map(c=>c.purl));if(p.size!==b.components.length)process.exit(1);for(const c of b.components){if(!c.type||!c.name||!c.version||!c.purl||!c.licenses?.length)process.exit(1)}"
run "release: SBOM npm closure matches the licence sweep exactly (188 packages)" node -e "const b=require('$ROOT/release/sentinel-sla-2.0.0.cdx.json');const s=require('$ROOT/scripts/licence-sweep.json');const sbom=new Set(b.components.filter(c=>c.purl.startsWith('pkg:npm/')).map(c=>c.name+'@'+c.version));const sw=s.prodList.map(p=>p.name+'@'+p.version);if(sbom.size!==188||sw.length!==188)process.exit(1);for(const n of sw){if(!sbom.has(n))process.exit(1)}"
run "release: SBOM carries the 6 compose images with AGPL marked" bash -c "grep -q 'pkg:docker/prom/prometheus@v2.53.1' '$ROOT/release/sentinel-sla-2.0.0.cdx.json' && grep -q 'pkg:docker/grafana/grafana@11.1.0' '$ROOT/release/sentinel-sla-2.0.0.cdx.json' && grep -q 'pkg:docker/grafana/loki@3.1.0' '$ROOT/release/sentinel-sla-2.0.0.cdx.json' && grep -q 'pkg:docker/prom/alertmanager@v0.27.0' '$ROOT/release/sentinel-sla-2.0.0.cdx.json' && test \"\$(grep -c 'AGPL-3.0-only' '$ROOT/release/sentinel-sla-2.0.0.cdx.json')\" -ge 3"
run "release: SBOM carries the Go exporter module" grep -q 'pkg:golang/github.com/FontanisDev/sentinel-sla/exporter@2.0.0' "$ROOT/release/sentinel-sla-2.0.0.cdx.json"
if [[ -f "$ROOT/release/SHA256SUMS" ]]; then
run "release: SHA256SUMS verifies in place (tarball + SBOM)" bash -c "test -f '$ROOT/release/sentinel-sla-2.0.0.tar.gz' && cd '$ROOT/release' && sha256sum -c --quiet SHA256SUMS"
run "release: release manifest records source commit, version and install steps" node -e "const m=require('$ROOT/release/RELEASE-MANIFEST.json');if(m.version!=='2.0.0')process.exit(1);if(!/^[0-9a-f]{40}\$/.test(m.sourceCommit))process.exit(1);require('child_process').execSync('git merge-base --is-ancestor '+m.sourceCommit+' HEAD',{cwd:'$ROOT'});if(m.install.join(' ').indexOf('./install.sh')<0)process.exit(1);if(m.sbom.components!==195)process.exit(1)"
run "release: tarball layout sane (required paths present, secrets/db/build outputs absent)" bash -c "T=\$(tar -tzf '$ROOT/release/sentinel-sla-2.0.0.tar.gz') && echo \"\$T\" | grep -q '^sentinel-sla-2.0.0/deploy/docker-compose.yml\$' && echo \"\$T\" | grep -q '^sentinel-sla-2.0.0/deploy/install.sh\$' && echo \"\$T\" | grep -q '^sentinel-sla-2.0.0/docs/RELEASE.md\$' && echo \"\$T\" | grep -q '^sentinel-sla-2.0.0/.env.example\$' && echo \"\$T\" | grep -q '^sentinel-sla-2.0.0/release/sentinel-sla-2.0.0.cdx.json\$' && ! echo \"\$T\" | grep -E '(^|/)\.env\$|(^|/)\.next/|(^|/)node_modules/|\.db\$|\.log\$' && ! echo \"\$T\" | grep -qE '^sentinel-sla-2.0.0/data/'"
else skip "release: release artefacts not built (bun run release builds them)"; fi
run "release: heavy release binaries stay out of git (tarball ignored)" bash -c "git -C '$ROOT' check-ignore -q release/sentinel-sla-2.0.0.tar.gz && git -C '$ROOT' ls-files release/ | grep -q 'cdx.json' && git -C '$ROOT' ls-files release/ | grep -q 'SHA256SUMS' && git -C '$ROOT' ls-files release/ | grep -q 'RELEASE-MANIFEST.json'"
run "release: docs/RELEASE.md documents build, verify and air-gapped procedures" bash -c "grep -q 'bun run release' '$ROOT/docs/RELEASE.md' && grep -q 'sha256sum -c SHA256SUMS' '$ROOT/docs/RELEASE.md' && grep -q 'docker load' '$ROOT/docs/RELEASE.md' && grep -q '195 components' '$ROOT/docs/RELEASE.md'"
run "release: CHANGELOG documents the release artefacts" bash -c "grep -q 'Release artefacts' '$ROOT/CHANGELOG.md' && grep -q 'CycloneDX 1.5' '$ROOT/CHANGELOG.md' && grep -q 'docker-save-release.sh' '$ROOT/CHANGELOG.md'"

# ── meta: the test file itself must stay honest ──────────────────────────────
run "meta: no dead checks after the final exit 0" awk 'seen && /^run /{exit 1} /^exit 0[ \t]*$/{seen=1} END{if(!seen) exit 1}' "$ROOT/tests/integration/test_stack.sh"
run "meta: no duplicated check names" bash -c "test \"\$(grep -oE '^run \"[^\"]+\"' '$ROOT/tests/integration/test_stack.sh' | sort | uniq -d | wc -l)\" -eq 0"

# ── sentinel-doctor diagnostic bundle ───
run "doctor: deploy script + root wrapper exist and parse" bash -c "test -x '$ROOT/deploy/doctor.sh' && test -x '$ROOT/doctor.sh' && bash -n '$ROOT/deploy/doctor.sh' && bash -n '$ROOT/doctor.sh' && grep -q 'deploy/doctor.sh' '$ROOT/doctor.sh'"
run "doctor: redacted by construction (never dumps .env values or DATABASE_URL)" bash -c "! grep -qE 'cat .*\.env|echo .*DATABASE_URL|printenv' '$ROOT/deploy/doctor.sh' && grep -q 'keys set' '$ROOT/deploy/doctor.sh' && grep -q 'path redacted' '$ROOT/deploy/doctor.sh'"
run "doctor: outbox statuses mirror src/server/notify/outbox.ts (pending/delivering/dead)" bash -c "grep -qF \"'pending','delivering'\" '$ROOT/deploy/doctor.sh' && grep -qF \"'dead'\" '$ROOT/deploy/doctor.sh'"
run "doctor: OPERATIONS + SUPPORT point at the bundle" bash -c "grep -q 'Diagnostic bundle (sentinel-doctor)' '$ROOT/docs/OPERATIONS.md' && grep -q './doctor.sh' '$ROOT/docs/OPERATIONS.md' && grep -q 'redacted by construction' '$ROOT/docs/SUPPORT.md'"
run "doctor: bundles stay out of git" bash -c "git -C '$ROOT' check-ignore -q doctor/sentinel-doctor-x.txt || git -C '$ROOT' check-ignore -q doctor/ || grep -q '^/doctor/' '$ROOT/.gitignore'"

# ── CSV import of contracts and services ─
run "csv-import: pure parser module exists and shares the wizard's validation truth" bash -c "test -f '$ROOT/src/server/csv-import.ts' && grep -q \"createServiceSchema.shape.key\" '$ROOT/src/server/csv-import.ts' && grep -q 'IMPORT_MAX_ROWS = 200' '$ROOT/src/server/csv-import.ts'"
run "csv-import: parser is pure (no db/engine/clock imports)" bash -c "! grep -qE \"from '@/lib/db'|from '@/server/engine'\" '$ROOT/src/server/csv-import.ts'"
run "csv-import: route wired (dry-run default, all-or-nothing commit, authz parity with single POST)" bash -c "grep -q \"requireRole(req, 'engineer')\" '$ROOT/src/app/api/services/import/route.ts' && grep -q \"requireTenantAccess\" '$ROOT/src/app/api/services/import/route.ts' && grep -q \"mode !== 'commit'\" '$ROOT/src/app/api/services/import/route.ts' && grep -q 'failures > 0' '$ROOT/src/app/api/services/import/route.ts' && grep -q 'reloadServices' '$ROOT/src/app/api/services/import/route.ts'"
run "csv-import: template sheet ships in public/ with the documented header" bash -c "test -f '$ROOT/public/templates/services-import-template.csv' && head -1 '$ROOT/public/templates/services-import-template.csv' | grep -q '^key,name,nameFa,tenant,slaTarget,penaltyBase,penaltyPerMinute,criticality$'"
run "csv-import: UI card mounted on the services settings page" bash -c "test -f '$ROOT/src/components/sentinel/settings/import-csv-card.tsx' && grep -q 'ImportCsvCard' '$ROOT/src/app/settings/services/page.tsx' && grep -q 'onImported' '$ROOT/src/app/settings/services/page.tsx'"
run "csv-import: i18n strings present in BOTH dictionaries" bash -c "grep -q \"'settings.import.title'\" '$ROOT/src/lib/i18n/en.ts' && grep -q \"'settings.import.title'\" '$ROOT/src/lib/i18n/fa.ts' && grep -q \"'settings.import.commit'\" '$ROOT/src/lib/i18n/fa.ts'"
run "csv-import: unit tests cover parser edge cases + fast-check round-trip against rowsToCsv" bash -c "test -f '$ROOT/tests/unit/csv-import.test.ts' && grep -q 'rowsToCsv' '$ROOT/tests/unit/csv-import.test.ts' && grep -q 'fast-check' '$ROOT/tests/unit/csv-import.test.ts'"
run "csv-import: live smoke script exists (dry-run zero-write + 422 abort proof)" bash -c "test -f '$ROOT/scripts/csv-import-smoke.sh' && bash -n '$ROOT/scripts/csv-import-smoke.sh' && grep -q 'committed' '$ROOT/scripts/csv-import-smoke.sh'"
run "csv-import: user guides document the import journey" bash -c "grep -q 'services-import-template' '$ROOT/docs/USER-GUIDE.md' && grep -q 'services-import-template' '$ROOT/docs/USER-GUIDE.fa.md' && grep -q '/api/services/import' '$ROOT/docs/API.md'"

# ── contract template library ───────────
run "templates: library module exists, bilingual, integer-Tomans, no customer names" bash -c "test -f '$ROOT/src/lib/contract-templates.ts' && grep -q 'nameFa' '$ROOT/src/lib/contract-templates.ts' && grep -q 'penaltyBase: 100_000_000' '$ROOT/src/lib/contract-templates.ts' && ! grep -qiE 'co\.(ir|com)|شرکت [ابپتثجچ]' '$ROOT/src/lib/contract-templates.ts'"
run "templates: wizard step-4 wiring (select + applyTemplate + standing example-values note)" bash -c "grep -q 'CONTRACT_TEMPLATES' '$ROOT/src/app/settings/services/page.tsx' && grep -q 'applyTemplate' '$ROOT/src/app/settings/services/page.tsx' && grep -q \"settings.wizard.templateNote\" '$ROOT/src/app/settings/services/page.tsx'"
run "templates: i18n keys present in BOTH dictionaries" bash -c "grep -q \"'settings.wizard.template'\" '$ROOT/src/lib/i18n/en.ts' && grep -q \"'settings.wizard.template'\" '$ROOT/src/lib/i18n/fa.ts' && grep -q 'settings.wizard.templateNote' '$ROOT/src/lib/i18n/fa.ts'"
run "templates: golden fingerprint tests pin terms + penalties against the real domain function" bash -c "test -f '$ROOT/tests/unit/contract-templates.test.ts' && grep -q 'penaltyFixedPerMinute' '$ROOT/tests/unit/contract-templates.test.ts' && grep -q 'createServiceSchema' '$ROOT/tests/unit/contract-templates.test.ts'"
run "templates: user guides + CHANGELOG document the library" bash -c "grep -q 'Contract templates in the onboarding wizard' '$ROOT/docs/USER-GUIDE.md' && grep -q 'الگوهای قرارداد در جادوگر' '$ROOT/docs/USER-GUIDE.fa.md' && grep -q 'Contract template library' '$ROOT/CHANGELOG.md'"

# ── Grafana alert-rule import ───────────
run "grafana-import: pure mapper module exists with caps + honesty contract" bash -c "test -f '$ROOT/src/server/grafana-import.ts' && grep -q 'IMPORT_MAX_RULES = 200' '$ROOT/src/server/grafana-import.ts' && grep -q 'IMPORT_MAX_BYTES' '$ROOT/src/server/grafana-import.ts' && grep -q 'never silently' '$ROOT/src/server/grafana-import.ts'"
run "grafana-import: mapper is pure (no db/engine/clock imports)" bash -c "! grep -qE \"from '@/lib/db'|from '@/server/engine'\" '$ROOT/src/server/grafana-import.ts'"
run "grafana-import: imported rules go through the REAL create-rule schema" bash -c "grep -q \"createAlertRuleSchema.safeParse\" '$ROOT/src/server/grafana-import.ts' && grep -q 'createAlertRule' '$ROOT/src/app/api/rules/import/route.ts'"
run "grafana-import: route wired (dry-run default, all-or-nothing commit, engineer authz parity with POST /api/rules)" bash -c "grep -q \"requireRole(req, 'engineer')\" '$ROOT/src/app/api/rules/import/route.ts' && grep -q \"body.mode === 'commit' ? 'commit' : 'dryRun'\" '$ROOT/src/app/api/rules/import/route.ts' && grep -q 'failures > 0' '$ROOT/src/app/api/rules/import/route.ts'"
run "grafana-import: unknown service label aborts (no silent fleet-widening)" bash -c "grep -q 'matches no Sentinel service' '$ROOT/src/app/api/rules/import/route.ts'"
run "grafana-import: duplicate names refused both in-file and against the registry" bash -c "grep -q \"earlier in this export\" '$ROOT/src/app/api/rules/import/route.ts' && grep -q 'already exists' '$ROOT/src/app/api/rules/import/route.ts'"
run "grafana-import: live smoke script exists (7 checks incl. dry-run zero-write + 422 abort)" bash -c "test -f '$ROOT/scripts/grafana-import-smoke.sh' && bash -n '$ROOT/scripts/grafana-import-smoke.sh' && grep -q 'committed=False' '$ROOT/scripts/grafana-import-smoke.sh'"
run "grafana-import: sample export ships and every rule maps (golden)" bash -c "test -f '$ROOT/public/templates/grafana-alerts-sample.json' && grep -q 'gr-sentinel-up' '$ROOT/public/templates/grafana-alerts-sample.json' && grep -q 'golden' '$ROOT/tests/unit/grafana-import.test.ts'"
run "grafana-import: unit tests pin mapping goldens + refusals + fast-check" bash -c "test -f '$ROOT/tests/unit/grafana-import.test.ts' && grep -q 'count rate, not a 0–1 ratio' '$ROOT/tests/unit/grafana-import.test.ts' && grep -q 'fast-check' '$ROOT/tests/unit/grafana-import.test.ts'"
# ── shaparak-import: transaction-count CSV → hour-of-week tps profile ──────
run "shaparak-import: pure parser exists with caps + honest rejection reporting" bash -c "test -f '$ROOT/src/server/shaparak-import.ts' && grep -q 'SHAPARAK_MAX_ROWS = 2016' '$ROOT/src/server/shaparak-import.ts' && grep -q 'SHAPARAK_MAX_BYTES = 512 \* 1024' '$ROOT/src/server/shaparak-import.ts' && grep -q 'parseShaparakSheet' '$ROOT/src/server/shaparak-import.ts'"
run "shaparak-import: Persian reality — Jalali dates + FA headers + Persian digits accepted" bash -c "grep -q 'jalaliToGregorian' '$ROOT/src/server/shaparak-import.ts' && grep -q 'تعدادتراکنش' '$ROOT/src/server/shaparak-import.ts' && grep -q 'PERSIAN_DIGITS' '$ROOT/src/server/shaparak-import.ts'"
run "shaparak-import: domain bucket math mirrors resolveTpsAt (wall-clock hour-of-week)" bash -c "test -f '$ROOT/src/domain/tps-profile.ts' && grep -q 'bucketForInstant' '$ROOT/src/domain/tps-profile.ts' && grep -q 'TEHRAN_TZ_OFFSET_MINUTES = 210' '$ROOT/src/domain/tps-profile.ts' && grep -q 'aggregateProfile' '$ROOT/src/domain/tps-profile.ts'"
run "shaparak-import: route wired (dry-run default, all-or-nothing commit, engineer authz, tenant scope, audit)" bash -c "test -f '$ROOT/src/app/api/services/[key]/tps-profile/route.ts' && grep -q \"requireRole(req, 'engineer')\" '$ROOT/src/app/api/services/[key]/tps-profile/route.ts' && grep -q 'resolveTenantScope' '$ROOT/src/app/api/services/[key]/tps-profile/route.ts' && grep -q \"mode === 'commit'\" '$ROOT/src/app/api/services/[key]/tps-profile/route.ts' && grep -q 'rejected.length > 0' '$ROOT/src/app/api/services/[key]/tps-profile/route.ts' && grep -q 'service.tps-profile.imported' '$ROOT/src/app/api/services/[key]/tps-profile/route.ts'"
run "shaparak-import: DELETE reverts to flat + audited (idempotent removed:false)" bash -c "grep -q 'service.tps-profile.removed' '$ROOT/src/app/api/services/[key]/tps-profile/route.ts' && grep -q 'removed: false' '$ROOT/src/app/api/services/[key]/tps-profile/route.ts'"
run "shaparak-import: live money path resolves tps at incident start (flat fallback + corrupt-profile honesty)" bash -c "grep -q 'resolveServiceTps(service' '$ROOT/src/server/ingestion.ts' && grep -q 'profileError' '$ROOT/src/server/shaparak-import.ts' && grep -q 'tpsAt.tps \* durationSec' '$ROOT/src/server/ingestion.ts'"
run "shaparak-import: schema column tpsProfile on Service (both schemas)" bash -c "grep -q 'tpsProfile          String?' '$ROOT/prisma/schema.prisma' && grep -q 'tpsProfile          String?' '$ROOT/prisma/schema.postgres.prisma'"
run "shaparak-import: service detail exposes the profile summary" bash -c "grep -q 'tpsProfile' '$ROOT/src/app/api/services/[key]/route.ts' && grep -q 'TpsProfileSummary' '$ROOT/src/lib/types.ts'"
run "shaparak-import: UI card wired (import form + preview strip + confirmed removal)" bash -c "test -f '$ROOT/src/components/sentinel/tps-profile-card.tsx' && grep -q 'TpsProfileCard' '$ROOT/src/components/sentinel/service-detail-client.tsx' && grep -q 'BucketStrip' '$ROOT/src/components/sentinel/tps-profile-card.tsx' && grep -q 'AlertDialog' '$ROOT/src/components/sentinel/tps-profile-card.tsx'"
run "shaparak-import: i18n strings present in BOTH dictionaries (39 keys)" bash -c "test \$(grep -c \"'tps.profile\" '$ROOT/src/lib/i18n/en.ts') -eq 39 && test \$(grep -c \"'tps.profile\" '$ROOT/src/lib/i18n/fa.ts') -eq 39"
run "shaparak-import: unit goldens + fast-check pin the parser and aggregation" bash -c "test -f '$ROOT/tests/unit/shaparak-import.test.ts' && grep -q 'fast-check' '$ROOT/tests/unit/shaparak-import.test.ts' && grep -q '1404' '$ROOT/tests/unit/shaparak-import.test.ts'"
run "shaparak-import: sample sheet ships (synthetic, Jalali dates, FA headers)" bash -c "test -f '$ROOT/public/templates/shaparak-tx-counts-sample.csv' && grep -q 'تاریخ' '$ROOT/public/templates/shaparak-tx-counts-sample.csv' && grep -q '1404' '$ROOT/public/templates/shaparak-tx-counts-sample.csv'"
run "shaparak-import: live smoke script exists (401 → dry-run zero-write → commit → revert)" bash -c "test -f '$ROOT/scripts/shaparak-import-smoke.sh' && bash -n '$ROOT/scripts/shaparak-import-smoke.sh' && grep -q 'dry-run' '$ROOT/scripts/shaparak-import-smoke.sh' && grep -q 'mode.: .commit' '$ROOT/scripts/shaparak-import-smoke.sh' && grep -q 'removed:false' '$ROOT/scripts/shaparak-import-smoke.sh'"
run "shaparak-import: money proof drives the real ingestion tick with a profile" bash -c "test -f '$ROOT/scripts/shaparak-money-proof.mjs' && grep -q 'runIngestionTick' '$ROOT/scripts/shaparak-money-proof.mjs' && grep -q 'revenueLossTomans' '$ROOT/scripts/shaparak-money-proof.mjs'"
run "shaparak-import: OpenAPI documents both operations (import + delete) + API.md regenerated" bash -c "grep -q 'importServiceTpsProfile' '$ROOT/openapi/openapi.yaml' && grep -q 'deleteServiceTpsProfile' '$ROOT/openapi/openapi.yaml' && grep -q 'TpsProfileImportReport' '$ROOT/docs/API.md'"
run "shaparak-import: guides document the Shaparak journey (EN + FA + DOMAIN)" bash -c "grep -q 'Shaparak' '$ROOT/docs/USER-GUIDE.md' && grep -q 'شاپرک' '$ROOT/docs/USER-GUIDE.fa.md' && grep -q 'Transaction profile' '$ROOT/docs/DOMAIN.md'"

run "grafana-import: UI card mounted on the rules page" bash -c "test -f '$ROOT/src/components/sentinel/alerting/import-grafana-card.tsx' && grep -q 'ImportGrafanaCard' '$ROOT/src/components/sentinel/alerting/rules-client.tsx' && grep -q '/api/rules/import' '$ROOT/src/components/sentinel/alerting/import-grafana-card.tsx'"
run "grafana-import: i18n strings present in BOTH dictionaries" bash -c "grep -q \"'alerting.import.title'\" '$ROOT/src/lib/i18n/en.ts' && grep -q \"'alerting.import.title'\" '$ROOT/src/lib/i18n/fa.ts' && grep -q \"'alerting.import.commit'\" '$ROOT/src/lib/i18n/fa.ts'"
run "grafana-import: guides + API.md document the import journey" bash -c "grep -q 'grafana-alerts-sample' '$ROOT/docs/USER-GUIDE.md' && grep -q 'گرافانا' '$ROOT/docs/USER-GUIDE.fa.md' && grep -q '/api/rules/import' '$ROOT/docs/API.md'"

# ── Zabbix trigger import ───────────────
run "zabbix-import: pure mapper module exists with caps + honesty contract" bash -c "test -f '$ROOT/src/server/zabbix-import.ts' && grep -q 'IMPORT_MAX_RULES = 200' '$ROOT/src/server/zabbix-import.ts' && grep -q 'Sentinel monitors SERVICES, not hosts' '$ROOT/src/server/zabbix-import.ts'"
run "zabbix-import: mapper is pure (no db/engine/clock imports)" bash -c "! grep -qE \"from '@/lib/db'|from '@/server/engine'\" '$ROOT/src/server/zabbix-import.ts'"
run "zabbix-import: both expression syntaxes recognised (5.4+ modern + legacy)" bash -c "grep -q 'last\\|min\\|max\\|avg\\|nodata' '$ROOT/src/server/zabbix-import.ts' && grep -q 'legacy' '$ROOT/src/server/zabbix-import.ts'"
run "zabbix-import: route dispatches on source=grafana|zabbix (default grafana)" bash -c "grep -q \"body.source === 'zabbix'\" '$ROOT/src/app/api/rules/import/route.ts' && grep -q 'importZabbixTriggers' '$ROOT/src/app/api/rules/import/route.ts'"
run "zabbix-import: disabled triggers and host-resource items refused (goldens)" bash -c "grep -q 'disabled in Zabbix' '$ROOT/src/server/zabbix-import.ts' && grep -q 'host-resource trigger' '$ROOT/src/server/zabbix-import.ts'"
run "zabbix-import: unit tests pin availability/latency/throughput goldens + fast-check" bash -c "test -f '$ROOT/tests/unit/zabbix-import.test.ts' && grep -q 'uptime lt 1' '$ROOT/tests/unit/zabbix-import.test.ts' && grep -q 'fast-check' '$ROOT/tests/unit/zabbix-import.test.ts'"
run "zabbix-import: sample trigger.get export ships and maps 4/4 (golden)" bash -c "test -f '$ROOT/public/templates/zabbix-triggers-sample.json' && grep -q 'agent.ping' '$ROOT/public/templates/zabbix-triggers-sample.json' && grep -q 'legacy' '$ROOT/tests/unit/zabbix-import.test.ts'"
run "zabbix-import: UI format select wired with per-format samples" bash -c "grep -q 'zabbix-triggers-sample.json' '$ROOT/src/components/sentinel/alerting/import-grafana-card.tsx' && grep -q 'sourceZabbix' '$ROOT/src/components/sentinel/alerting/import-grafana-card.tsx'"
run "zabbix-import: i18n strings present in BOTH dictionaries" bash -c "grep -q 'sourceZabbix' '$ROOT/src/lib/i18n/en.ts' && grep -q 'sourceZabbix' '$ROOT/src/lib/i18n/fa.ts' && grep -q 'alerting.import.sourceLabel' '$ROOT/src/lib/i18n/fa.ts'"
run "zabbix-import: live smoke script exists (dry-run zero-write + 422 abort proof)" bash -c "test -f '$ROOT/scripts/zabbix-import-smoke.sh' && bash -n '$ROOT/scripts/zabbix-import-smoke.sh' && grep -q 'source.*zabbix' '$ROOT/scripts/zabbix-import-smoke.sh'"
run "zabbix-import: guides + API.md document the Zabbix journey" bash -c "grep -q 'Zabbix' '$ROOT/docs/USER-GUIDE.md' && grep -q 'زبیکس' '$ROOT/docs/USER-GUIDE.fa.md' && grep -q 'trigger.get' '$ROOT/docs/API.md'"

# ── Jira/Redmine/Mattermost delivery ────
run "ticketing: settings column on NotificationChannel + ref column on DeliveryLog (both schemas)" bash -c "grep -q 'settings       String?' '$ROOT/prisma/schema.prisma' && grep -q 'ref        String?' '$ROOT/prisma/schema.prisma' && grep -q 'settings       String?' '$ROOT/prisma/schema.postgres.prisma' && grep -q 'ref        String?' '$ROOT/prisma/schema.postgres.prisma'"
run "ticketing: ChannelKind extended + per-kind settings interfaces in types" bash -c "grep -q \"'mattermost' | 'jira' | 'redmine'\" '$ROOT/src/lib/types.ts' && grep -q 'JiraChannelSettings' '$ROOT/src/lib/types.ts' && grep -q 'RedmineChannelSettings' '$ROOT/src/lib/types.ts' && grep -q 'MattermostChannelSettings' '$ROOT/src/lib/types.ts'"
run "ticketing: three real adapters wired to the documented endpoints" bash -c "grep -q 'rest/api/2/issue' '$ROOT/src/server/notify/adapters.ts' && grep -q 'issues.json' '$ROOT/src/server/notify/adapters.ts' && grep -q 'x-redmine-api-key' '$ROOT/src/server/notify/adapters.ts' && grep -q 'export async function sendMattermost' '$ROOT/src/server/notify/adapters.ts' && grep -q 'export async function sendJira' '$ROOT/src/server/notify/adapters.ts' && grep -q 'export async function sendRedmine' '$ROOT/src/server/notify/adapters.ts'"
run "ticketing: jira dual auth (email:token Basic vs PAT Bearer) + created-issue ref" bash -c "grep -q \"secret.includes(':')\" '$ROOT/src/server/notify/adapters.ts' && grep -q 'Bearer ' '$ROOT/src/server/notify/adapters.ts' && grep -q 'ref?: string' '$ROOT/src/server/notify/adapters.ts'"
run "ticketing: settings parsed at the adapter boundary with honest refusals" bash -c "grep -q 'export function parseChannelSettings' '$ROOT/src/server/notify/adapters.ts' && grep -q 'channel-settings-invalid-json' '$ROOT/src/server/notify/adapters.ts' && grep -q 'jira-settings-missing-projectKey' '$ROOT/src/server/notify/adapters.ts' && grep -q 'redmine-settings-missing-projectId' '$ROOT/src/server/notify/adapters.ts'"
run "ticketing: dispatchByKind carries channel settings and routes the three kinds" bash -c "grep -q 'channelSettingsRaw' '$ROOT/src/server/notify/adapters.ts' && grep -q \"case 'mattermost':\" '$ROOT/src/server/notify/adapters.ts' && grep -q \"case 'jira':\" '$ROOT/src/server/notify/adapters.ts' && grep -q \"case 'redmine':\" '$ROOT/src/server/notify/adapters.ts'"
run "ticketing: outbox reads settings live, records ref, and digests skip ticket systems" bash -c "grep -q 'SELECT secret, settings FROM NotificationChannel' '$ROOT/src/server/notify/outbox.ts' && grep -q 'ref: result.ref ?? null' '$ROOT/src/server/notify/outbox.ts' && grep -q \"kind NOT IN ('jira', 'redmine')\" '$ROOT/src/server/notify/outbox.ts'"
run "ticketing: create-channel schema validates settings per kind (refine)" bash -c "grep -q \"'mattermost', 'jira', 'redmine'\" '$ROOT/src/server/validation.ts' && grep -q 'jiraSettingsSchema' '$ROOT/src/server/validation.ts' && grep -q 'redmineSettingsSchema' '$ROOT/src/server/validation.ts' && grep -q 'settings are not used by' '$ROOT/src/server/validation.ts'"
run "ticketing: per-kind target validation (mattermost URL; jira/redmine base URL only)" bash -c "grep -q \"kind === 'webhook' || kind === 'mattermost'\" '$ROOT/src/server/alertgovernance.ts' && grep -q 'base URL without a path' '$ROOT/src/server/alertgovernance.ts' && grep -q 'settings' '$ROOT/src/server/alertgovernance.ts'"
run "ticketing: UI form carries per-kind fields (jira project/type, redmine project, mm overrides)" bash -c "grep -q 'ch-jira-project' '$ROOT/src/components/sentinel/alerting/notifications-parts.tsx' && grep -q 'ch-redmine-project' '$ROOT/src/components/sentinel/alerting/notifications-parts.tsx' && grep -q 'ch-mm-channel' '$ROOT/src/components/sentinel/alerting/notifications-parts.tsx' && grep -q 'value=\"redmine\"' '$ROOT/src/components/sentinel/alerting/notifications-parts.tsx' && grep -q 'USE_SECRET' '$ROOT/src/components/sentinel/alerting/notifications-parts.tsx'"
run "ticketing: i18n strings present in BOTH dictionaries (hints + kind labels)" bash -c "grep -q 'settings.notif.ch.targetHint.jira' '$ROOT/src/lib/i18n/en.ts' && grep -q 'settings.notif.ch.targetHint.jira' '$ROOT/src/lib/i18n/fa.ts' && grep -q 'settings.notif.ch.secretHint.redmine' '$ROOT/src/lib/i18n/fa.ts' && grep -q 'gov.channels.kind.mattermost' '$ROOT/src/lib/i18n/en.ts' && grep -q 'gov.channels.kind.redmine' '$ROOT/src/lib/i18n/fa.ts'"
run "ticketing: OpenAPI documents kinds + settings + DeliveryLogRow.ref; API.md regenerated" bash -c "grep -q 'telegram, bale, webhook, email, mattermost, jira, redmine' '$ROOT/openapi/openapi.yaml' && grep -q 'ref: { type: string, nullable: true, description' '$ROOT/openapi/openapi.yaml' && grep -c 'mattermost' '$ROOT/docs/API.md' | grep -qv '^0\$'"
run "ticketing: unit tests pin transports against local mock servers" bash -c "test -f '$ROOT/tests/unit/notify-ticketing.test.ts' && grep -q 'sendJira' '$ROOT/tests/unit/notify-ticketing.test.ts' && grep -q 'createServer' '$ROOT/tests/unit/notify-ticketing.test.ts' && grep -q 'Bearer pat-token' '$ROOT/tests/unit/notify-ticketing.test.ts'"
run "ticketing: live smoke script exists (mock receivers + dispatcher proof)" bash -c "test -f '$ROOT/scripts/ticketing-delivery-smoke.sh' && bash -n '$ROOT/scripts/ticketing-delivery-smoke.sh' && grep -q 'mattermost' '$ROOT/scripts/ticketing-delivery-smoke.sh' && grep -q 'jira' '$ROOT/scripts/ticketing-delivery-smoke.sh'"

# ── guided setup / onboarding checklist ─
run "onboarding: pure status module (compute + progress, no db imports)" bash -c "test -f '$ROOT/src/server/onboarding.ts' && grep -q 'export function computeOnboardingSteps' '$ROOT/src/server/onboarding.ts' && grep -q 'export function onboardingProgress' '$ROOT/src/server/onboarding.ts' && ! grep -qE \"from '@/lib/db'|from '@/server/engine'\" '$ROOT/src/server/onboarding.ts'"
run "onboarding: route aggregates real counts with the selftest exclusion + honest demo mode" bash -c "test -f '$ROOT/src/app/api/onboarding/route.ts' && grep -q 'requireUser' '$ROOT/src/app/api/onboarding/route.ts' && grep -q \"key != 'selftest-synthetic'\" '$ROOT/src/app/api/onboarding/route.ts' && grep -q 'readPrometheusSettings' '$ROOT/src/app/api/onboarding/route.ts'"
run "onboarding: OpenAPI documents the operation (path + schemas + global tag); API.md regenerated" bash -c "grep -q 'getOnboardingStatus' '$ROOT/openapi/openapi.yaml' && grep -q 'OnboardingStep:' '$ROOT/openapi/openapi.yaml' && grep -q 'OnboardingStatus:' '$ROOT/openapi/openapi.yaml' && grep -q 'name: onboarding' '$ROOT/openapi/openapi.yaml' && grep -q '/api/onboarding' '$ROOT/docs/API.md' && grep -q 'OnboardingStatus' '$ROOT/docs/API.md'"
run "onboarding: contract test exercises GET /api/onboarding" bash -c "grep -q \"'/api/onboarding'\" '$ROOT/tests/integration/api-contract.mjs'"
run "onboarding: UI card mounted on the command center with per-browser dismissal" bash -c "test -f '$ROOT/src/components/sentinel/getting-started.tsx' && grep -q 'GettingStartedCard' '$ROOT/src/components/sentinel/engineer-view.tsx' && grep -q 'sentinel.onboarding.dismissed' '$ROOT/src/components/sentinel/getting-started.tsx' && grep -q 'allDone' '$ROOT/src/components/sentinel/getting-started.tsx'"
run "onboarding: i18n strings present in BOTH dictionaries (title + steps + demo marker)" bash -c "grep -q 'onboarding.step.prometheus' '$ROOT/src/lib/i18n/en.ts' && grep -q 'onboarding.step.prometheus' '$ROOT/src/lib/i18n/fa.ts' && grep -q 'شروع کار' '$ROOT/src/lib/i18n/fa.ts' && grep -q 'onboarding.demo' '$ROOT/src/lib/i18n/fa.ts'"
run "onboarding: unit goldens + fast-check pin the pure computation" bash -c "test -f '$ROOT/tests/unit/onboarding.test.ts' && grep -q 'fast-check' '$ROOT/tests/unit/onboarding.test.ts' && grep -q 'demoSignalSource' '$ROOT/tests/unit/onboarding.test.ts'"
run "onboarding: guides (EN + FA) + CHANGELOG document the checklist" bash -c "grep -q 'Getting started (guided setup)' '$ROOT/docs/USER-GUIDE.md' && grep -q 'راه‌اندازی راهنمادار' '$ROOT/docs/USER-GUIDE.fa.md' && grep -q 'getting-started checklist' '$ROOT/CHANGELOG.md'"
run "onboarding: demo marker honest — demo never claims a connected Prometheus" bash -c "grep -q 'demoSignalSource' '$ROOT/src/server/onboarding.ts' && grep -q 'demoSignalSource: !c.prometheusConfigured && c.mode' '$ROOT/src/server/onboarding.ts'"

# ── meta: pinned check total (bump when adding checks; +2 per tool present) ──
# Guards against silent check-count drift. docker/helm/go each add exactly 2 checks
# (tooling presence + their block), so the pinned base is the no-tool total.
TOOL_BONUS=0
command -v docker >/dev/null 2>&1 && TOOL_BONUS=$((TOOL_BONUS + 2))
command -v helm  >/dev/null 2>&1 && TOOL_BONUS=$((TOOL_BONUS + 2))
command -v go    >/dev/null 2>&1 && TOOL_BONUS=$((TOOL_BONUS + 2))
EXPECTED_TOTAL=$((584 + TOOL_BONUS))
TOTAL_RUN=$((PASS + FAIL + 1))
run "meta: check total matches the pinned count" bash -c "test \$1 -eq \$2" _ "$TOTAL_RUN" "$EXPECTED_TOTAL"

# >>> Append new check sections immediately above this line — the summary
# ── summary ────────────────────────────────────────────────────────────────
header "Summary"
printf '  %d passed, %d failed, checks run from %s\n' "$PASS" "$FAIL" "$ROOT"
if [ "$FAIL" -gt 0 ]; then
  printf '  failed checks:\n'
  for name in "${FAILED_NAMES[@]}"; do printf '    - %s\n' "$name"; done
  exit 1
fi
printf '  \033[32mALL CHECKS PASSED\033[0m — stack configurations are ready to deploy.\n'
exit 0

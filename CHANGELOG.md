# Changelog

All notable changes to Sentinel-SLA are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-10-08

Complete rebuild of the 0.x prototype: security core, domain model with integer
money math, live Prometheus ingestion, executive PDF reporting (English and
Persian), chaos-validated detection, and a documented operator surface
(install, backup, restore, upgrade).

### Added

- **Security core** — argon2id password hashing (hash-wasm), sha256-stored
  sessions (8 h idle, 7 d absolute), login lockout (5 attempts / 15 min),
  `/setup` first-run wizard and an audit log UI.
- **RBAC** — roles `admin > engineer > executive > viewer` enforced on all
  46 API routes, verified by 128 generated authorization checks. Tenant scoping
  through `resolveTenantScope`: an out-of-scope `?tenant=` returns 403.
- **Rate limiting** — sliding-window limiter (fails open, sends `Retry-After`) on
  login, setup, reports, exports and user mutations.
- **Domain model** — services with money models (lost transactions × value plus
  SLA penalties, computed in integer Tomans with no floating-point money),
  incidents with evidence chains, maintenance windows and contracts.
- **Live ingestion** — Prometheus adapter (connection managed in
  Settings → Integrations), Alertmanager webhook ingestion with bearer auth and
  idempotency, a transactional outbox notification dispatcher (Telegram and Bale
  acknowledge links signed with `SENTINEL_ACK_SECRET`), escalation, digests and a
  self-test scheduler.
- **Executive reports** — WeasyPrint PDF pipeline with three templates in English
  and Persian from one data snapshot, a tamper-evident SHA-256 title block,
  archive/regenerate/download and scheduled statements. Persian output (RTL,
  Vazirmatn) is covered by a pixel-regression test.
- **Chaos and resilience** — forced-failure self-test on `/resilience` with MTTD
  and MTTR measurement; target MTTD < 60 s.
- **Observability stack** — Prometheus, Grafana, Loki, Promtail, Alertmanager and
  blackbox exporter under `deploy/`, a custom Go business-metrics exporter
  (`exporter/`) publishing lost transactions, revenue loss and penalties, and a
  Helm chart with a ServiceMonitor.
- **Guided setup (getting-started checklist)** — the command center shows a live onboarding
  checklist until the instance is configured: signal source (stored Prometheus
  connection, or a labelled demo-simulation marker), first tenant, first service,
  services attached to client tenants, first notification channel and first
  report. Each row shows the real count behind it and links to the page for that
  step. The card is dismissible per browser. Backed by `GET /api/onboarding`
  (read-only, viewer and above, no configuration values returned).
- **Jira, Redmine and Mattermost delivery channels** — Mattermost incoming
  webhooks, Jira issue creation through REST v2 (`email:api-token` uses Basic
  auth, a bare PAT uses Bearer) and Redmine issue creation (`X-Redmine-API-Key`).
  Tickets are recorded by reference in the delivery log. The periodic executive
  digest never opens tickets. Per-kind non-secret settings are stored on the
  channel and validated at both the API and the adapter.
- **Shaparak/PSP transaction-count import** — hourly transaction-count CSVs
  (Persian or English headers, Jalali or Gregorian dates, Latin, Persian or
  Arabic-Indic digits) import as a 168-bucket hour-of-week tps profile per
  service. Live incidents are priced at the incident hour's own rate, and the
  resolution event names the bucket used. Dry-run by default, all-or-nothing
  commit, audited import and removal, and a recorded fallback to the flat rate if
  a stored profile is corrupt.
- **CSV import of contracts and services** — one row per service with its SLA
  contract terms (availability target, penalties, tier). RFC 4180 parser,
  per-row validation, dry-run that writes nothing, all-or-nothing commit, a
  downloadable template and a row-by-row report by CSV line
  (`POST /api/services/import`, Settings → Services → Import CSV).
- **Grafana alert-rule import** — paste or upload the JSON export of Grafana
  unified alerting. Each rule's PromQL threshold maps onto one of four Sentinel
  metrics, or is reported as unmapped with the exact reason (`up == 0` → uptime;
  error ratios → errorRate; duration-declared metrics → latencyMs with
  seconds-to-milliseconds conversion; request counter rates → throughput).
  Grafana's `for` duration becomes the cooldown. A `service` label must resolve
  against the registry or the import aborts. Dry-run by default; sample at
  `/templates/grafana-alerts-sample.json` (`POST /api/rules/import`).
- **Zabbix trigger import** — `POST /api/rules/import` accepts
  `source: grafana | zabbix` (default `grafana`) and the JSON array from the
  Zabbix `trigger.get` API, in both 5.4+ and legacy expression syntax.
  Availability items map to uptime, service performance items to latencyMs, and
  request or transaction rates to throughput. Host-resource and disabled
  triggers are refused with a reason. Sample at
  `/templates/zabbix-triggers-sample.json`.
- **Contract template library** — six common Iranian fintech SLA shapes (from a
  Shaparak-style switching gateway to an SMS notification panel) pre-fill the
  onboarding wizard with example terms in integer Tomans. They are validated
  against the same zod shapes as the API and pinned by golden penalty
  fingerprints. Replace the example values with the signed contract's numbers.
- **Support tooling** — `sentinel-doctor` (`./doctor.sh`) produces a redacted
  diagnostic bundle: host and tool versions, config key names, process liveness,
  health endpoints, recent engine log, per-table counts and backup listing. It
  never includes `.env` values, tokens or rows.
- **Operator scripts** — `install.sh` (five questions, generated secrets, `.env`
  mode 600, health wait), `upgrade.sh` (backup, migrate, rebuild, health check,
  automatic rollback), `backup.sh` and `restore.sh` (SHA256SUMS verified before
  restore) and `backup-restore-test.sh`, which proves a destroy and restore
  reproduces identical state.
- **Documentation** — INSTALL, OPERATIONS (with Caddy and Nginx TLS examples),
  USER-GUIDE (English and Persian), ADMIN-GUIDE, API (from
  `openapi/openapi.yaml`), ARCHITECTURE (C4 levels 1–3), SECURITY, DOMAIN,
  DESIGN-SYSTEM, DEVELOPMENT, THIRD_PARTY_NOTICES, SUPPORT and RELEASE.
- **Release artefacts** — `sentinel-sla-2.0.0.tar.gz` (tracked tree plus SBOM), a
  CycloneDX 1.5 SBOM (npm closure, the six pinned monitoring images and the Go
  exporter module), SHA256SUMS and a build manifest (`scripts/build-release.sh`).
  `scripts/docker-save-release.sh` builds a `docker save` bundle for air-gapped
  installs and needs a Docker daemon.

### Changed

- TypeScript is strict everywhere (`noImplicitAny`), and type errors fail the build.
- Next.js upgraded from 16.1.3 to 16.4.0, which closes two critical RCEs and
  several high advisories.
- Docker: the runtime image ships WeasyPrint (venv) and the full `node_modules`
  (worker and `prisma` CLI). `docker-compose.yml` runs the app on SQLite in a
  named volume with a one-shot `migrate` job. The monitoring stack is
  `deploy/docker-compose.yml`.
- `install.sh` creates `.venv`, installs `reports/requirements.txt` and writes
  `REPORT_PYTHON`. `.env.example` has an active `DATABASE_URL`.
- `/api/health/ready` no longer requires a system FreeSerif font (fonts are bundled).
- `/api/ai/postmortem` uses an OpenAI-compatible endpoint (`LLM_*`).
- Package scripts run with `bun`; Node.js is not required.
- Accessibility: Lighthouse accessibility score 100/100 on all eight audited
  routes, contrast fixes based on real token pairs, WCAG 2.5.3 label-in-name and
  screen-reader paths for brand and avatar glyphs.
- Per-language i18n bundles: English ships statically and Persian loads on
  demand, cutting 13.3 KB of initial JS per page (home 309.3 → 296.0 KB gzip).
  English is the fallback while the Persian bundle loads.
- New logo (`public/logo.svg`). `exporter/go.sum` is committed.

### Removed

- `next-intl` and `js-cookie` dependencies (unused, with a high-severity advisory chain).
- The loose `?tenant=` query parameter on dashboard and analytics, replaced by
  server-enforced tenant scoping.
- `ignoreBuildErrors` and `PYTHON_BIN` guessing. Configuration now fails fast
  with named environment hints.

### Security

- Dependency audit: 0 critical and 0 unexplained high advisories
  (see [SECURITY.md](docs/SECURITY.md)).
- The generated authorization matrix test runs in CI, and a route enumeration
  test prevents regressions.

### Known issues

- PostgreSQL is not supported. A synchronised Postgres Prisma schema exists, but about
  100 raw SQL statements use SQLite identifier and date semantics and must be ported
  first. SQLite is the only supported database.

## [0.2.1] and earlier

Prototype releases, not production-grade and not documented here.

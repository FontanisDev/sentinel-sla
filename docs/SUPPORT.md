# Support — Sentinel-SLA v2.0.0

This page states what the v2.0.0 release supports, what it deliberately does not, and
gives the severity definitions used when triaging reports. This is an open-source
project: support is best-effort through GitHub Issues, with no guaranteed response
times or support hours.

---

## 1. What is supported in v2.0.0

| Area | Supported scope |
|---|---|
| Installation | Single-node install via `install.sh` (Demo and Live mode), docker-compose topology (`deploy/docker-compose.yml`), Helm chart `deploy/helm/sentinel-sla`. Upgrade via `upgrade.sh` (auto-backup, health check, automatic rollback), backup/restore via `backup.sh` / `restore.sh`. |
| Modes | Demo (simulation, zero external dependencies) and Live (Prometheus-polling ingestion). Mode is set at install time and validated at boot. |
| Detection | Probe-based incident detection with configurable open/resolve streaks, STALE ("monitoring blind") handling, escalation ladder, on-call schedules, maintenance windows, alert rules. |
| Money & contracts | Contract penalty computation (tier and fixed+per-minute schemes), versioned money models, revenue-loss accrual, penalty caps, grace minutes, exclusion policy. Every figure traces to the formulas in `docs/DOMAIN.md` and `docs/ARCHITECTURE.md` §5. |
| Notifications | Telegram, Bale, HMAC-signed generic webhooks; transactional outbox with delivery receipts, retries, dead-letter queue and manual retry; daily digest. |
| Reports | Executive / technical / monthly PDF reports in English and Persian (Jalali dates), scheduled or on demand, downloadable and deliverable via Telegram. |
| Reporting surfaces | Executive home (money strip, cost-of-downtime, error budgets), engineer views (services, incidents with evidence), contracts, analytics/exports, resilience page, audit log, user administration. |
| Auth & tenancy | Local accounts (argon2id), session and API-token auth, five-level role floors, per-tenant membership scoping, audit log of sensitive mutations. |
| Browsers | Current Chromium, Firefox and Safari (Evergreen); the UI is verified in dark and light themes for both EN and FA. |

## 2. What is explicitly **not** supported in v2.0.0

- **Email / SMS / Slack notification channels** — the adapter surface is built for them,
  but v2.0.0 ships Telegram, Bale and signed webhooks only.
- **High availability / multi-node app replicas** — single active worker by design
  (advisory-locked schedulers); active-active is a next-cycle item.
- **PostgreSQL** — not working. A Postgres Prisma schema is kept in sync, but roughly 100
  hand-written SQL statements use SQLite identifier and date semantics and would have to
  be ported (the app fails on Postgres with `relation "tenant" does not exist`). Planned
  for when a deployment needs it; until then SQLite is the only database, and the Helm
  chart and Compose files use it.
- **Non-Prometheus metric sources** — Live mode ingests from Prometheus (or Alertmanager
  webhooks). Zabbix and Grafana rule import, CSV onboarding and Jira ticketing exist, but
  there is no direct Zabbix/Redmine metric ingestion.
- **Automatic DB failover** — backup/restore and upgrade rollback are the recovery path.
- **Browser targets older than the evergreen set above**, and IE/legacy Edge.

## 3. Environment prerequisites (supported install targets)

- Linux x86-64 with Docker + docker compose (deploy topology 2), or Kubernetes 1.28+
  with the Helm chart (topology 3), or a bare host able to run the Bun runtime ≥ 1.3
  (topology 1) with Python 3.10+ and the GNU FreeFont fonts installed.
- SQLite (the only supported database; see section 2).
- Outbound network **only** for: the configured Prometheus URL (Live mode) and the
  configured notification endpoints. Everything else runs offline.

## 4. How to report a problem

1. Reproduce against the latest v2.0.x tag; check `docs/OPERATIONS.md` § troubleshooting
   (the eight most common failure signatures are listed there with commands).
2. Collect: `GET /api/health/ready` output, the last ~200 lines of app logs (the log
   prefixes `[sentinel]`, `[sentinel:reports]`, `[sentinel:outbox]` mark the subsystems),
   the exact request (method, path, body shape) and what the UI showed.
3. Include the mode (`demo`/`live`), install topology and version (`git describe` or the
   release tarball name). The fastest way to hand over steps 2–3 safely is the
   diagnostic bundle: `./doctor.sh` (redacted by construction — see
   `docs/OPERATIONS.md` §5). Redact tokens — support never needs your bot tokens or
   `SENTINEL_ACK_SECRET`; **never send `.env` or the database file** (they contain
   credentials; see `docs/OPERATIONS.md` on backups-as-credentials).
4. For money-figure disputes: the incident page's formula section and the report PDF
   embed the inputs (minutes, tier, weights, exclusions); attach both PDFs (expected vs
   produced) — these are the artefacts the number can be re-derived from.

## 5. Support terms

| Item | Value |
|---|---|
| Support hours | None guaranteed (best effort) |
| First-response time | None guaranteed |
| Support channel | GitHub Issues |
| Severity definitions | P1 = cannot install or the product is down; P2 = a money figure, notification or report is wrong; P3 = cosmetic or documentation issue |
| Language(s) of support | English; the product UI ships EN + FA |

## 6. Lifecycle commitments (v2.0.0 line)

- Semver: breaking API changes require a major version; the OpenAPI document
  (`openapi/openapi.yaml`) is the contract, `docs/API.md` is generated from it, and CI
  enforces both (`lint:spec`, the route/spec parity check and the API.md drift check).
- Database migrations ship with each release (`migrate` one-shot in compose; Prisma
  migrate in the Helm path); downgrades are not supported — take a backup first
  (`backup.sh`).
- Security-relevant fixes land as patch releases and are summarised in `CHANGELOG.md`
  under the affected version.

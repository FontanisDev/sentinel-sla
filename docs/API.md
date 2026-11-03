# API Reference

> **Generated from `openapi/openapi.yaml`** (OpenAPI 3.0.3, v2.0.0) — do not edit by hand.
> Regenerate with `bun run docs:api`; CI fails when this file drifts from the spec.
> The spec is machine-enforced: `bun run lint:spec` lints it (Spectral + the official
> OpenAPI JSON-Schema) and `tests/integration/api-contract.mjs` calls every endpoint and
> validates each response against these schemas.

The money-and-contract layer on top of Prometheus. Translates technical outages into executive financial impact — lost transactions and SLA penalties in integer Tomans — with Persian/Jalali executive surfaces and bilingual alerting (technical Telegram/Bale for engineers, executive briefs for the CEO). In demo mode the built-in simulation engine (2500 ms tick) produces the data; in live mode metrics are ingested from Prometheus/Alertmanager. Detection speed is self-tested with chaos experiments (MTTD gate).

## Authentication

Every operation requires a signed-in principal unless explicitly marked **public**:

- **Browser** — the HTTP-only `sentinel_session` cookie set by `POST /api/auth/login` (or first-run setup).
- **Machine** — `Authorization: Bearer <api-token>` (hashed, prefix-visible, expiring tokens).
- Role floors (`owner > admin > engineer > executive > viewer`) are enforced server-side by
  `src/server/authz.ts`; the full route-by-route matrix lives in `docs/SECURITY.md` and is
  proven by `tests/integration/authz-matrix.mjs`.

All errors share one envelope: `{ "error": string, "details"?: string[] }`
(with `details` carrying zod field messages on validation failures).

## Operations

| Method | Path | Summary |
|--------|------|---------|
| `GET` | `/api` | API index |
| `GET` | `/api/health/live` | Liveness probe |
| `GET` | `/api/health/ready` | Readiness probe |
| `GET` | `/api/onboarding` | Getting-started checklist |
| `POST` | `/api/auth/login` | Sign in |
| `POST` | `/api/auth/logout` | Sign out |
| `GET` | `/api/auth/session` | Session introspection |
| `GET` | `/api/auth/setup` | First-run availability |
| `POST` | `/api/auth/setup` | Create the first owner account |
| `GET` | `/api/dashboard` | Overview snapshot |
| `POST` | `/api/engine` | Control the simulation engine |
| `GET` | `/api/chaos` | Recent chaos experiments |
| `POST` | `/api/chaos` | Start a chaos experiment |
| `POST` | `/api/chaos/auto` | Toggle automatic chaos |
| `GET` | `/api/incidents` | Incident feed |
| `GET` | `/api/incidents/{id}` | Incident detail |
| `POST` | `/api/incidents/{id}/acknowledge` | Acknowledge an incident |
| `POST` | `/api/incidents/{id}/resolve` | Resolve an incident |
| `GET` | `/api/services` | Service fleet |
| `POST` | `/api/services` | Register a service |
| `GET` | `/api/services/{key}` | Service detail |
| `POST` | `/api/services/{key}/tps-profile` | Import a Shaparak/PSP transaction-count CSV as the hour-of-week tps profile |
| `DELETE` | `/api/services/{key}/tps-profile` | Remove the transaction profile (fall back to the flat tps) |
| `POST` | `/api/services/import` | Bulk CSV import of services + contract terms |
| `POST` | `/api/services/preview` | Preview a probe source |
| `GET` | `/api/tenants` | Tenant list |
| `POST` | `/api/tenants` | Create a tenant |
| `GET` | `/api/alerts` | Notification feed |
| `GET` | `/api/analytics` | Error budgets, trends, heatmap |
| `GET` | `/api/contracts` | Contract compliance snapshot |
| `GET` | `/api/maintenance` | Maintenance windows |
| `POST` | `/api/maintenance` | Schedule a maintenance window |
| `POST` | `/api/maintenance/{id}/cancel` | Cancel a maintenance window |
| `GET` | `/api/rules` | Alert policy rules |
| `POST` | `/api/rules` | Create an alert rule |
| `DELETE` | `/api/rules/{id}` | Delete an alert rule |
| `POST` | `/api/rules/{id}/toggle` | Enable/disable an alert rule |
| `POST` | `/api/rules/import` | Bulk import of Grafana or Zabbix alert rules |
| `GET` | `/api/channels` | Notification channels |
| `POST` | `/api/channels` | Create a channel |
| `PATCH` | `/api/channels/{id}` | Edit a channel |
| `DELETE` | `/api/channels/{id}` | Delete a channel |
| `POST` | `/api/channels/{id}/test` | Send a test message |
| `POST` | `/api/channels/{id}/toggle` | Enable/disable a channel |
| `GET` | `/api/oncall` | On-call rotation |
| `POST` | `/api/oncall` | Add a rotation entry |
| `DELETE` | `/api/oncall/{id}` | Remove a rotation entry |
| `GET` | `/api/escalation` | Escalation policy |
| `PUT` | `/api/escalation` | Edit the escalation policy |
| `GET` | `/api/notifications/delivery` | Delivery log |
| `GET` | `/api/notifications/outbox` | Outbox contents |
| `POST` | `/api/notifications/outbox` | Retry a dead-letter notification |
| `GET` | `/api/notifications/templates` | Message templates |
| `GET` | `/api/reports` | Report archive |
| `POST` | `/api/reports` | Generate a report |
| `GET` | `/api/reports/{id}/download` | Download a report PDF |
| `POST` | `/api/reports/{id}/regenerate` | Regenerate a report |
| `GET` | `/api/schedules` | Report schedules |
| `POST` | `/api/schedules` | Create a report schedule |
| `DELETE` | `/api/schedules/{id}` | Delete a schedule |
| `POST` | `/api/schedules/{id}/run` | Run a schedule now |
| `POST` | `/api/schedules/{id}/toggle` | Enable/disable a schedule |
| `GET` | `/api/schedules/runs` | Schedule run ledger |
| `GET` | `/api/export/analytics` | Export analytics |
| `GET` | `/api/export/incidents` | Export incidents |
| `GET` | `/api/export/services` | Export services |
| `GET` | `/api/metrics/history` | Live metric history for one service |
| `GET` | `/api/resilience` | Self-test state |
| `POST` | `/api/resilience` | Run the self-test now |
| `PUT` | `/api/resilience` | Edit the self-test schedule |
| `POST` | `/api/ai/postmortem` | Generate a post-mortem summary |
| `POST` | `/api/integrations/alertmanager` | Alertmanager webhook receiver |
| `GET` | `/api/integrations/digest` | Executive digest schedule |
| `POST` | `/api/integrations/digest` | Send the digest now |
| `PUT` | `/api/integrations/digest` | Edit the digest schedule |
| `GET` | `/api/integrations/notify` | Notification transport settings |
| `PUT` | `/api/integrations/notify` | Set the notification transport |
| `GET` | `/api/integrations/prometheus` | Prometheus connection status |
| `PUT` | `/api/integrations/prometheus` | Set the Prometheus connection |
| `POST` | `/api/integrations/prometheus/test` | Test the Prometheus connection |
| `POST` | `/api/integrations/telegram/callback` | Telegram/Bale ACK callback |
| `GET` | `/api/users` | Account list |
| `POST` | `/api/users` | Create an account |
| `PATCH` | `/api/users/{id}` | Edit an account |
| `DELETE` | `/api/users/{id}` | Delete an account |
| `DELETE` | `/api/users/{id}/sessions` | Revoke an account's sessions (sign-out-everywhere) |
| `GET` | `/api/audit` | Audit trail |

## health

Liveness/readiness probes (public, used by kubelet/Helm)

### `GET /api` — API index

Authenticated ping — proves the API surface answers behind the session.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Greeting envelope | inline object |
| `401` |  | — |

### `GET /api/health/live` — Liveness probe

**Public** (no session required).

Public. Fails only when the process cannot compute its own configuration (fail-fast boot contract).

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Process alive and configuration valid | HealthLive |
| `500` | Configuration invalid | HealthLive |

### `GET /api/health/ready` — Readiness probe

**Public** (no session required).

Public. Checks database reachability, data dir writability and engine/ingestion boot state.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | All checks pass | HealthReady |
| `500` | One or more checks fail | HealthReady |

## onboarding

Guided-setup checklist — read-only live counts per setup step

### `GET /api/onboarding` — Getting-started checklist

Read-only onboarding status — real counts per setup step (tenants, services excluding the self-test synthetic target, tenant-bound services, channels, reports) plus the signal-source state (stored Prometheus connection, or an honest demo-simulation marker in demo mode). Every role sees it; no configuration values are echoed.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Ordered checklist with live counts | OnboardingStatus |
| `401` |  | — |

## auth

Sign-in, sign-out, first-run setup, session introspection

### `POST /api/auth/login` — Sign in

**Public** (no session required).

Public. Sets the `sentinel_session` cookie. Rate-limited (10 attempts / 5 min); lockout after repeated failures; audited.

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Authenticated; cookie set | LoginResponse |
| `400` |  | — |
| `401` | Invalid credentials | ErrorEnvelope |
| `429` |  | — |

### `POST /api/auth/logout` — Sign out

Revokes the current session and clears the cookie. Audited.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Session revoked | Ok |
| `401` |  | — |

### `GET /api/auth/session` — Session introspection

**Public** (no session required).

Public by design — the login page calls it to decide where to route.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Current session state | SessionInfo |

### `GET /api/auth/setup` — First-run availability

**Public** (no session required).

Public. `available: true` when no account exists yet — the installer/first-run wizard keys off this.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Setup availability | inline object |

### `POST /api/auth/setup` — Create the first owner account

**Public** (no session required).

Public but one-shot — 403 once any account exists. Creates the owner, signs the session in, audited.

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `201` | Owner created; cookie set | LoginResponse |
| `400` |  | — |
| `403` | Setup already completed | ErrorEnvelope |

## dashboard

One snapshot powering the Overview page

### `GET /api/dashboard` — Overview snapshot

One payload powering the Overview page: engine state, KPI strip, tenants (for the switcher), services with live series, recent incidents/alerts/chaos/reports, maintenance windows, alert rules, channels, on-call, escalation policy, report schedules and schedule runs. Tenant scope is enforced server-side (`?tenant=<id>` for scoped users; admin/owner see everything).

| Parameter | In | Description |
|-----------|-----|-------------|
| `tenant` | query | Tenant id to scope by (admin/owner may omit for fleet-wide; scoped users must hold a membership — see resolveTenantScope). |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Snapshot (demo or live data per deployment mode) | Dashboard |
| `401` |  | — |
| `403` |  | — |

## engine

Simulation engine control (demo mode)

### `POST /api/engine` — Control the simulation engine

Demo mode only — pause/resume or switch simulation intensity (calm/normal/storm). Audited.

Request body (required): **EngineAction**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | New engine state | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

## chaos

Chaos experiments — detection-speed self-tests (MTTD/MTTR)

### `GET /api/chaos` — Recent chaos experiments

Newest-first experiment history with MTTD/MTTR and the gate verdict per run.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Newest-first experiment feed | inline object |
| `401` |  | — |

### `POST /api/chaos` — Start a chaos experiment

Injects an outage/latency/error-spike fault on one service for 10–300 s (default 45). The engine measures MTTD; gate target < 60 s. Audited.

Request body (required): **ChaosPayload**

| Status | Description | Schema |
|--------|-------------|--------|
| `201` | Experiment started | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

### `POST /api/chaos/auto` — Toggle automatic chaos

When enabled, the engine starts a random experiment every 1–30 min (default 3). Audited.

Request body (required): **AutoChaosPayload**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | New auto-chaos state | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

## incidents

Incident lifecycle — feed, detail, acknowledge, resolve

### `GET /api/incidents` — Incident feed

Newest-first, optional status filter and inclusive `startedAt` bounds (the server twin of the UI TimeRange picker).

| Parameter | In | Description |
|-----------|-----|-------------|
| `limit` | query |  |
| `status` | query |  |
| `since` | query | Inclusive lower bound on startedAt (ISO datetime with offset) |
| `until` | query | Inclusive upper bound on startedAt (ISO datetime with offset) |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Incident page | inline object |
| `400` |  | — |
| `401` |  | — |

### `GET /api/incidents/{id}` — Incident detail

The /incidents/[id] page payload — the incident, notifications sent about it (evidence panel) and the other incidents of the same service (context panel).

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Detail payload | IncidentDetail |
| `401` |  | — |
| `404` |  | — |

### `POST /api/incidents/{id}/acknowledge` — Acknowledge an incident

On-call took ownership — stamps acknowledgedAt/by, computes MTTA, stops the escalation ladder. 409 when already acknowledged. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

Request body (optional): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Updated incident | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |
| `409` | Incident already acknowledged | ErrorEnvelope |

### `POST /api/incidents/{id}/resolve` — Resolve an incident

Manual close-out (the engine resolves automatically when the probe recovers). Computes MTTR/duration and freezes the money figures. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Updated incident | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

## services

Monitored fleet membership, money models, probe sources

### `GET /api/services` — Service fleet

All monitored services with live metrics, money models and probe-source configuration. Tenant scope enforced server-side.

| Parameter | In | Description |
|-----------|-----|-------------|
| `tenant` | query | Tenant id to scope by (admin/owner may omit for fleet-wide; scoped users must hold a membership — see resolveTenantScope). |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Fleet list | inline object |
| `401` |  | — |
| `403` |  | — |

### `POST /api/services` — Register a service

Adds a monitored service with its money model. `key` must be a lowercase slug; unknown `tenantId` → 404. Audited.

Request body (required): **CreateService**

| Status | Description | Schema |
|--------|-------------|--------|
| `201` | Created service | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` | Referenced tenant does not exist | ErrorEnvelope |

### `GET /api/services/{key}` — Service detail

The /services/[key] page payload — live health DTO, current-Jalali-window contract row, recent incidents and the evidence trail (notifications + chaos).

| Parameter | In | Description |
|-----------|-----|-------------|
| `key` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Detail payload | ServiceDetail |
| `401` |  | — |
| `404` | Unknown service key | ErrorEnvelope |

### `POST /api/services/{key}/tps-profile` — Import a Shaparak/PSP transaction-count CSV as the hour-of-week tps profile

Shaparak/PSP-style transaction-count sources: parse a domestic PSP/Shaparak hourly transaction-count report and aggregate it into the 168-bucket hour-of-week tps profile the live money path resolves outages with. Two sheet shapes are accepted (headers in English or Persian): a timestamp column + a count column, or a date + hour + count triple. Dates may be Gregorian or Jalali; counts accept Latin, Persian and Arabic-Indic digits with thousands separators. Naive timestamps are read as Tehran wall clock (the calendar every domestic report uses); Iran has no DST since 2022. Caps: 2016 data rows, 512 KB. `mode` defaults to dryRun (parses, aggregates, previews the buckets, writes nothing). Commit is all-or-nothing — any rejected row aborts (422) with every rejection reported by physical CSV line, so money inputs are never silently partial. Audited. Engineer+ role; tenant-scoped users only for their own clients. A sample sheet ships at /templates/shaparak-tx-counts-sample.csv.

| Parameter | In | Description |
|-----------|-----|-------------|
| `key` | path |  |

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Dry-run report (zero writes) or the committed state | TpsProfileImportReport |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` | Service not found (or foreign to a scoped user) | ErrorEnvelope |
| `413` | CSV above the 512 KB size cap | ErrorEnvelope |
| `422` | Commit aborted — rejections listed by line, nothing written | TpsProfileImportReport |

### `DELETE /api/services/{key}/tps-profile` — Remove the transaction profile (fall back to the flat tps)

Reverts the service's money source to its flat tps column. Audited. Idempotent — removing when no profile is stored succeeds with `removed: false`. Same authz as the import.

| Parameter | In | Description |
|-----------|-----|-------------|
| `key` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Removal result | inline object |
| `401` |  | — |
| `403` |  | — |
| `404` | Service not found (or foreign to a scoped user) | ErrorEnvelope |

### `POST /api/services/import` — Bulk CSV import of services + contract terms

Customer onboarding: one CSV row = one monitored service with its SLA contract terms (slaTarget, penaltyBase, penaltyPerMinute, tier) — the same fields POST /api/services accepts. The sheet must have a header with at least `key` and `name` columns; nameFa, tenant (client key OR id), tier, endpoint, baseLatencyMs, tps, avgTransactionValue, slaTarget, penaltyBase, penaltyPerMinute and criticality are optional per row. RFC 4180 quoting, CRLF/LF and a UTF-8 BOM are handled; a template ships at /templates/services-import-template.csv. Caps: 200 data rows, 512 KB. `mode` defaults to dryRun (validates every row, writes nothing). Authz mirrors the single-service POST per row: engineer+ role; scoped users may only import into tenants they belong to; rows without a tenant require admin. Commit is all-or-nothing — any failing row aborts the whole import (422) with every failing row reported by physical CSV line; the engine picks the new services up on its next tick.

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Dry-run report — every row validated, zero writes | inline object |
| `201` | Committed — services created and picked up by the engine | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `413` | CSV above the 512 KB size cap | ErrorEnvelope |
| `422` | Commit aborted — per-row failures listed, nothing written | inline object |

### `POST /api/services/preview` — Preview a probe source

Onboarding wizard — evaluates an UNSAVED probe-source candidate against the configured Prometheus (last 60 min at 1-min steps); nothing is persisted. Requires the Prometheus connection (503 otherwise).

Request body (required): **ServicePreview**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Preview result | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `503` | Prometheus connection not configured | ErrorEnvelope |

## tenants

Client companies owning service fleets (multi-tenancy)

### `GET /api/tenants` — Tenant list

Client companies for the switcher/scoping. Scoped users only see their memberships.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Tenants | inline object |
| `401` |  | — |

### `POST /api/tenants` — Create a tenant

Admin-only. `key` must be a lowercase slug. Audited.

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `201` | Created tenant | Tenant |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

## alerts

Bilingual notification feed (evidence trail)

### `GET /api/alerts` — Notification feed

Bilingual alert history (technical + executive) — the evidence trail behind every money figure.

| Parameter | In | Description |
|-----------|-----|-------------|
| `limit` | query |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Newest-first alert feed | inline object |
| `401` |  | — |

## analytics

Error budgets, trends, availability heatmap

### `GET /api/analytics` — Error budgets, trends, heatmap

Rolling-window SLA error budgets per service, hourly incident/MTTD/MTTR/penalty trends and the availability heatmap. `windowHours` clamped to 1–24 (default 24).

| Parameter | In | Description |
|-----------|-----|-------------|
| `tenant` | query | Tenant id to scope by (admin/owner may omit for fleet-wide; scoped users must hold a membership — see resolveTenantScope). |
| `windowHours` | query |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Analytics payload | Analytics |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

## contracts

Contract compliance view for the current Jalali month

### `GET /api/contracts` — Contract compliance snapshot

Per-service compliance for the current Jalali month — billed downtime (ceil, 1-minute minimum), penalties to date, linear projections, planned-window overlaps. Every money figure integer Tomans.

| Parameter | In | Description |
|-----------|-----|-------------|
| `tenant` | query | Tenant id to scope by (admin/owner may omit for fleet-wide; scoped users must hold a membership — see resolveTenantScope). |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Contract snapshot for the measurement window | ContractsSnapshot |
| `401` |  | — |
| `403` |  | — |

## maintenance

Planned maintenance windows (alert suppression)

### `GET /api/maintenance` — Maintenance windows

Planned windows; while ACTIVE, alert delivery is suppressed for the covered service (or the whole fleet when serviceId is null). Incidents are still recorded — SLA truth is never altered.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Windows (active first) | inline object |
| `401` |  | — |

### `POST /api/maintenance` — Schedule a maintenance window

Starts immediately and lasts 5–720 min. `serviceId` omitted/null = fleet-wide. Audited.

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `201` | Created window | MaintenanceWindow |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` | Unknown serviceId | ErrorEnvelope |

### `POST /api/maintenance/{id}/cancel` — Cancel a maintenance window

Marks the window `cancelled`; suppression stops immediately. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Cancelled window | MaintenanceWindow |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

## rules

User-defined alert policy rules (alert governance)

### `GET /api/rules` — Alert policy rules

User-defined rules evaluated every engine tick against live metrics, with cooldowns and quiet hours. Includes live state (violatedNow/measuredValue) from the last pass.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Rules | inline object |
| `401` |  | — |

### `POST /api/rules` — Create an alert rule

Engineer-only. `uptime`/`errorRate` thresholds are 0–1 ratios; `latencyMs`/`throughput` ≥ 0. Quiet hours need BOTH bounds (or neither). Audited.

Request body (required): **CreateRule**

| Status | Description | Schema |
|--------|-------------|--------|
| `201` | Created rule | AlertRule |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

### `DELETE /api/rules/{id}` — Delete an alert rule

Engineer-only. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Deleted | Ok |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

### `POST /api/rules/{id}/toggle` — Enable/disable an alert rule

Engineer-only. Disabled rules stay configured but are skipped by the evaluation pass. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Updated rule | AlertRule |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

### `POST /api/rules/import` — Bulk import of Grafana or Zabbix alert rules

Integrations: `source` selects the export format — 'grafana' (default) accepts the JSON export of Grafana unified alerting ({"rules":[…]}, a bare rule array, or a single rule); 'zabbix' accepts the JSON array returned by the Zabbix API's trigger.get (modern 5.4+ `last(/host/key)<10` and legacy `{host:key.func(p)}<10` expressions are both recognised). Each row's threshold expression is mapped onto one of the four Sentinel metrics. Recognised Grafana shapes: `up == 0` → uptime < 1; error families (error/fail/5xx filters) with a 0–1 threshold → errorRate; duration families with a declared unit suffix (_seconds/_ms; seconds convert to milliseconds) → latencyMs; counter rates over request/transaction families → throughput. Recognised Zabbix families: agent.ping/net.tcp.service = 0, nodata = 1, icmppingloss and web-scenario failures → uptime < 1 (any availability loss); service.perf items (seconds) → latencyMs; request/transaction item rates → throughput. Host-resource triggers (CPU/memory/disk/network interfaces) are REFUSED — Sentinel monitors services, not hosts. Rows that do not match any shape are reported as unmapped with the exact reason — never silently guessed. A service label (Grafana) or trigger host (Zabbix) resolves against the registry by name or key (case-insensitive); an unknown label aborts the import. Disabled Zabbix triggers (status=1) are refused. Grafana's `for` pending duration becomes cooldownMin (clamped to the schema's 1–1440 range, truncation noted); severity labels map to critical/warning (Grafana) and the 0–5 priority scale maps with transparent notes (Zabbix). `mode` defaults to dryRun (maps every row, writes nothing). Commit is all-or-nothing — any unmapped, duplicated or unknown-service row aborts the whole import (422). Created rules go through the same validation and governance path as POST /api/rules. Engineer-only. Audited. Caps: 200 rows, 512 KB. Sample exports ship at /templates/grafana-alerts-sample.json and /templates/zabbix-triggers-sample.json.

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Dry-run report — every rule mapped or refused, zero writes | inline object |
| `201` | Committed — every mapped rule created | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `413` |  | — |
| `422` | Import aborted — every failing rule reported | inline object |

## channels

Notification delivery channels (telegram/bale/webhook/email)

### `GET /api/channels` — Notification channels

Delivery targets with health counters (delivered/failed/last error/status). Signing secrets are never echoed.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Channels | inline object |
| `401` |  | — |

### `POST /api/channels` — Create a channel

Engineer-only. Target format validated per kind (telegram/bale/webhook/email/mattermost/jira/redmine; jira+redmine require settings with the project). Audited.

Request body (required): **CreateChannel**

| Status | Description | Schema |
|--------|-------------|--------|
| `201` | Created channel | NotificationChannel |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

### `PATCH /api/channels/{id}` — Edit a channel

`secret` follows PATCH semantics — absent = keep current, null = clear, string = replace.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

Request body (required): **UpdateChannel**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Updated channel | NotificationChannel |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

### `DELETE /api/channels/{id}` — Delete a channel

Engineer-only. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Deleted | Ok |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

### `POST /api/channels/{id}/test` — Send a test message

Fires one real delivery through the outbox path and reports the outcome. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Updated channel (counters reflect the test) | NotificationChannel |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

### `POST /api/channels/{id}/toggle` — Enable/disable a channel

Engineer-only. Disabled channels receive no deliveries; status reflects it. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Updated channel | NotificationChannel |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

## oncall

On-call rotation entries

### `GET /api/oncall` — On-call rotation

Weekly coverage windows (minutes from midnight; end may wrap past midnight). `active` is computed against "now".

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Rotation entries | inline object |
| `401` |  | — |

### `POST /api/oncall` — Add a rotation entry

Engineer-only. Audited.

Request body (required): **CreateOnCall**

| Status | Description | Schema |
|--------|-------------|--------|
| `201` | Created entry | OnCallEntry |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

### `DELETE /api/oncall/{id}` — Remove a rotation entry

Engineer-only. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Removed | Ok |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

## escalation

Fleet escalation policy (unacked incidents page the secondary)

### `GET /api/escalation` — Escalation policy

The single fleet policy — unacked incidents page the secondary after `timeoutMin`.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Current policy | EscalationPolicy |
| `401` |  | — |

### `PUT /api/escalation` — Edit the escalation policy

Engineer-only, partial update; `timeoutMin` bounded 1–30. Audited.

Request body (required): **UpdateEscalation**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Updated policy | EscalationPolicy |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

## notifications

Outbox + delivery log + message templates

### `GET /api/notifications/delivery` — Delivery log

Per-attempt delivery outcomes (status code, latency, error), optionally filtered by channel.

| Parameter | In | Description |
|-----------|-----|-------------|
| `channelId` | query |  |
| `limit` | query |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Newest-first delivery rows | inline object |
| `400` | Unknown channelId | ErrorEnvelope |
| `401` |  | — |

### `GET /api/notifications/outbox` — Outbox contents

The transactional outbox — pending/delivered/dead notification envelopes with attempt counters.

| Parameter | In | Description |
|-----------|-----|-------------|
| `status` | query |  |
| `limit` | query |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Newest-first outbox rows | inline object |
| `401` |  | — |

### `POST /api/notifications/outbox` — Retry a dead-letter notification

Admin-only. Re-enqueues a dead-lettered item (audited).

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Retry accepted | Ok |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

### `GET /api/notifications/templates` — Message templates

The rendered message templates per transport plus whether the ack secret is configured (signed ack links).

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Template inventory | inline object |
| `401` |  | — |

## reports

PDF report archive, generation and download

### `GET /api/reports` — Report archive

Newest-first metadata for every generated PDF (executive, statement, incident), including its snapshot hash.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Newest-first report metadata | inline object |
| `401` |  | — |

### `POST /api/reports` — Generate a report

Executive-only. Three templates — `executive` (fleet), `statement` (per tenant, requires tenantId) and `incident` (requires incidentId) — each in `en` or `fa`, with a SHA-256 snapshot hash printed in the title block. Audited.

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `201` | Generated report | Report |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` | Unknown tenantId/incidentId | ErrorEnvelope |

### `GET /api/reports/{id}/download` — Download a report PDF

Streams the generated PDF for the archive/archive UI; the file is produced by the same pipeline in demo and live mode.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | The PDF file | inline object |
| `401` |  | — |
| `404` | Unknown report (or file missing) | ErrorEnvelope |

### `POST /api/reports/{id}/regenerate` — Regenerate a report

Executive-only. Re-runs the same report over the same period/template with a fresh snapshot hash. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `201` | The regenerated report (new id, fresh snapshot hash) | Report |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

## schedules

Cron-style report schedules and their run ledger

### `GET /api/schedules` — Report schedules

Cron-style weekly/monthly schedules with computed `nextRunAt`. Weekly needs `dayOfWeek`; monthly needs `dayOfMonth` ≤ 28; `kind=statement` needs `tenantId`.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Schedules | inline object |
| `401` |  | — |

### `POST /api/schedules` — Create a report schedule

Engineer-only. Audited.

Request body (required): **CreateSchedule**

| Status | Description | Schema |
|--------|-------------|--------|
| `201` | Created schedule | ReportSchedule |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

### `DELETE /api/schedules/{id}` — Delete a schedule

Engineer-only. Past runs remain in the ledger with the label snapshotted at run time. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Deleted | Ok |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

### `POST /api/schedules/{id}/run` — Run a schedule now

Engineer-only. Fires the exact same pipeline the due-check uses (trigger `manual`); the result lands in the run ledger. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | The updated schedule (the firing itself lands in the run ledger — see GET /api/schedules/runs) | ReportSchedule |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

### `POST /api/schedules/{id}/toggle` — Enable/disable a schedule

Engineer-only. Disabled schedules never fire; nextRunAt renders null. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Updated schedule | ReportSchedule |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

### `GET /api/schedules/runs` — Schedule run ledger

Audit trail of schedule firings (due or manual), including failures with their first error line.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Newest-first run ledger | inline object |
| `401` |  | — |

## exports

CSV/JSON data exports

### `GET /api/export/analytics` — Export analytics

JSON only (csv → 400); the analytics payload above as an attachment. `windowHours` clamped 1–24.

| Parameter | In | Description |
|-----------|-----|-------------|
| `tenant` | query | Tenant id to scope by (admin/owner may omit for fleet-wide; scoped users must hold a membership — see resolveTenantScope). |
| `format` | query |  |
| `windowHours` | query |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | JSON attachment | Analytics |
| `400` | CSV requested (not served) | ErrorEnvelope |
| `401` |  | — |

### `GET /api/export/incidents` — Export incidents

CSV (default) or JSON attachment with one row per incident — money columns included. `limit` clamped 1–2000 (default 500).

| Parameter | In | Description |
|-----------|-----|-------------|
| `tenant` | query | Tenant id to scope by (admin/owner may omit for fleet-wide; scoped users must hold a membership — see resolveTenantScope). |
| `format` | query |  |
| `status` | query |  |
| `limit` | query |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | File attachment | inline object |
| `400` |  | — |
| `401` |  | — |

### `GET /api/export/services` — Export services

CSV or JSON attachment of the fleet with money models and live aggregates.

| Parameter | In | Description |
|-----------|-----|-------------|
| `tenant` | query | Tenant id to scope by (admin/owner may omit for fleet-wide; scoped users must hold a membership — see resolveTenantScope). |
| `format` | query |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | File attachment | inline object |
| `400` |  | — |
| `401` |  | — |

## metrics

Live metric history ring-buffer

### `GET /api/metrics/history` — Live metric history for one service

Ring-buffer snapshots (2500 ms tick), clamped to the last 5–360 minutes.

| Parameter | In | Description |
|-----------|-----|-------------|
| `serviceId` | query |  |
| `minutes` | query |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Snapshot series (oldest first) | inline object |
| `400` |  | — |
| `401` |  | — |

## resilience

Weekly self-test schedule, stats and run ledger

### `GET /api/resilience` — Self-test state

Weekly self-test schedule, 30-day stats, recent runs, recent chaos experiments and the live-mode chaos-hook inventory (presence only — hook values never echoed).

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Self-test state | SelfTestState |
| `401` |  | — |

### `POST /api/resilience` — Run the self-test now

Engineer-only. Starts one self-test through the same path the scheduler uses; returns 202 immediately (measurement takes ~40–60 s) — poll GET while the run is `running`. 409 when one is already in flight. Audited.

| Status | Description | Schema |
|--------|-------------|--------|
| `202` | Self-test started | inline object |
| `401` |  | — |
| `403` |  | — |
| `409` | A self-test is already running | ErrorEnvelope |

### `PUT /api/resilience` — Edit the self-test schedule

Admin-only. `{ enabled, hour, dayOfWeek }`. Audited.

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Updated schedule | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

## ai

Rule-based/LLM incident post-mortem summaries

### `POST /api/ai/postmortem` — Generate a post-mortem summary

Engineer-only. Summarizes the incident timeline (LLM when configured, rule-based fallback otherwise — `source` tells which). Audited.

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Summary result | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

## integrations

Prometheus connection, executive digests, transport settings, webhooks

### `POST /api/integrations/alertmanager` — Alertmanager webhook receiver

**Public** (no session required).

Public by design — the shared secret IS the authentication (checked against the configured alertmanager secret; 503 when none is set, 401 on mismatch). Ingests Alertmanager webhook payloads into Sentinel incidents in live mode.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Payload accepted | Ok |
| `400` |  | — |
| `401` | Secret mismatch | ErrorEnvelope |
| `503` | No alertmanager secret configured | ErrorEnvelope |

### `GET /api/integrations/digest` — Executive digest schedule

Admin-only. Frequency/hour/day plus the next due instant.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Digest schedule | DigestStatus |
| `401` |  | — |
| `403` |  | — |

### `POST /api/integrations/digest` — Send the digest now

Admin-only. Runs the exact scheduler path; reports the enqueued count honestly (and the error when digest-disabled or fan-out fails). Audited.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Fan-out result | inline object |
| `401` |  | — |
| `403` |  | — |

### `PUT /api/integrations/digest` — Edit the digest schedule

Admin-only. `{ frequency: off\|daily\|weekly, hour, dayOfWeek? }`. Audited.

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Saved schedule | DigestStatus |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

### `GET /api/integrations/notify` — Notification transport settings

Admin-only. Bot-token presence flags only — values never echoed.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Transport status | NotifyStatus |
| `401` |  | — |
| `403` |  | — |

### `PUT /api/integrations/notify` — Set the notification transport

Admin-only. Chooses telegram/bale as the executive+technical transport. Audited.

Request body (required): **inline object**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Saved | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

### `GET /api/integrations/prometheus` — Prometheus connection status

Admin-only. Auth material is masked — kinds and presence only, never values.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Connection status | PrometheusStatus |
| `401` |  | — |
| `403` |  | — |

### `PUT /api/integrations/prometheus` — Set the Prometheus connection

Admin-only. Persists baseUrl + auth into IntegrationSetting (DB-managed, not env). Audited.

Request body (required): **PrometheusPut**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Saved (masked echo) | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

### `POST /api/integrations/prometheus/test` — Test the Prometheus connection

Admin-only. Probes the (candidate or saved) connection and reports reachability.

Request body (optional): **PrometheusPut**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Reachability result | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |

### `POST /api/integrations/telegram/callback` — Telegram/Bale ACK callback

**Public** (no session required).

Public webhook for button presses coming back from Telegram/Bale messages. Authentication is the callback secret resolved from settings (503 when the callback is not configured, 401 on a secret mismatch); the signed ack token inside the payload is then verified against the ack secret. A business-level verdict — including a bad/expired token — is reported as `{ok:false}` with 200 so the chat platform does not retry-spam.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Callback processed (business verdict — ok may be false) | inline object |
| `400` |  | — |
| `401` | Callback secret mismatch | ErrorEnvelope |
| `503` | Telegram callback or ack secret not configured | ErrorEnvelope |

## users

Account management (admin)

### `GET /api/users` — Account list

Admin-only. Accounts with global role, locale, disabled flag, last sign-in and memberships.

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Accounts | inline object |
| `401` |  | — |
| `403` |  | — |

### `POST /api/users` — Create an account

Admin-only. Password policy enforced (≥12 chars, no repeated-char runs, no trivial words); global role `owner` requires the caller to be the owner; memberships reference existing tenants. Audited.

Request body (required): **CreateUser**

| Status | Description | Schema |
|--------|-------------|--------|
| `201` | Created account | User |
| `400` | Validation failure (including password policy) | ErrorEnvelope |
| `401` |  | — |
| `403` |  | — |

### `PATCH /api/users/{id}` — Edit an account

Admin-only. Guards — the last enabled owner cannot demote/disable/delete themselves; only the owner edits an owner row. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

Request body (required): **PatchUser**

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Update result (no-op patches short-circuit with unchanged) | inline object |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

### `DELETE /api/users/{id}` — Delete an account

Owner-only; the owner account itself cannot be deleted. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Deleted | Ok |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

### `DELETE /api/users/{id}/sessions` — Revoke an account's sessions (sign-out-everywhere)

Admin-only; ending the owner's sessions requires the owner. Audited.

| Parameter | In | Description |
|-----------|-----|-------------|
| `id` | path |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Sessions revoked | Ok |
| `400` |  | — |
| `401` |  | — |
| `403` |  | — |
| `404` |  | — |

## audit

Append-only audit trail (admin)

### `GET /api/audit` — Audit trail

Admin-only, append-only. Returns recent entries plus the distinct action vocabulary for the filter UI.

| Parameter | In | Description |
|-----------|-----|-------------|
| `limit` | query |  |
| `action` | query |  |

| Status | Description | Schema |
|--------|-------------|--------|
| `200` | Entries + action vocabulary | inline object |
| `401` |  | — |
| `403` |  | — |


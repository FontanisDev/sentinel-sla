# User Guide — Sentinel-SLA

This guide is for everyone who uses Sentinel-SLA day to day: engineers
responding to incidents, executives watching the money, and viewers who only
need to read the numbers. Administrator-specific tasks (accounts, tenants,
integrations) live in `docs/ADMIN-GUIDE.md`; installation in
`docs/INSTALL.md`; operations (backup/upgrade) in `docs/OPERATIONS.md`.

## 1. Signing in

- Open the URL your administrator gave you (e.g. `https://sla.example.ir`)
  and sign in at `/login` with your e-mail and password.
- Sessions last 8 hours of inactivity (7 days at most). "Sign out" is in the
  account menu (top right).
- Five wrong passwords lock the account for 15 minutes — deliberate. An
  admin can also unlock it earlier from **Settings → Users**.
- Your preferred language (English or Persian) is chosen by the language
  toggle in the sidebar; executives can also be seeded Persian by an admin
  when their account is created.

## 2. What you see at a glance — the Overview (`/`)

The home dashboard is the technical command center:

- **KPI strip** — active incidents, services meeting SLA, window penalties,
  availability. Every money figure has a **formula popover** (the small `ƒ`
  affordance) that shows exactly how the number was computed — inputs,
  formula, substitution. No black boxes.
- **Services table** — one row per monitored service with live health,
  current window penalties and quick links to the service detail page.
- **Alerts feed** — the live incident/alert stream.
- Demo mode shows a small banner ("Demo data — simulation"): the built-in
  engine is generating realistic incidents locally, nothing external is
  being polled.
- **Getting started (guided setup)** — until the instance is fully
  configured, the command center shows a live checklist: signal source
  (Prometheus connection — in demo mode honestly labelled "demo
  simulation"), first tenant, first service, services attached to client
  tenants, first notification channel, first report. Every row shows the
  real count behind it and deep-links to the page where you work on it;
  the card can be dismissed (per browser — clearing the site's local
  storage brings it back). The same data is available as
  `GET /api/onboarding`.

## 3. Services (`/services`)

- The table supports sorting, column visibility, row density, search, CSV
  export and full keyboard operation.
- Click a service (or press Enter on the focused row) to open
  **`/services/[key]`**: health statistics, the contract card (availability,
  penalties, projection), recent incidents, the money model and the
  notification history for that service.

### Transaction profile — Shaparak/PSP hourly report

A flat transactions-per-second rate prices a Saturday-morning outage the same
as the 20:00–23:00 peak, which is not what a partner bank argues about. Open
a service page and use the **Transaction profile** card to import a
Shaparak/PSP hourly transaction-count report (CSV). Two sheet shapes are
accepted — a `timestamp` + count sheet, or a `date` + `hour` + count sheet —
with English or Persian headers, Gregorian or Jalali dates, and Latin or
Persian digits. A dry-run (the default) parses the sheet, previews the
168 hourly buckets with mean/peak/coverage and writes nothing; committing
replaces the flat rate with the imported profile. Commit is all-or-nothing:
any rejected row aborts the import and lists every failing line. Live
incidents are then priced at the incident hour's own rate, and the
resolution event records which bucket was used. Removing the profile falls
money back to the flat rate (audited). The demo engine keeps its flat rate —
this profile drives live money only. A sample sheet ships at
`/templates/shaparak-tx-counts-sample.csv`.

### Bulk import from CSV (workspace settings)

For onboarding a whole client at once, open **Settings → Services &
integrations** and use **Import CSV** next to *Add service*. One row = one
service with its SLA contract terms (availability target, penalty base,
penalty per minute, tier); the `tenant` column takes the client key or id.
Download the template sheet
(`/templates/services-import-template.csv`), fill it from the customer's
contract, then:

1. **Validate (dry-run)** — every row is checked (format, duplicates, client
   existence, your access rights) and the result table shows each failing row
   by its line number; nothing is written.
2. **Import** — enabled once all rows are valid. The commit is
   all-or-nothing: if anything fails, nothing is onboarded. Imported services
   join monitoring on the engine's next tick.

### Contract templates in the onboarding wizard

The single-service wizard (*Add service*, step 4 — money/SLA) can pre-fill
the availability target and the penalty pair from a **contract template**:
six common Iranian fintech SLA shapes, from a Shaparak-style payment
switching gateway (strictest) down to an SMS notification panel (most
lenient). Templates are example values for common contract shapes — the
wizard shows a standing note to replace them with the signed contract's
numbers before saving. Picking *Custom terms* keeps whatever you typed.

## 4. Incidents (`/incidents`)

- Filter by service/status/time; the time range supports the presets
  *Last 1 h / 24 h / 7 d / 30 d* plus a custom range (the calendar follows
  your preference — Gregorian or Jalali).
- **Incident detail (`/incidents/[id]`)** is the forensic view:
  - stat grid (MTTD / MTTA / MTTR and money impact),
  - the forensic timeline (detection → ack → resolution, with evidence
    links),
  - the post-mortem section once resolved,
  - the money-model card with formula popovers,
  - related incidents on the same service.
- **Engineers** see the Acknowledge and Resolve actions here (and from the
  notification link). Acknowledging from a Telegram/Bale message link is
  signed with the server's ack secret — nobody can ack someone else's page
  by guessing a URL.

## 5. Acknowledging an incident from your phone

When an incident opens, the on-call engineer receives a Telegram/Bale
message with the service, the current impact and a signed link. Open the
link, press **Acknowledge**, and the incident timeline records who
acknowledged and when. If nobody acknowledges within the escalation ladder
timeout, the on-call rotation escalates automatically (see §8).

## 6. Contracts (`/contracts`)

The executive's bird's-eye view of contractual health per client:

- per-client compliance chips (meeting SLA / at risk / breaching),
- window penalties and a 5 %-guarded linear projection for the rest of the
  month,
- **planned maintenance windows are shown informationally** — their minutes
  are excluded from the contractual math, and a note makes that visible.
- Every money cell again carries a formula popover.

## 7. Reports (`/reports`)

- **Executive monthly** — the board-facing summary: headline money tiles,
  per-client compliance, worst incidents, month trend, next-month risk.
- **Client SLA statement** — the per-client contract document: naive vs
  contractual availability, planned-maintenance exclusions, per-outage
  categories with evidence, penalty due, signature block.
- **Incident report** — the forensic record for a single incident.
- Each report is generated in **English or Persian** from the same data
  snapshot; Persian reports are properly shaped RTL documents (verified
  before each release). The title block carries the product version and the
  SHA-256 of the snapshot — the number on page 1 can be proven to come from
  the data you see.
- Generated PDFs live in the archive on the same page: download, or
  regenerate (a new archive row is created — nothing is overwritten).
- Schedules (monthly/statement, per language) can be configured on the same
  page; **Run now** produces the PDF immediately.

## 8. Alerting (`/alerting`)

- **Channels** — notification channels and the delivery log, including the
  outbox with retry state. Test-send a `[TEST]` message to verify a channel.
  Seven kinds ship: **Telegram, Bale, webhook (signed JSON), email (SMTP),
  Mattermost (incoming webhook), Jira and Redmine** (issue creation). The
  ticketing kinds need per-kind settings — Jira: the project key (and
  optionally an issue type, default `Task`) plus a credential that is either
  `email:api-token` (Atlassian cloud, Basic auth) or a bare Personal Access
  Token (Jira Server/Data Center, Bearer); Redmine: the project identifier
  plus the API key; Mattermost: optional channel/display-name overrides.
  When a ticket is created, the delivery log records its reference (the
  Jira issue key or the Redmine `#id`) so you can jump straight to it.
  Ticket systems receive actionable incidents — the periodic executive
  digest never opens tickets.
- **Rules** — metric rules evaluated continuously (uptime, error rate,
  latency, throughput), with per-service or fleet scope, cooldown and quiet
  hours. Rows show the live "violated now" state.
- **On-call & escalation** — the weekly rotation (who is on duty right now
  is shown live) and the escalation ladder (timeout minutes, applies-to,
  armed/disarmed).
- **Maintenance** — planned windows. Alerts inside a window are suppressed;
  the incident timeline records `alerts_suppressed` naming the window, and
  contract math excludes the minutes.

### Importing alert rules from Grafana or Zabbix

On **Rules**, the **Import alert rules** button accepts two export formats
(selected in the card): the **JSON export of Grafana unified alerting**
(the file from Grafana's alerting UI *Export*, or
`GET /api/v1/provisioning/alert-rules`), or a **Zabbix trigger list** (the
JSON array returned by the Zabbix API's `trigger.get`; both modern 5.4+
`last(/host/key)<10` and legacy `{host:key.func(p)}<10` expressions are
recognised). Each rule is mapped onto one of the four Sentinel metrics —
or reported as **unmapped with the exact reason**; nothing is guessed.
Recognised Grafana shapes: `up == 0` becomes *uptime < 1* (any availability
loss); 5xx/error ratios with a 0–1 threshold become *errorRate*; duration
rules with a declared unit suffix become *latencyMs* (seconds convert to
milliseconds); counter rates over request/transaction families become
*throughput*. Recognised Zabbix families: `agent.ping`/`net.tcp.service`
`= 0`, `nodata = 1`, packet loss and web-scenario failures become
*uptime < 1*; `service.perf` items (seconds) become *latencyMs*; request
and transaction item rates become *throughput*. Host-resource triggers
(CPU, memory, disk, interfaces) are refused — Sentinel monitors services,
not hosts — and disabled Zabbix triggers are refused too. A `service`
label (Grafana) or the trigger's host (Zabbix) must name a Sentinel
service (by key or name) or the import stops — a rule meant for one client
never silently becomes fleet-wide. A dry-run shows the mapping row by row
(with notes such as severity defaults and duration conversion); the commit
is all-or-nothing. Sample exports ship at
`/templates/grafana-alerts-sample.json` and
`/templates/zabbix-triggers-sample.json`.

## 9. Resilience (`/resilience`)

The self-test page proves detection actually works: trigger a controlled
fault, the system measures how long it took to detect (MTTD) against the
60-second target, with the run history. A failed run raises an alert — the
monitor monitors itself.

## 10. Command palette and keyboard

- `⌘K` / `Ctrl+K` opens the command palette: jump to pages, services,
  incidents, actions.
- `g` then a key jumps between sections; `?` shows the shortcut help.

## 11. Roles — what you can do

| Ability | Viewer | Executive | Engineer | Admin |
|---|---|---|---|---|
| See dashboards, incidents, contracts, reports | ✓ | ✓ | ✓ | ✓ |
| Acknowledge / resolve incidents | — | — | ✓ | ✓ |
| Create tenants/services/rules/windows | — | — | ✓ | ✓ |
| Notification channels test-send | — | — | ✓ | ✓ |
| User accounts, audit trail | — | — | — | ✓ |
| Delete accounts | — | — | — | Owner only |

The sidebar only shows what your role allows, and the server enforces the
same matrix on every API route — hiding a button is convenience, not the
security boundary.

## 12. Languages, calendars, and numbers

- The UI ships in English and Persian (RTL). Persian numerals are used in
  the Persian locale where appropriate.
- Dates can be shown in the Jalali calendar; the preference is persisted
  per browser and honoured by pickers and tables alike.
- Money is computed and displayed in Tomans with integer arithmetic — no
  rounding drift — and every figure is explainable via its formula popover.

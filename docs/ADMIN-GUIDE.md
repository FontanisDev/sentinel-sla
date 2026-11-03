# Administrator Guide — Sentinel-SLA

This guide is for administrators (`admin` and `owner` roles). It covers
account administration, tenants and services, integrations, notification
channels, the audit trail, and the security model that binds all of it.
For day-to-day product usage see `docs/USER-GUIDE.md`; installation and
operations live in `docs/INSTALL.md` / `docs/OPERATIONS.md`.

## 1. Roles and the authorization matrix

Sentinel-SLA has five global roles; the server enforces the full matrix on
every one of the 46 API routes, and a generated test (128 checks) fails the
build if any route ever drops below its floor:

| Role | Floor |
|---|---|
| `owner` | everything an admin can do, plus: mint/modify/delete the owner account, delete accounts. Exactly one enabled owner must always exist (guards in the API refuse to break this). |
| `admin` | account administration (create/patch/disable/revoke sessions), audit trail, tenants, everything engineer+ |
| `engineer` | acknowledge/resolve incidents, create tenants/services/rules/maintenance windows, test notification channels, everything executive+ |
| `executive` | dashboards, contracts, reports, money views |
| `viewer` | read-only on the dashboards |

Two dimensions exist on purpose: the **global role** caps what a person can
do anywhere, while **tenant memberships** (assigned on the account) scope
which tenants' data they see. An out-of-scope tenant id in a URL is a 403,
never a leak; a user with exactly one membership is auto-narrowed to it.

## 2. Managing accounts — `/settings/users`

Open **Settings → Users & roles** (admin+). The table shows every account
with role, memberships, language, status and last sign-in; all of it is
mirrored server-side by `/api/users` (the API is the authority, the page is
the lens — the sidebar hides the page below admin, the API enforces 403).

- **Create account** — name, e-mail, password (see policy below), global
  role, UI language, and optional tenant memberships (each with a
  tenant-local role). Only the owner sees `owner` in the role list; an
  admin attempting it via the API gets a 403.
- **Change role** — the role selector on each row. The owner row's selector
  is disabled: the owner account is only mutable by the owner.
- **Reset password** — sets a new password (policy enforced); audit-logged.
- **Disable** — the person is signed out of every session immediately and
  cannot sign in again until re-enabled. The last enabled owner can never
  be disabled (the button is already disabled client-side; the API refuses
  regardless).
- **Sign out everywhere** — deletes all of the account's sessions now
  (useful for "phone was stolen" cases).
- **Delete** (owner only) — permanent removal with memberships. The owner
  account itself has no delete button.

**Password policy** (enforced by the same function for setup, creation and
reset): at least 12 characters, no single repeated character, and none of a
small list of trivial dictionary words. Passwords are hashed with argon2id;
the database stores hashes, never passwords.

## 3. Tenants (clients) and services

- Tenants are created by engineers/admins via **Services → tenant dialog**
  or the API; each has an English and an optional Persian display name.
  Persian names surface automatically when the UI (or a PDF report) renders
  in Persian.
- Services belong to a tenant and carry the **money model** — lost
  transactions per minute and value, SLA penalty formula parameters. These
  feed every money figure and PDF report; the formula popovers in the UI
  show the exact arithmetic so numbers can always be defended to a client.
- Contracts attach SLA targets and maintenance-window exclusions to a
  tenant; `/contracts` and the client statement PDF are driven entirely by
  that data.

## 4. Integrations — `/settings/integrations`

- **Prometheus connection (live mode)** — base URL and auth (none / basic /
  bearer). **Test** performs a real round-trip and shows the result. In
  live mode the engine polls Prometheus on the configured interval
  (`SENTINEL_POLL_INTERVAL_SEC`); the simulation code path never starts.
- The connection row is seeded by `install.sh` (question 4) and editable
  here afterwards; it lives in the database, not in env vars.
- **Bale** tokens are configured here as well (Telegram bot token can be
  provided at install; chat ids always live here per channel).

## 5. Notification channels — `/alerting/channels`

- Create channels (Telegram / Bale / webhook / email / Mattermost / Jira /
  Redmine) and target them by audience (technical or executive) and severity.
- **Ticketing kinds.** Jira needs the project key (settings; issue type
  defaults to `Task`) and a credential in `secret`: `email:api-token`
  (Atlassian cloud → Basic auth) or a bare PAT (Jira Server/Data Center →
  Bearer). Redmine needs the project identifier (settings) and the API key
  (`secret`, sent as `X-Redmine-API-Key`). Mattermost takes the incoming
  webhook URL as the target with optional channel/display-name overrides.
  Every created ticket's reference (Jira issue key / Redmine `#id`) is
  recorded in the delivery log row. The periodic executive digest never
  opens tickets — ticket systems receive actionable incidents only.
- **Test send** writes a `[TEST]` message through the real transport —
  check the delivery log for the outcome.
- The delivery log shows every notification with its outbox state; failed
  sends can be retried from the outbox panel. The dispatcher is
  transactional (outbox pattern): a notification is only sent after its
  row is committed, so crashes never lose or duplicate deliveries.
- Executive digests (daily summary with money figures and the newest report
  PDF attached) are configured on the same page, default OFF.

## 6. Audit trail — `/settings/audit`

Every security-relevant mutation is recorded: logins and failures,
lockouts, `user.created/updated/deleted/sessions_revoked`, report
generate/download/regenerate, exports. Filter by action and lookback
window. Audit rows are write-once from the application's perspective —
treat the trail as part of your records for customer disputes (the SLA
statement PDF's snapshot hash ties the numbers to exactly this data).

## 7. Backups, upgrades, and the things you must protect

- Backups (`./backup.sh`) include the database, the report archive, and
  `.env` — which contains the generated secrets. **Treat every backup
  tarball as a credential**: mode 600, encrypted storage, limited readers.
- Restore is verify-first and refuses to clobber a target without
  `--force`; upgrade rolls back automatically on any failure.
- Restore rehearsals matter: `deploy/backup-restore-test.sh` proves
  byte-identical recovery; run it (or a manual drill) after major version
  changes.

## 8. Security model in one paragraph

Sessions are server-side (argon2id passwords, sha256-stored session tokens,
8 h idle / 7 d absolute), login is rate-limited and locked out after 5
failures, every route sits behind the generated authorization matrix, and
ack links in notifications are signed (`SENTINEL_ACK_SECRET`). OWASP ZAP
baseline guidance and the dependency-audit position live in
`docs/SECURITY.md`; the TLS termination options for the dashboard are in
`docs/INSTALL.md` § 6.

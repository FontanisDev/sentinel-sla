# SECURITY — Sentinel-SLA v2.0.0

Authentication, permission matrix, threat model, ASVS checklist and secret
management. Claims here are backed by tests or commands in the repository.

## 1. Authentication at a glance

| Mechanism | Implementation | Where enforced |
|---|---|---|
| Passwords | argon2id (hash-wasm, m=64 MiB, t=3, p=4), PHC-encoded, ≥12 chars, trivial-list + repeat-char rejection | `src/server/auth/passwords.ts`, policy tested in `tests/unit/auth.test.ts` |
| Sessions | Server-side rows, cookie `sentinel_session` = 256-bit random, DB stores sha256 only; httpOnly, SameSite=Lax, `Secure` when `SENTINEL_TLS=1`; idle 8 h sliding, absolute 7 d | `src/server/auth/session.ts` |
| Lockout | 5 consecutive failures → 15 min lock, reset on success | `checkLogin()`, tested |
| API tokens | Bearer, sha256-hashed, 8-char prefix visible, scopes read/write, expiring, revocable | `resolveSessionUser()` (schema ready; no management UI yet) |
| Edge gate | `src/proxy.ts` (Next 16 proxy convention): anonymous page hits → 302 `/login?next=…`, anonymous `/api` → 401. Presence-check only; **authoritative checks are per-route** | + allow-list test |
| Per-route authz | `requireUser` / `requireRole` / `requireTenantAccess` in `src/server/authz.ts`; **every** non-allow-listed handler calls one as its first statement | enforced by `tests/unit/authz-enumeration.test.ts` |

## 2. Roles and permission matrix

Roles: `owner` > `admin` > `engineer` > `executive` > `viewer` (ordered, `roleAtLeast`).
Tenant membership adds per-tenant roles (tenant-admin | engineer | executive | viewer);
non-admin users see only tenants they hold membership in (`requireTenantAccess`).

| Capability | viewer | executive | engineer | admin | owner |
|---|---|---|---|---|---|
| Read dashboards, incidents, services, analytics, exports | ✓ | ✓ | ✓ | ✓ | ✓ |
| Download reports | ✓ | ✓ | ✓ | ✓ | ✓ |
| Acknowledge / resolve incidents | – | – | ✓ | ✓ | ✓ |
| Engine controls, chaos, maintenance, rules, channels, on-call, schedules | – | – | ✓ | ✓ | ✓ |
| Generate executive reports (PDF) | – | ✓ | ✓ | ✓ | ✓ |
| Manage tenants | – | – | – | ✓ | ✓ |
| Manage users/roles, API tokens, audit settings | – | – | – | ✓ | ✓ |
| Licence changes, destructive fleet actions | – | – | – | – | ✓ |

Route-level wiring map (mutations → minimum role):

| Route prefix | Non-GET floor |
|---|---|
| `/api/engine`, `/api/chaos*`, `/api/incidents/[id]/*`, `/api/maintenance*`, `/api/rules*`, `/api/channels*`, `/api/schedules*`, `/api/oncall*`, `/api/escalation`, `/api/ai/postmortem` | engineer |
| `/api/reports` (POST) | executive |
| `/api/tenants` (non-GET) | admin |
| `/api/users` (POST), `/api/users/[id]` (PATCH), `/api/users/[id]/sessions` (DELETE) | admin (owner to touch owner rows / create owners) |
| `/api/users/[id]` (DELETE) | owner |
| all other GETs | authenticated user |

Public allow-list (by design, mirrors `src/proxy.ts` and the enumeration test):
`/api/health/*` (liveness/readiness), `/api/auth/*` (login/setup/logout/session),
`/api/integrations/*` (Alertmanager webhook — its own bearer secret).

## 2b. Tenant scoping (server-enforced)

The loose `?tenant=` filter is gone. Every tenant-scoped surface now resolves the
request through `resolveTenantScope(user, tenantId)` (`src/server/authz.ts`):

| Caller | Request | Result |
|---|---|---|
| owner/admin | any `?tenant=` | allowed (fleet administrators) |
| scoped user | `?tenant=B` not in memberships | **403** |
| scoped user | `?tenant=A` (member) | allowed, data scoped to A |
| scoped user | no param, exactly 1 membership | auto-narrowed to that tenant |
| scoped user | no param, several memberships | **403** "select one of your clients" (the engine snapshot cannot express multi-tenant filters yet) |
| scoped user | no param, zero memberships | **403** |

Enforced on: `/api/dashboard`, `/api/analytics`, `/api/export/{analytics,incidents,services}`
(query param), `/api/reports` POST (body `tenantId`), `/api/services` POST (assignment
must be inside scope; only admins may create unassigned services).
Evidence: `tests/integration/authz-matrix.mjs` section 3 (128/128 pass).

## 2c. Rate limiting

`src/server/ratelimit.ts` — in-memory sliding window, `Retry-After` + `X-RateLimit-*`
on 429, fails OPEN (limiter outage must not take the API down). Rules:

| Scope | Rule | Rationale |
|---|---|---|
| `POST /api/auth/login` | 10 / 5 min / IP | brute-force throttle beside the 5×/15 min account lockout |
| `POST /api/auth/setup` | 20 / h / IP | first-run wizard abuse guard |
| `POST /api/reports` | 12 / 10 min / IP | spawns the PDF pipeline |
| `/api/export/*` | 20 / min / IP | full-table serialisation |
| `/api/users*` mutations | 120 / min / IP | generic abuse ceiling |

Note: buckets are per process; the DB-backed account lockout remains the
authoritative per-account control when more than one process serves requests.

## 2d. Security headers

Set on **every** response by `src/proxy.ts` (public pages included):

- `Content-Security-Policy`: `default-src 'self'`; scripts = `self` + per-request
  **nonce** + `strict-dynamic` (no `unsafe-inline` for scripts — feasible and done);
  styles keep `unsafe-inline` (Tailwind runtime injection — documented residual);
  `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`.
  Development additionally ships a `Content-Security-Policy-Report-Only` twin so HMR
  violations are visible, not silently swallowed.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (legacy beside
  frame-ancestors), `Referrer-Policy: strict-origin-when-cross-origin`,
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`.
- `Strict-Transport-Security: max-age=63072000; includeSubDomains` **only** when
  `SENTINEL_TLS=1` (TLS-declared deployments).

## 2e. Account administration

- `GET/POST /api/users` (admin+) and `PATCH/DELETE /api/users/[id]` (admin/owner) —
  password reset (argon2id + policy), role change, disable/enable, delete.
  Guardrails: the last enabled owner can never be demoted/disabled/deleted; an admin
  cannot touch owner rows or disable themselves; disable and password reset revoke all
  live sessions immediately; disabled accounts fail login with a dedicated (non-
  enumerating) message and their sessions/tokens resolve to null.
- `DELETE /api/users/[id]/sessions` — "log out everywhere" per account.
- All user/role changes audit-logged (`user.created/updated/deleted/sessions_revoked`).
- `GET /api/audit` (admin+) — filterable trail (action, actor, lookback, take) feeding
  the Settings → Audit log page (`/settings/audit`); actions carry tone-coded badges.

## 3. Threat model (STRIDE, one page)

| Threat | Vector | Mitigation | Status |
|---|---|---|---|
| Spoofing | Stolen session cookie | httpOnly + SameSite=Lax; sha256-only storage; idle/absolute expiry; (TLS option) | done |
| Spoofing | Credential stuffing | argon2id + lockout 5×/15 min + generic failure message | done |
| Tampering | Money/SLA figures edited in transit | Session/tokens over TLS option; reports carry a SHA-256 snapshot hash for tamper evidence | partial |
| Tampering | Parameter injection into raw SQL | All raw SQL uses tagged-template bound parameters (audit: `grep -rn 'queryRaw' src/server`) | done |
| Repudiation | "I never resolved that incident" | Append-only `AuditLog` for login/logout/failed login/user+config changes; Settings → Audit log UI live (`/settings/audit`) | done |
| Information disclosure | Anonymous data read | Edge proxy 401/302 + per-route 401 (enumeration-tested) | done |
| Information disclosure | Cross-tenant read | `resolveTenantScope` on every tenant-scoped route (2b); scoped users cannot widen to fleet | done (matrix-tested) |
| Information disclosure | Verbose errors | `toErrorResponse` returns human messages + request id, never stack traces (verified in routes) | done |
| Denial of service | Login brute force | Lockout 5×/15 min + IP rate limit 10/5 min on login | done |
| Denial of service | Heavy endpoints (reports/exports) | Rate limits 2c (12/10 min reports, 20/min exports) | done |
| Elevation of privilege | UI-only role checks | All checks server-side in one module; UI never decides | done |
| Elevation of privilege | Secret leakage in repo | `.env`, `db/*.db`, tokens git-ignored + untracked (verified); secrets only via env | done |

## 4. OWASP ASVS L1 checklist (evidence-backed)

| ASVS area | Item | Status / evidence |
|---|---|---|
| V2 Authentication | Passwords argon2id, ≥12 chars, no trivial rejects | ✓ `tests/unit/auth.test.ts` |
| V2 | Lockout after 5 failures / 15 min | ✓ tested |
| V2 | Generic login failure message (no user enumeration) | ✓ same 401 text for unknown user and wrong password |
| V3 Session | Server-side session store; cookie httpOnly/SameSite=Lax/Secure-with-TLS | ✓ `session.ts` |
| V3 | Idle 8 h + absolute 7 d expiry | ✓ `session.ts` (unit-tested expiry math lives with integration tests) |
| V3 | Logout destroys server session | ✓ `/api/auth/logout` |
| V4 Access control | Central authz module; deny-by-default on every route | ✓ enumeration test |
| V4 | Role hierarchy enforced server-side | ✓ `roleAtLeast` tested |
| V4 | Tenant isolation | ✓ `resolveTenantScope` — generated cross-tenant matrix `tests/integration/authz-matrix.mjs` → 128/128 |
| V5 Validation | zod schemas on auth payloads | ✓ routes |
| V5 | Bound-parameter raw SQL everywhere | ✓ tagged templates only |
| V7 Errors | No stack traces to clients | ✓ `toErrorResponse` |
| V8 Data protection | Password hashes only; no secrets committed | ✓ `git ls-files` audit |
| V14 Headers | CSP (nonce + strict-dynamic scripts, frame-ancestors none), nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, HSTS-with-TLS | ✓ `src/proxy.ts`; headers verified against a running instance |
| V14 | Rate limiting on auth + expensive routes | ✓ `src/server/ratelimit.ts` (2c), unit-tested |
| V4 | Account lifecycle (disable/enable, logout-everywhere, last-owner guard) | ✓ `/api/users*`, audit-logged |
| V9 Communications | HSTS only when TLS declared (`SENTINEL_TLS=1`) | ✓ `proxy.ts` |

L2 items (authentication/session/access-control/audit depth) are tracked with the
same table as they land; the audit log already covers V7/V8 core events.

## 5. Secret management

- Secrets come **only** from environment variables (`.env` dev, compose env prod).
- `.env` is git-ignored and untracked; `.env.example` documents every variable with no real values.
- Session/token values are stored hashed (sha256); passwords argon2id; nothing reversible in the DB.
- `SENTINEL_TLS=1` marks a TLS-terminated deployment (behind Caddy/Nginx) → `Secure` cookies + HSTS.
- The Alertmanager webhook secret never enters the repo.

## 6. Hardening steps for operators (summary; full guide in [OPERATIONS.md](OPERATIONS.md))

1. Run behind TLS (Caddy or Nginx) and set `SENTINEL_TLS=1`.
2. Keep `.env` readable only by the service account (`chmod 600`); rotate the generated secrets by re-running the installer or editing `.env`.
3. Create individual accounts per operator; give `viewer` to read-only stakeholders.
4. Review Settings → Audit log weekly.
5. Keep the monitoring stack unmodified and on an internal network (compose default).

## 7. Dependency audit

Command: `bun audit` (2026-10-08, after cleanup). Result: **0 critical**, 39→21 high,
13 moderate across 20→14 packages. Direct fixes applied:

- `next` 16.1.3 → **16.4.0** — killed both criticals (Windows-hosted RCE
  GHSA-p293-qw3h-jr36, Image-Optimization AVIF RCE GHSA-2xp9-vwfh-vxw4) and several
  highs (SSRF-via-rewrites, Image-Optimization DoS, Server-Function disclosure).
- Removed 6 **unused** scaffold dependencies (0 imports in `src/`): `next-intl`
  (2 advisories), `next-auth` (superseded by the v2 auth stack), `@reactuses/core`
  (pulled the js-cookie HIGH), `@mdxeditor/editor`, `react-syntax-highlighter`, `uuid`.
- `bun update` within-range patch sweep.

Remaining advisories, each explained:

| Package (chain) | Sev | Runtime-reachable? | Explanation / mitigation |
|---|---|---|---|
| `sharp` (direct, via next image pipeline) | high ×3 | build/server-side only | Vulnerability classes are DoS-via-crafted-images in the processor. Sentinel accepts **no** image uploads; Image Optimization consumes only first-party static assets. Not attacker-reachable today; revisit if image handling changes. |
| `lodash` (recharts) | mod ×2, hi ×1 | client charts | `_.unset`/`_.omit` prototype-pollution requires attacker-controlled key paths into those calls; recharts uses lodash internally on engine-generated chart data. |
| `nanoid` (postcss via next/tailwind) | high ×3 | build-time (CSS processing) | nanoid is used by postcss during compilation, not at request time. |
| `prisma › @prisma/config › {deepmerge-ts, defu, effect}` | high ×5 | CLI/ops-time | Prisma CLI config loading (`prisma migrate/generate/db push`) parses **our** config files, never untrusted input. |
| `brace-expansion`, `minimatch`, `js-yaml`, `flatted`, `picomatch`, `braces`, `browserslist`, `@humanfs/node`, `baseline-browser-mapping`, `source-map-js`, `postcss` | high/mod | dev tooling (eslint/vitest/next build) | Never shipped to production bundles; reachable only by developers running lint/tests/build on trusted sources. |

Re-run the audit before each release; the table updates as advisories rotate. Any future **critical** or
runtime-reachable **high** becomes a fix-before-release item, not a table row.

## 8. Scanner evidence (OWASP ZAP baseline)

Run `zap-baseline.py -t http://<host>:3000` against a TLS-deployed instance after
login. The headers, cookies, CSP and auth behaviour are what the ZAP baseline checks;
the expected result is zero high alerts. No ZAP report is committed to the repository.

---

<p dir="rtl" align="right"><sub>امنیت یک ویژگی نیست، یک عادت است: کمترین دسترسی، ثبت همه‌چیز، و بی‌اعتمادی به ورودی.</sub></p>

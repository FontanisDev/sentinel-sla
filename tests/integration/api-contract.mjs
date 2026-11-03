#!/usr/bin/env node
// Sentinel-SLA — API contract tests over the LIVE server.
//
// Contract tests call every endpoint and validate the response against
// the schema.
//
// What this proves, per round:
//   1. openapi/openapi.yaml parses and is internally consistent ($refs
//      resolve, every operation has an operationId) — hard fail otherwise.
//   2. EVERY operation in the OpenAPI document is exercised at least once:
//        · reads (GET) with an owner session → 200 body validated against
//          the schema (ajv, OAS-3.0 → JSON-Schema converted);
//        · every protected operation without a session → 401 with the
//          ErrorEnvelope body (pure, no state touched);
//        · mutating operations that can run safely are executed end-to-end
//          against scratch resources (create → use → delete round-trips);
//        · the remainder are listed in SKIP_MUTATIONS with an honest
//          reason (they would pause the engine, inject faults, mutate
//          global integration settings or rewrite seeded incident state).
//   3. The exercised-operation accounting is printed; any spec operation
//      neither exercised nor explicitly skipped fails the run.
//
// Usage:
//   CONTRACT_BASE_URL=http://127.0.0.1:3000 \
//   CONTRACT_OWNER_EMAIL=owner@sentinel.test \
//   CONTRACT_OWNER_PASSWORD='…' node tests/integration/api-contract.mjs
//
// Credentials live in env or the UNTRACKED .env.test file (never committed).
// With no server configured the script exits 77 (skip) so offline runs stay
// green — the same convention as tests/integration/authz-matrix.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// ── configuration ────────────────────────────────────────────────────────────

function loadEnvTest() {
  const file = path.join(ROOT, '.env.test');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const envTest = loadEnvTest();
const BASE_URL = (process.env.CONTRACT_BASE_URL ?? envTest.CONTRACT_BASE_URL ?? '').replace(/\/$/, '');
const OWNER_EMAIL = process.env.CONTRACT_OWNER_EMAIL ?? envTest.CONTRACT_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.CONTRACT_OWNER_PASSWORD ?? envTest.CONTRACT_OWNER_PASSWORD;
// Dev-box alternative: pass a pre-minted session cookie (scripts/mint-dev-session.mjs)
// instead of credentials. CI uses the setup/login path below.
const PRESET_COOKIE = process.env.CONTRACT_SESSION_COOKIE ?? envTest.CONTRACT_SESSION_COOKIE;

if (!BASE_URL || (!PRESET_COOKIE && (!OWNER_EMAIL || !OWNER_PASSWORD))) {
  console.log(
    '[api-contract] SKIP (exit 77): set CONTRACT_BASE_URL and either CONTRACT_SESSION_COOKIE ' +
      '(dev mint) or CONTRACT_OWNER_EMAIL/CONTRACT_OWNER_PASSWORD (env or untracked .env.test).\n' +
      'Offline structural invariants (spec ↔ routes, API.md sync) live in tests/integration/test_stack.sh.',
  );
  process.exit(77);
}

// ── load + structural-check the OpenAPI document ────────────────────────────────────────

const SPEC_PATH = path.join(ROOT, 'openapi', 'openapi.yaml');
const spec = parse(fs.readFileSync(SPEC_PATH, 'utf8'));

if (spec.openapi !== '3.0.3') fail(`spec must declare openapi 3.0.3, found ${spec.openapi}`);
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (spec.info.version !== pkg.version) {
  fail(`spec info.version (${spec.info.version}) !== package.json version (${pkg.version})`);
}

const OPERATIONS = []; // { path, method, op, public }
for (const [p, pathItem] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(pathItem)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    if (!op.operationId) fail(`${method.toUpperCase()} ${p} has no operationId`);
    OPERATIONS.push({ path: p, method, op, public: op.security === [] || (op.security && op.security.length === 0) });
  }
}
if (OPERATIONS.length < 60) fail(`expected ≥60 operations in the document, found ${OPERATIONS.length}`);

function fail(msg) {
  console.error(`[api-contract] FAIL: ${msg}`);
  process.exit(1);
}

// ── OAS 3.0 → JSON Schema conversion + ajv setup ─────────────────────────────

function toDraft07(schema, refs) {
  if (Array.isArray(schema)) return schema.map((s) => toDraft07(s, refs));
  if (schema === null || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$ref' && typeof v === 'string') {
      const name = v.split('/').pop();
      if (!refs[name]) fail(`unresolvable $ref: ${v}`);
      out.$ref = `#/definitions/${name}`;
      continue;
    }
    if (k === 'nullable' && v === true) {
      out.__nullable = true; // handled below
      continue;
    }
    // OAS-3.0 boolean exclusiveMinimum/Maximum → draft-6 numeric form (ajv 8)
    if ((k === 'exclusiveMinimum' || k === 'exclusiveMaximum') && v === true) {
      out[k] = '__BOOL__';
      continue;
    }
    out[k] = toDraft07(v, refs);
  }
  if (out.exclusiveMinimum === '__BOOL__' && typeof out.minimum === 'number') out.exclusiveMinimum = out.minimum;
  else if (out.exclusiveMinimum === '__BOOL__') delete out.exclusiveMinimum;
  if (out.exclusiveMaximum === '__BOOL__' && typeof out.maximum === 'number') out.exclusiveMaximum = out.maximum;
  else if (out.exclusiveMaximum === '__BOOL__') delete out.exclusiveMaximum;
  if (out.__nullable) {
    delete out.__nullable;
    const base = { ...out };
    // the outer object must NOT keep its own type — the anyOf carries it
    for (const k of Object.keys(out)) delete out[k];
    out.anyOf = [base, { type: 'null' }];
  }
  return out;
}

const definitions = {};
for (const [name, sch] of Object.entries(spec.components.schemas)) {
  definitions[name] = toDraft07(sch, spec.components.schemas);
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validateFnCache = new Map();
function validateAgainst(schemaOrRef, body, label) {
  if (!schemaOrRef) return; // nothing declared
  const key = JSON.stringify(schemaOrRef);
  let fn = validateFnCache.get(key);
  if (!fn) {
    const converted = toDraft07(schemaOrRef, spec.components.schemas);
    // inline the shared definitions so nested $refs resolve
    fn = ajv.compile({ definitions, ...converted });
    validateFnCache.set(key, fn);
  }
  const ok = fn(body);
  if (!ok) {
    throw new Error(
      `${label}: body does not match spec schema — ${ajv.errorsText(fn.errors).slice(0, 400)}`,
    );
  }
}

function responseSchema(op, status, contentType = 'application/json') {
  const res = op.responses?.[String(status)];
  if (!res) return undefined;
  if (res.$ref) {
    const shared = spec.components.responses[res.$ref.split('/').pop()];
    if (!shared) return undefined;
    return shared.content?.[contentType]?.schema;
  }
  return res.content?.[contentType]?.schema;
}

// ── tiny cookie-jar fetch (rate-limiter aware, like the authz matrix) ────────

function makeClient(presetCookie) {
  let cookie = presetCookie ?? null;
  return {
    get cookie() {
      return cookie;
    },
    async req(pathname, { method = 'GET', body, headers = {}, _retried429 = false } = {}) {
      const verb = String(method).toUpperCase(); // spec keys are lowercase; undici is not
      const h = { ...headers };
      if (cookie) h.cookie = cookie;
      if (body !== undefined) h['content-type'] = 'application/json';
      const res = await fetch(`${BASE_URL}${pathname}`, {
        method: verb,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const m = setCookie.match(/sentinel_session=[^;]+/);
        if (m) cookie = m[0];
      }
      // Honour the rate limiter: wait out Retry-After and retry —
      // dense sweeps legitimately accumulate per-IP request counts. Cap the
      // patience so a stuck limiter still fails the run instead of hanging.
      if (res.status === 429 && _retried429 < 3) {
        const wait = Math.min(Number(res.headers.get('retry-after') ?? 5), 60);
        console.log(`  · 429 on ${verb} ${pathname} — waiting ${wait}s before retry ${_retried429 + 1}/3`);
        await new Promise((r) => setTimeout(r, wait * 1000 + 250));
        return this.req(pathname, { method: verb, body, headers, _retried429: _retried429 + 1 });
      }
      return res;
    },
  };
}

const client = makeClient(PRESET_COOKIE);
// Phase A must NEVER hold a session — it sweeps for 401s (and a preset cookie
// would wrongly pass, plus POST /api/auth/logout in the sweep would revoke it).
const anon = makeClient(null);

// ── accounting ───────────────────────────────────────────────────────────────

const exercised = new Set(); // `${method} ${path}`
const skipped = new Map(); // `${method} ${path}` → reason
let checks = 0;
let errors = 0;

function mark(method, path) {
  exercised.add(`${method.toLowerCase()} ${path}`);
}
function skip(method, path, reason) {
  skipped.set(`${method.toLowerCase()} ${path}`, reason);
}
function check(cond, label) {
  checks++;
  if (!cond) {
    errors++;
    console.error(`  ✗ ${label}`);
  }
}
async function expectBody(res, op, status, label, contentType = 'application/json') {
  const schema = responseSchema(op, status, contentType);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  check(body !== null, `${label}: 2xx response must be JSON (got ${(text || '').slice(0, 60)})`);
  if (body !== null) {
    try {
      validateAgainst(schema, body, label);
      check(true, label);
    } catch (e) {
      check(false, e.message);
    }
  }
  return body;
}

// ── session bootstrap (setup when fresh, login otherwise) ────────────────────

async function ensureOwnerSession() {
  if (PRESET_COOKIE) {
    // dev mint — credentials unavailable to the harness, so login itself is
    // honestly skipped (the authz matrix covers login separately)
    skip('POST', '/api/auth/login', 'preset session cookie used; no credentials in env');
    return;
  }
  const avail = await (await client.req('/api/auth/setup')).json();
  mark('GET', '/api/auth/setup');
  if (avail?.available) {
    const res = await client.req('/api/auth/setup', {
      method: 'POST',
      body: { name: 'Contract Owner', email: OWNER_EMAIL, password: OWNER_PASSWORD },
    });
    if (res.status !== 201 && res.status !== 200) fail(`setup failed: ${res.status}`);
    mark('POST', '/api/auth/setup');
    return;
  }
  const res = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
  });
  if (res.status !== 200) fail(`login failed: ${res.status} — check CONTRACT_OWNER_* credentials`);
  mark('POST', '/api/auth/login');
}

// ── phase A: unauthenticated sweep over every protected operation ────────────

async function phaseA() {
  console.log('\n── Phase A · unauthenticated 401 sweep (no state touched) ──');
  for (const { path: p, method, op, public: isPublic } of OPERATIONS) {
    if (isPublic) continue; // public ops have no auth contract to prove here
    const concrete = p.replace(/\{(\w+)\}/g, '00000000-0000-0000-0000-000000000000');
    const res = await anon.req(concrete, { method });
    if (res.status === 401) {
      const schema = responseSchema(op, 401) ?? spec.components.schemas.ErrorEnvelope;
      const body = await res.json().catch(() => null);
      try {
        validateAgainst(schema, body, `401 ${method.toUpperCase()} ${p}`);
        check(true, `401 envelope ok — ${method.toUpperCase()} ${p}`);
      } catch (e) {
        check(false, e.message);
      }
    } else if (res.status === 404 || res.status === 405) {
      // unknown-id probes legitimately 404 AFTER auth on some handlers…
      // but auth must run FIRST — a 404 without a session is a contract bug.
      check(false, `unauthenticated ${method.toUpperCase()} ${p} → ${res.status} (expected 401 first)`);
    } else {
      check(false, `unauthenticated ${method.toUpperCase()} ${p} → ${res.status} (expected 401)`);
    }
    mark(method, p);
  }
}

// ── phase B: authenticated reads + safe mutation round-trips ─────────────────

const SKIP_MUTATIONS = {
  'POST /api/engine': 'pauses/resumes the shared simulation engine — mutating live runtime state',
  'POST /api/chaos': 'injects real faults into the running fleet — disturbs demo/live telemetry',
  'POST /api/chaos/auto': 'toggles the engine auto-chaos scheduler — mutating runtime state',
  'POST /api/incidents/{id}/acknowledge': 'rewrites seeded incident acknowledgement state (401 sweep covers the contract)',
  'POST /api/incidents/{id}/resolve': 'rewrites seeded incident lifecycle state (401 sweep covers the contract)',
  'POST /api/ai/postmortem': 'overwrites aiSummary on real incidents (401 sweep covers the contract)',
  'PUT /api/escalation': 'mutates the single fleet-wide escalation policy',
  'POST /api/resilience': 'starts a 40–60 s self-test run — mutating runtime state',
  'PUT /api/resilience': 'mutates the weekly self-test schedule',
  'PUT /api/integrations/notify': 'mutates the global notification transport',
  'PUT /api/integrations/digest': 'mutates the executive digest schedule',
  'POST /api/integrations/digest': 'fans out real digest messages',
  'PUT /api/integrations/prometheus': 'mutates the Prometheus connection',
  'POST /api/integrations/prometheus/test': 'probes external infrastructure with candidate settings',
  'POST /api/auth/logout': 'would destroy the session the test itself is using (covered by UI + matrix)',
};

async function phaseB() {
  console.log('\n── Phase B · authenticated reads + safe round-trips (owner session) ──');

  // setup must now be closed (owner exists)
  {
    const op = spec.paths['/api/auth/setup'].post;
    const res = await client.req('/api/auth/setup', { method: 'POST', body: { name: 'x', email: 'x@x.test', password: 'y' } });
    check(res.status === 403, `POST /api/auth/setup → 403 after setup (got ${res.status})`);
    await expectBody(res, op, 403, 'POST /api/auth/setup 403 envelope');
    mark('POST', '/api/auth/setup');
  }

  // ── plain reads ──
  const reads = [
    ['/api', {}],
    ['/api/health/live', {}],
    ['/api/health/ready', {}],
    ['/api/auth/session', {}],
    ['/api/auth/setup', {}],
    ['/api/onboarding', { label: 'GET /api/onboarding' }],
    ['/api/dashboard', { label: 'GET /api/dashboard' }],
    ['/api/incidents?limit=10', {}],
    ['/api/alerts?limit=10', {}],
    ['/api/analytics', {}],
    ['/api/contracts', {}],
    ['/api/maintenance', {}],
    ['/api/rules', {}],
    ['/api/channels', {}],
    ['/api/oncall', {}],
    ['/api/escalation', {}],
    ['/api/notifications/outbox?limit=20', {}],
    ['/api/notifications/delivery?limit=20', {}],
    ['/api/notifications/templates', {}],
    ['/api/reports', {}],
    ['/api/schedules', {}],
    ['/api/schedules/runs', {}],
    ['/api/resilience', {}],
    ['/api/tenants', {}],
    ['/api/users', {}],
    ['/api/audit?limit=50', {}],
    ['/api/integrations/prometheus', {}],
    ['/api/integrations/notify', {}],
    ['/api/integrations/digest', {}],
    ['/api/export/incidents?format=json&limit=10', { contentType: 'application/json' }],
    ['/api/export/services?format=json', { contentType: 'application/json' }],
    ['/api/export/analytics?format=json', { contentType: 'application/json' }],
  ];
  for (const [url, { contentType }] of reads) {
    const basePath = url.split('?')[0];
    const op = spec.paths[basePath]?.get;
    if (!op) {
      check(false, `spec has no GET ${basePath} but the server route exists`);
      continue;
    }
    const res = await client.req(url);
    check(res.status === 200, `GET ${basePath} → 200 (got ${res.status})`);
    if (res.status === 200) {
      await expectBody(res, op, 200, `GET ${basePath} 200 body`, contentType);
    }
    mark('GET', basePath);
  }

  // CSV exports (text/csv content — schema binary, shape-checked loosely)
  for (const url of ['/api/export/incidents?format=csv&limit=5', '/api/export/services?format=csv']) {
    const res = await client.req(url);
    check(res.status === 200, `GET ${url} → 200 (got ${res.status})`);
    const text = await res.text();
    check(res.headers.get('content-type')?.includes('text/csv'), `${url} serves text/csv`);
    check(text.length > 0, `${url} non-empty csv`);
    mark('GET', url.split('?')[0]);
  }

  // ── reads that need an id from another collection ──
  const services = (await (await client.req('/api/services')).json())?.services ?? [];
  if (services.length > 0) {
    const key = services[0].key;
    {
      const op = spec.paths['/api/services/{key}'].get;
      const res = await client.req(`/api/services/${key}`);
      check(res.status === 200, `GET /api/services/{key} → 200`);
      if (res.status === 200) await expectBody(res, op, 200, 'GET /api/services/{key} 200 body');
      mark('GET', '/api/services/{key}');
    }
    {
      const op = spec.paths['/api/metrics/history'].get;
      const res = await client.req(`/api/metrics/history?serviceId=${services[0].id}&minutes=30`);
      check(res.status === 200, `GET /api/metrics/history → 200`);
      if (res.status === 200) await expectBody(res, op, 200, 'GET /api/metrics/history 200 body');
      mark('GET', '/api/metrics/history');
    }
  }
  const incidents = (await (await client.req('/api/incidents?limit=1')).json())?.incidents ?? [];
  if (incidents.length > 0) {
    const op = spec.paths['/api/incidents/{id}'].get;
    const res = await client.req(`/api/incidents/${incidents[0].id}`);
    check(res.status === 200, `GET /api/incidents/{id} → 200`);
    if (res.status === 200) await expectBody(res, op, 200, 'GET /api/incidents/{id} 200 body');
    mark('GET', '/api/incidents/{id}');
  }

  // ── safe round-trips on scratch resources ──
  const stamp = Date.now().toString(36);

  // tenants (admin+)
  {
    const op = spec.paths['/api/tenants'].post;
    const res = await client.req('/api/tenants', { method: 'POST', body: { key: `qa-${stamp}`, name: `QA Contract ${stamp}`, nameFa: 'کیوای قرارداد' } });
    check(res.status === 201, `POST /api/tenants → 201 (got ${res.status})`);
    const tenant = res.status === 201 ? await res.json() : null;
    if (tenant) await expectBody({ status: () => 201, text: () => Promise.resolve(JSON.stringify(tenant)) }, op, 201, 'POST /api/tenants 201 body');
    mark('POST', '/api/tenants');
  }

  // channels: create → toggle → test → delete
  {
    const createOp = spec.paths['/api/channels'].post;
    const res = await client.req('/api/channels', { method: 'POST', body: { name: `QA channel ${stamp}`, kind: 'webhook', target: 'https://example.test/hook' } });
    check(res.status === 201, `POST /api/channels → 201 (got ${res.status})`);
    const channel = res.status === 201 ? await res.json() : null;
    if (channel) await expectBody({ status: () => 201, text: () => Promise.resolve(JSON.stringify(channel)) }, createOp, 201, 'POST /api/channels 201 body');
    mark('POST', '/api/channels');
    if (channel?.id) {
      const toggleOp = spec.paths['/api/channels/{id}/toggle'].post;
      const tRes = await client.req(`/api/channels/${channel.id}/toggle`, { method: 'POST', body: { enabled: false } });
      check(tRes.status === 200, `POST /api/channels/{id}/toggle → 200 (got ${tRes.status})`);
      if (tRes.status === 200) await expectBody(tRes, toggleOp, 200, 'POST /api/channels/{id}/toggle 200 body');
      mark('POST', '/api/channels/{id}/toggle');

      const patchOp = spec.paths['/api/channels/{id}'].patch;
      const pRes = await client.req(`/api/channels/${channel.id}`, { method: 'PATCH', body: { name: `QA channel ${stamp} renamed` } });
      check(pRes.status === 200, `PATCH /api/channels/{id} → 200 (got ${pRes.status})`);
      if (pRes.status === 200) await expectBody(pRes, patchOp, 200, 'PATCH /api/channels/{id} 200 body');
      mark('PATCH', '/api/channels/{id}');

      const delRes = await client.req(`/api/channels/${channel.id}`, { method: 'DELETE' });
      check(delRes.status === 200, `DELETE /api/channels/{id} → 200 (got ${delRes.status})`);
      if (delRes.status === 200) await expectBody(delRes, spec.paths['/api/channels/{id}'].delete, 200, 'DELETE /api/channels/{id} 200 body');
      mark('DELETE', '/api/channels/{id}');
    }
  }

  // rules: create → toggle → delete
  {
    const res = await client.req('/api/rules', { method: 'POST', body: { name: `QA rule ${stamp}`, metric: 'latencyMs', operator: 'gt', threshold: 5000 } });
    check(res.status === 201, `POST /api/rules → 201 (got ${res.status})`);
    const rule = res.status === 201 ? await res.json() : null;
    if (rule) await expectBody({ status: () => 201, text: () => Promise.resolve(JSON.stringify(rule)) }, spec.paths['/api/rules'].post, 201, 'POST /api/rules 201 body');
    mark('POST', '/api/rules');
    if (rule?.id) {
      const tRes = await client.req(`/api/rules/${rule.id}/toggle`, { method: 'POST', body: { enabled: false } });
      check(tRes.status === 200, `POST /api/rules/{id}/toggle → 200 (got ${tRes.status})`);
      if (tRes.status === 200) await expectBody(tRes, spec.paths['/api/rules/{id}/toggle'].post, 200, 'POST /api/rules/{id}/toggle 200 body');
      mark('POST', '/api/rules/{id}/toggle');
      const dRes = await client.req(`/api/rules/${rule.id}`, { method: 'DELETE' });
      check(dRes.status === 200, `DELETE /api/rules/{id} → 200 (got ${dRes.status})`);
      mark('DELETE', '/api/rules/{id}');
    }
  }

  // on-call: create → delete
  {
    const res = await client.req('/api/oncall', { method: 'POST', body: { engineerName: `QA Engineer ${stamp}`, role: 'Secondary', handle: `@qa-${stamp}`, dayOfWeek: 3, startMinute: 540, endMinute: 1080 } });
    check(res.status === 201, `POST /api/oncall → 201 (got ${res.status})`);
    const entry = res.status === 201 ? await res.json() : null;
    if (entry) await expectBody({ status: () => 201, text: () => Promise.resolve(JSON.stringify(entry)) }, spec.paths['/api/oncall'].post, 201, 'POST /api/oncall 201 body');
    mark('POST', '/api/oncall');
    if (entry?.id) {
      const dRes = await client.req(`/api/oncall/${entry.id}`, { method: 'DELETE' });
      check(dRes.status === 200, `DELETE /api/oncall/{id} → 200 (got ${dRes.status})`);
      mark('DELETE', '/api/oncall/{id}');
    }
  }

  // maintenance: create (5 min, fleet) → cancel
  {
    const res = await client.req('/api/maintenance', { method: 'POST', body: { reason: `QA contract window ${stamp}`, durationMin: 5 } });
    check(res.status === 201, `POST /api/maintenance → 201 (got ${res.status})`);
    const win = res.status === 201 ? await res.json() : null;
    if (win) await expectBody({ status: () => 201, text: () => Promise.resolve(JSON.stringify(win)) }, spec.paths['/api/maintenance'].post, 201, 'POST /api/maintenance 201 body');
    mark('POST', '/api/maintenance');
    if (win?.id) {
      const cRes = await client.req(`/api/maintenance/${win.id}/cancel`, { method: 'POST' });
      check(cRes.status === 200, `POST /api/maintenance/{id}/cancel → 200 (got ${cRes.status})`);
      if (cRes.status === 200) await expectBody(cRes, spec.paths['/api/maintenance/{id}/cancel'].post, 200, 'POST /api/maintenance/{id}/cancel 200 body');
      mark('POST', '/api/maintenance/{id}/cancel');
    }
  }

  // schedules: create → toggle → run → delete
  {
    const res = await client.req('/api/schedules', { method: 'POST', body: { label: `QA schedule ${stamp}`, frequency: 'weekly', dayOfWeek: 1, hour: 7, kind: 'executive', language: 'en' } });
    check(res.status === 201, `POST /api/schedules → 201 (got ${res.status})`);
    const sched = res.status === 201 ? await res.json() : null;
    if (sched) await expectBody({ status: () => 201, text: () => Promise.resolve(JSON.stringify(sched)) }, spec.paths['/api/schedules'].post, 201, 'POST /api/schedules 201 body');
    mark('POST', '/api/schedules');
    if (sched?.id) {
      const tRes = await client.req(`/api/schedules/${sched.id}/toggle`, { method: 'POST', body: { enabled: false } });
      check(tRes.status === 200, `POST /api/schedules/{id}/toggle → 200 (got ${tRes.status})`);
      if (tRes.status === 200) await expectBody(tRes, spec.paths['/api/schedules/{id}/toggle'].post, 200, 'POST /api/schedules/{id}/toggle 200 body');
      mark('POST', '/api/schedules/{id}/toggle');
      const rRes = await client.req(`/api/schedules/${sched.id}/run`, { method: 'POST' });
      check(rRes.status === 200 || rRes.status === 202, `POST /api/schedules/{id}/run → 200/202 (got ${rRes.status})`);
      if (rRes.ok) await expectBody(rRes, spec.paths['/api/schedules/{id}/run'].post, rRes.status, 'POST /api/schedules/{id}/run body');
      mark('POST', '/api/schedules/{id}/run');
      const dRes = await client.req(`/api/schedules/${sched.id}`, { method: 'DELETE' });
      check(dRes.status === 200, `DELETE /api/schedules/{id} → 200 (got ${dRes.status})`);
      mark('DELETE', '/api/schedules/{id}');
    }
  }

  // reports: generate → download → regenerate
  {
    const res = await client.req('/api/reports', { method: 'POST', body: { kind: 'executive', language: 'en' } });
    check(res.status === 201, `POST /api/reports → 201 (got ${res.status})`);
    const report = res.status === 201 ? await res.json() : null;
    if (report) await expectBody({ status: () => 201, text: () => Promise.resolve(JSON.stringify(report)) }, spec.paths['/api/reports'].post, 201, 'POST /api/reports 201 body');
    mark('POST', '/api/reports');
    if (report?.id) {
      const dl = await client.req(`/api/reports/${report.id}/download`);
      check(dl.status === 200, `GET /api/reports/{id}/download → 200 (got ${dl.status})`);
      const buf = await dl.arrayBuffer();
      check(buf.byteLength > 1000, 'report PDF non-trivial size');
      mark('GET', '/api/reports/{id}/download');
      const rg = await client.req(`/api/reports/${report.id}/regenerate`, { method: 'POST' });
      check(rg.status === 201, `POST /api/reports/{id}/regenerate → 201 (got ${rg.status})`);
      if (rg.status === 201) await expectBody(rg, spec.paths['/api/reports/{id}/regenerate'].post, 201, 'POST /api/reports/{id}/regenerate 201 body');
      mark('POST', '/api/reports/{id}/regenerate');
    }
  }

  // users: create → patch → revoke sessions → delete (full admin round-trip)
  {
    const res = await client.req('/api/users', { method: 'POST', body: { name: `QA User ${stamp}`, email: `qa-${stamp}@contract.test`, password: 'qa-contract-pass-2026-strong', role: 'viewer', locale: 'en' } });
    check(res.status === 201, `POST /api/users → 201 (got ${res.status})`);
    const user = res.status === 201 ? await res.json() : null;
    if (user) await expectBody({ status: () => 201, text: () => Promise.resolve(JSON.stringify(user)) }, spec.paths['/api/users'].post, 201, 'POST /api/users 201 body');
    mark('POST', '/api/users');
    if (user?.id) {
      const pRes = await client.req(`/api/users/${user.id}`, { method: 'PATCH', body: { name: `QA User ${stamp} v2` } });
      check(pRes.status === 200, `PATCH /api/users/{id} → 200 (got ${pRes.status})`);
      if (pRes.status === 200) await expectBody(pRes, spec.paths['/api/users/{id}'].patch, 200, 'PATCH /api/users/{id} 200 body');
      mark('PATCH', '/api/users/{id}');
      const sRes = await client.req(`/api/users/${user.id}/sessions`, { method: 'DELETE' });
      check(sRes.status === 200, `DELETE /api/users/{id}/sessions → 200 (got ${sRes.status})`);
      mark('DELETE', '/api/users/{id}/sessions');
      const dRes = await client.req(`/api/users/${user.id}`, { method: 'DELETE' });
      check(dRes.status === 200, `DELETE /api/users/{id} → 200 (got ${dRes.status})`);
      mark('DELETE', '/api/users/{id}');
    }
  }

  // public webhooks (deterministic negative paths)
  {
    const res = await client.req('/api/integrations/telegram/callback', { method: 'POST', body: { token: 'definitely-not-valid' } });
    check([200, 401, 503].includes(res.status), `POST /api/integrations/telegram/callback → 200/401/503 (got ${res.status})`);
    await expectBody(res, spec.paths['/api/integrations/telegram/callback'].post, res.status, 'telegram callback body');
    mark('POST', '/api/integrations/telegram/callback');
  }
  {
    const res = await client.req('/api/integrations/alertmanager', { method: 'POST', body: {} });
    check([200, 401, 503].includes(res.status), `POST /api/integrations/alertmanager → 200/401/503 (got ${res.status})`);
    await expectBody(res, spec.paths['/api/integrations/alertmanager'].post, res.status, 'alertmanager webhook body');
    mark('POST', '/api/integrations/alertmanager');
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log(`[api-contract] target: ${BASE_URL}`);
console.log(`[api-contract] spec: ${OPERATIONS.length} operations across ${Object.keys(spec.paths).length} paths, ${Object.keys(spec.components.schemas).length} schemas`);

try {
  await ensureOwnerSession();
  await phaseA();
  await phaseB();
} catch (e) {
  fail(e?.stack ?? String(e));
}

// register the honest skips before accounting
for (const [key, why] of Object.entries(SKIP_MUTATIONS)) {
  const [method, p] = key.split(' ');
  skipped.set(`${method.toLowerCase()} ${p}`, why);
}

// accounting: every operation must be exercised or explicitly skipped
const missing = [];
for (const { path: p, method } of OPERATIONS) {
  const key = `${method.toLowerCase()} ${p}`;
  if (!exercised.has(key) && !skipped.has(key)) missing.push(key);
}

console.log('\n── Coverage accounting ──');
console.log(`exercised: ${exercised.size} / ${OPERATIONS.length}`);
if (skipped.size > 0) {
  console.log('skipped (mutating, honest reasons):');
  for (const [k, why] of skipped) console.log(`  · ${k} — ${why}`);
}
if (missing.length > 0) {
  console.error('NOT covered and NOT skipped:');
  for (const k of missing) console.error(`  ✗ ${k}`);
  errors += missing.length;
}

console.log(`\n[api-contract] ${checks} checks, ${errors} failures`);
if (errors > 0) process.exit(1);
console.log('[api-contract] ALL GREEN — every response matched openapi/openapi.yaml');



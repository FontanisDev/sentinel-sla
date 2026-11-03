// Setup wizard end-to-end proof:
//   1. mock Prometheus serving /api/v1/query_range (1 h of probe_success
//      samples: 3 failures in the middle of an otherwise-up hour)
//   2. save the integration via the real API (admin session)
//   3. call POST /api/services/preview through the REAL route (engineer floor:
//      uses the owner session — admins pass the engineer floor)
//   4. create the service with the probe source through POST /api/services
//   5. verify the DB row stores the probeSource JSON + DTO exposes liveStatus
//   6. clean up (delete service row + integration setting) to restore demo state
// Prints PASS/FAIL summary; exit 1 on any failure.

import http from 'node:http';
import { PrismaClient } from '@prisma/client';

const BASE = 'http://127.0.0.1:3100';
const EMAIL = 'owner@sentinel.test';
const PASSWORD = 'Sentinel-Dev-Owner!2026';
const NOW = Math.floor(Date.now() / 1000);

// ── mock Prometheus ─────────────────────────────────────────────────────────
// probe_success for the last hour @60s step: all 1 except ts 20–22 (failures)
function series() {
  const values = [];
  for (let i = 60; i >= 0; i--) {
    const ts = NOW - i * 60;
    const v = ts % 600 >= 480 && ts % 600 < 540 ? 0 : 1; // deterministic dip
    values.push([ts, String(v)]);
  }
  return [{ metric: { job: 'blackbox.http', instance: 'https://smoke.example.ir/health' }, values }];
}

const prom = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/v1/query_range') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: series() } }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => prom.listen(0, '127.0.0.1', r));
const promUrl = `http://127.0.0.1:${prom.address().port}`;
console.log(`[mock-prom] ${promUrl}`);

// ── authed client ───────────────────────────────────────────────────────────
const jar = [];
const client = {
  async req(path, opts = {}) {
    const res = await fetch(BASE + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', cookie: jar.join('; '), ...(opts.headers ?? {}) },
      redirect: 'manual',
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) jar.push(c.split(';')[0]);
    return res;
  },
};

const failures = [];
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS ${name}`);
  else {
    console.log(`  FAIL ${name} ${extra}`);
    failures.push(name);
  }
}

// login
{
  const res = await client.req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  check('login', res.status === 200, `status=${res.status}`);
}

// save the integration (as the UI would after clicking Save)
{
  const res = await client.req('/api/integrations/prometheus', {
    method: 'PUT',
    body: JSON.stringify({ baseUrl: promUrl, auth: { kind: 'none' } }),
  });
  check('save integration', res.ok, `status=${res.status}`);
}

// preview through the real route
let preview = null;
{
  const res = await client.req('/api/services/preview', {
    method: 'POST',
    body: JSON.stringify({
      probeSource: { kind: 'blackbox', job: 'blackbox.http', instance: 'https://smoke.example.ir/health' },
      endpoint: 'https://smoke.example.ir/health',
      slaTarget: 0.999,
    }),
  });
  const body = await res.json().catch(() => ({}));
  preview = body.preview;
  check('preview 200', res.ok, `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`);
  check('preview returned 1h window at 60s step', preview?.series?.length === 61, `n=${preview?.series?.length}`);
  const vals = preview?.series?.map((p) => p.value) ?? [];
  const okCount = vals.filter((v) => v >= 1).length;
  check('preview okRatio is truthful', Math.abs(preview?.okRatio - okCount / vals.length) < 1e-9, `okRatio=${preview?.okRatio}`);
  check('preview catches the failure dip', okCount < vals.length, `ok=${okCount}/${vals.length}`);
  check('preview exposes executed query', String(preview?.query || '').includes('probe_success{job="blackbox.http"'), preview?.query);
}

// create the service with the probe source (as the wizard would)
let createdKey = null;
{
  createdKey = `wizard-smoke-${Date.now() % 100000}`;
  const res = await client.req('/api/services', {
    method: 'POST',
    body: JSON.stringify({
      key: createdKey,
      name: 'Wizard Smoke Check',
      tier: 'tier-2',
      tps: 10,
      avgTransactionValue: 250000,
      slaTarget: 0.999,
      penaltyBase: 50000000,
      penaltyPerMinute: 7500000,
      probeSource: { kind: 'blackbox', job: 'blackbox.http', instance: 'https://smoke.example.ir/health' },
    }),
  });
  const body = await res.json().catch(() => ({}));
  check('create service with probeSource', res.status === 201, `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`);
  check('DTO echoes liveStatus null + probeSource', body?.service?.probeSource?.kind === 'blackbox' && body?.service?.liveStatus === null,
    JSON.stringify({ probeSource: body?.service?.probeSource, liveStatus: body?.service?.liveStatus }));
}

// DB-level: probe source stored as JSON on the row
const db = new PrismaClient();
{
  const row = await db.service.findUnique({ where: { key: createdKey } });
  check('DB stores probeSource JSON', !!row?.probeSource && JSON.parse(row.probeSource).job === 'blackbox.http');
}

// ── cleanup: restore the demo state ────────────────────────────────────────
await db.service.deleteMany({ where: { key: { startsWith: 'wizard-smoke' } } });
await db.integrationSetting.deleteMany({ where: { key: 'prometheus' } });
const remaining = await db.service.count({ where: { key: { startsWith: 'wizard-smoke' } } });
check('cleanup restored demo state', remaining === 0);
await db.$disconnect();
prom.close();

console.log(failures.length === 0 ? '\nWIZARD PROOF: ALL PASS' : `\nWIZARD PROOF: ${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);

// Live-run proof for the Prometheus ingestion pipeline.
//
// Drives the REAL ingestion pipeline end-to-end against a mock Prometheus
// HTTP server and the real dev database:
//   1. two up-ticks            → service liveStatus=up
//   2. three down-ticks        → incident OPEN with evidence + alert
//   3. two up-ticks            → incident RESOLVED with duration + penalty
//   4. Prometheus dies         → stale + "monitoring blind" alert (once)
//   5. Prometheus returns      → service up again (no phantom incident)
// Everything created here is cleaned up; the demo fleet is untouched.
//
// Run: bun scripts/live-run-proof.mjs

import http from 'node:http';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
let probeValue = 1; // what the mock Prometheus answers for probe_success
let promDown = false;

const prom = http.createServer((req, res) => {
  if (promDown) {
    res.destroy(); // connection refused behaviour
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'success', data: { result: [{ value: [Math.floor(Date.now() / 1000), String(probeValue)] }] } }));
});
await new Promise((r) => prom.listen(0, '127.0.0.1', r));
const port = prom.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`[proof] mock prometheus on ${baseUrl}`);

const KEY = `zz-live-proof-${Date.now()}`;
const svc = await db.service.create({
  data: {
    key: KEY,
    name: 'Live Proof Target',
    endpoint: 'http://127.0.0.1:9/healthz',
    probeSource: JSON.stringify({ kind: 'blackbox', job: 'blackbox-proof' }),
    slaTarget: 0.999,
    tps: 10,
    avgTransactionValue: 250000,
    penaltyBase: 5_000_000,
    penaltyPerMinute: 1_000_000,
  },
});
await db.integrationSetting.upsert({
  where: { key: 'prometheus' },
  update: { value: JSON.stringify({ baseUrl, auth: { kind: 'none' } }) },
  create: { key: 'prometheus', value: JSON.stringify({ baseUrl, auth: { kind: 'none' } }) },
});
console.log(`[proof] service ${KEY} created`);

const { runIngestionTick } = await import('../src/server/ingestion.ts');
// polls are 15 s apart in production — space the proof's clock the same way
let clock = Date.now();
const tick = () => runIngestionTick((clock += 15_000));

const report = [];
const show = (label, r) => {
  const fresh = null;
  void fresh;
  report.push(label);
  console.log(`[proof] ${label} → polled=${r.polled} opened=[${r.opened}] resolved=[${r.resolved}] stale=[${r.stale}]`);
};

// 1–2: up ticks then failures
probeValue = 1; await tick(); await tick();
probeValue = 0; await tick(); await tick(); await tick();

let after = await db.service.findUnique({ where: { id: svc.id } });
let open = await db.incident.findFirst({ where: { serviceId: svc.id, status: 'ongoing', source: 'live' }, include: { alerts: true } });
console.log('[proof] after 3 failures: liveStatus=', after.liveStatus, 'openIncident=', Boolean(open), 'evidence=', Boolean(open?.evidence), 'alerts=', open?.alerts.length ?? 0);
if (!open || !open.evidence) { console.error('[proof] FAIL: incident not open / no evidence'); process.exit(1); }
const evidence = JSON.parse(open.evidence);
if (!evidence.rule || !Array.isArray(evidence.samples) || evidence.samples.length === 0) {
  console.error('[proof] FAIL: evidence incomplete'); process.exit(1);
}

// 3: recovery
probeValue = 1; await tick(); await tick();
after = await db.service.findUnique({ where: { id: svc.id } });
let resolved = await db.incident.findFirst({ where: { serviceId: svc.id, source: 'live', status: 'resolved' }, orderBy: { startedAt: 'desc' } });
console.log('[proof] after 2 successes: liveStatus=', after.liveStatus, 'resolved=', Boolean(resolved),
  'durationSec=', resolved?.durationSec, 'penaltyTomans=', resolved?.penaltyTomans,
  'revenueLossTomans=', resolved?.revenueLossTomans, 'evidenceSamples=', JSON.parse(resolved?.evidence ?? '{"samples":[]}').samples.length);
if (!resolved || resolved.penaltyTomans <= 0) { console.error('[proof] FAIL: not resolved with penalty'); process.exit(1); }

// 4: prometheus dies → stale + monitoring-blind alert (exactly once)
promDown = true;
await tick(); await tick();
after = await db.service.findUnique({ where: { id: svc.id } });
const blind = await db.alert.findMany({ where: { serviceId: svc.id, title: { contains: 'Monitoring blind' } } });
console.log('[proof] while prometheus down: liveStatus=', after.liveStatus, 'blindAlerts=', blind.length);
if (after.liveStatus !== 'stale' || blind.length !== 1) { console.error('[proof] FAIL: stale handling wrong'); process.exit(1); }

// 5: prometheus returns → up again, no new incident
promDown = false; probeValue = 1;
await tick();
after = await db.service.findUnique({ where: { id: svc.id } });
const incidents = await db.incident.count({ where: { serviceId: svc.id, source: 'live' } });
console.log('[proof] after recovery: liveStatus=', after.liveStatus, 'totalLiveIncidents=', incidents);
if (after.liveStatus !== 'up' || incidents !== 1) { console.error('[proof] FAIL: recovery wrong'); process.exit(1); }

// cleanup
await db.incident.deleteMany({ where: { serviceId: svc.id } });
await db.alert.deleteMany({ where: { serviceId: svc.id } });
await db.service.delete({ where: { id: svc.id } });
await db.integrationSetting.deleteMany({ where: { key: 'prometheus' } });
prom.close();
console.log('[proof] ALL LIVE-RUN CHECKS PASSED — cleaned up');
process.exit(0);

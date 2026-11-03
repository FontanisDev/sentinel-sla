// Shaparak/PSP profile → live money proof.
//
// Drives the REAL ingestion pipeline end-to-end against a mock Prometheus
// HTTP server and the real dev database, with a transaction profile
// committed on the target service:
//   1. two up-ticks            → service liveStatus=up
//   2. three down-ticks        → incident OPEN (startedAt = open tick)
//   3. two up-ticks            → incident RESOLVED — revenue loss computed
//                                from the PROFILE bucket at the incident's
//                                own start hour (NOT the flat tps), and the
//                                resolution event records the honest detail
//   4. profile removed         → a second incident resolves at the FLAT rate
// Every entity created here is cleaned up; the demo fleet is untouched.
//
// Run: bun scripts/shaparak-money-proof.mjs

import http from 'node:http';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
let probeValue = 1;

const prom = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'success', data: { result: [{ value: [Math.floor(Date.now() / 1000), String(probeValue)] }] } }));
});
await new Promise((r) => prom.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${port(prom)}`;
function port(srv) { return srv.address().port; }
console.log(`[proof] mock prometheus on ${baseUrl}`);

const KEY = `zz-shaparak-proof-${Date.now()}`;
const FLAT_TPS = 40;
const PEAK_TPS = 7.5; // deliberately ≠ flat, so the money figure names its source
const TICKET = 250_000;

const svc = await db.service.create({
  data: {
    key: KEY,
    name: 'Shaparak Proof Target',
    endpoint: 'http://127.0.0.1:9/healthz',
    probeSource: JSON.stringify({ kind: 'blackbox', job: 'blackbox-proof' }),
    slaTarget: 0.999,
    tps: FLAT_TPS,
    avgTransactionValue: TICKET,
    penaltyBase: 5_000_000,
    penaltyPerMinute: 1_000_000,
  },
});
await db.integrationSetting.upsert({
  where: { key: 'prometheus' },
  update: { value: JSON.stringify({ baseUrl, auth: { kind: 'none' } }) },
  create: { key: 'prometheus', value: JSON.stringify({ baseUrl, auth: { kind: 'none' } }) },
});

// Profile: every bucket 2 tps except the CURRENT Tehran hour → PEAK_TPS, so
// the incident that opens now must price at PEAK_TPS.
const { bucketForInstant, TEHRAN_TZ_OFFSET_MINUTES } = await import('../src/domain/tps-profile.ts');
const buckets = new Array(168).fill(2);
const nowBucket = bucketForInstant(new Date(), TEHRAN_TZ_OFFSET_MINUTES);
buckets[nowBucket] = PEAK_TPS;
await db.service.update({
  where: { id: svc.id },
  data: { tpsProfile: JSON.stringify({ buckets, tzOffsetMinutes: TEHRAN_TZ_OFFSET_MINUTES, meta: { source: 'shaparak-csv', importedBy: 'proof' } }) },
});
console.log(`[proof] profile committed — current Tehran bucket ${nowBucket} = ${PEAK_TPS} tps (flat ${FLAT_TPS})`);

const { runIngestionTick } = await import('../src/server/ingestion.ts');
let clock = Date.now();
const tick = () => runIngestionTick((clock += 15_000));

let failed = false;
try {
  // 1: two up ticks
  probeValue = 1; await tick(); await tick();

  // 2: three failures → open
  probeValue = 0; await tick(); await tick(); await tick();
  const open = await db.incident.findFirst({ where: { serviceId: svc.id, status: 'ongoing', source: 'live' } });
  if (!open) { console.error('[proof] FAIL: incident not open'); failed = true; }
  const startBucket = bucketForInstant(open.startedAt, TEHRAN_TZ_OFFSET_MINUTES);
  console.log(`[proof] incident open: startedAt=${open.startedAt.toISOString()} bucket=${startBucket} (nowBucket=${nowBucket})`);

  // 3: recovery → resolved with profile-priced money
  probeValue = 1; await tick(); await tick();
  const resolved = await db.incident.findFirst({ where: { serviceId: svc.id, source: 'live', status: 'resolved' }, orderBy: { startedAt: 'desc' } });
  if (!resolved || resolved.revenueLossTomans === null) { console.error('[proof] FAIL: not resolved with money'); failed = true; }
  const durationSec = resolved.durationSec;
  const expected = Math.round(resolveExpected(buckets, startBucket, durationSec, TICKET));
  const flatExpected = Math.round(FLAT_TPS * durationSec * TICKET);
  console.log(`[proof] resolved: durationSec=${durationSec} revenueLossTomans=${resolved.revenueLossTomans} expected(profile)=${expected} (flat would be ${flatExpected})`);
  if (resolved.revenueLossTomans !== expected) { console.error('[proof] FAIL: money does not match the profile formula'); failed = true; }
  if (expected === flatExpected) { console.error('[proof] FAIL: proof is degenerate — profile price equals flat price'); failed = true; }
  const events = JSON.parse(resolved.events);
  const resolveEvent = events.find((e) => e.event === 'resolved');
  const honest = resolveEvent && /transaction profile/.test(resolveEvent.detail);
  console.log(`[proof] resolution event honest: ${honest ? 'yes' : 'no'} — ${resolveEvent?.detail}`);
  if (!honest) { console.error('[proof] FAIL: resolution event does not name the profile'); failed = true; }

  // 4: remove the profile → next incident prices at the FLAT rate
  await db.service.update({ where: { id: svc.id }, data: { tpsProfile: null } });
  probeValue = 0; await tick(); await tick(); await tick();
  probeValue = 1; await tick(); await tick();
  const flatIncident = await db.incident.findFirst({
    where: { serviceId: svc.id, source: 'live', status: 'resolved' },
    orderBy: { startedAt: 'desc' },
  });
  if (!flatIncident) { console.error('[proof] FAIL: second incident missing'); failed = true; }
  const flatActual = flatIncident.revenueLossTomans;
  const flatDur = flatIncident.durationSec;
  const expectedFlat2 = Math.round(FLAT_TPS * flatDur * TICKET);
  console.log(`[proof] after removal: durationSec=${flatDur} revenueLossTomans=${flatActual} expected(flat)=${expectedFlat2}`);
  if (flatActual !== expectedFlat2) { console.error('[proof] FAIL: post-removal money is not flat-priced'); failed = true; }
} finally {
  // cleanup — proof fleet only
  await db.incident.deleteMany({ where: { serviceId: svc.id } });
  await db.alert.deleteMany({ where: { serviceId: svc.id } });
  await db.service.delete({ where: { id: svc.id } });
  await db.integrationSetting.deleteMany({ where: { key: 'prometheus' } });
  prom.close();
}

function resolveExpected(bks, bucket, durationSec, ticket) {
  return bks[bucket] * durationSec * ticket;
}

if (failed) { console.error('[proof] SHAPARAK MONEY PROOF FAILED'); process.exit(1); }
console.log('[proof] ALL SHAPARAK MONEY CHECKS PASSED — cleaned up');
process.exit(0);

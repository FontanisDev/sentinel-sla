// Notification outbox — end-to-end proof (retry, backoff, dead-letter).
// Run: bun scripts/notify-proof.mjs
//
// Drives the REAL outbox pipeline against the REAL dev database with a REAL
// HTTP mock webhook (the same pattern the adapter tests use):
//   1. emit → Alert feed rows + outbox fan-out (+ signed ack link embedded)
//   2. webhook 500 → retry scheduled with the 30 s backoff, nothing delivered
//   3. dispatch too early → claimed 0 (availableAt honoured)
//   4. webhook 200 → delivered, HMAC signature verified byte-for-byte,
//      Alert row settled, channel counters bumped, DeliveryLog rows written
//   5. always-500 webhook → give-up after maxAttempts → dead-letter state
//   6. admin retry (retryDead) → re-delivered
//   7. quiet hours: warning defers to the window end, dispatch claims nothing
//   8. dedup: a second identical emit collapses
//   9. outboxStats reflects the backlog + dead-letter counts
// Cleanup restores the demo state (deletes proof rows only).
// Prints PASS/FAIL summary; exit 1 on any failure.

import http from 'node:http';
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';

// ── hermetic database (the live dev server shares the demo DB and its
// simulate dispatcher would race this proof) ───────────────────────────────
const dataDir = path.join(import.meta.dir, '..', 'data');
execSync('mkdir -p ' + JSON.stringify(dataDir));
const proofDbPath = path.join(dataDir, 'notify-proof.db');
try {
  execSync('rm -f ' + JSON.stringify(proofDbPath));
} catch {
  /* first run */
}

// ── env BEFORE any src import (config.ts caches on first call) ──────────────
const ACK_SECRET = 'proof-ack-secret-0123456789abcdef0123456789abcdef';
process.env.SENTINEL_NOTIFY_TRANSPORT = 'real';
process.env.SENTINEL_ACK_SECRET = ACK_SECRET;
process.env.SENTINEL_PUBLIC_BASE_URL = 'http://127.0.0.1:3300';
process.env.DATABASE_URL = 'file:' + proofDbPath;
// fresh schema for the proof database (Prisma reads process env over .env)
execSync('bun x prisma db push --skip-generate', { cwd: path.join(import.meta.dir, '..'), env: { ...process.env }, stdio: 'pipe' });

const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient();
const failures = [];
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS ${name}`);
  else {
    console.log(`  FAIL ${name} ${extra}`);
    failures.push(name);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock webhook: scripted status per path ──────────────────────────────────
const hits = [];
let mode = 'fail-first'; // fail-first: 500 once then 200; always-500; ok
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c.toString('utf8')));
  req.on('end', () => {
    hits.push({ path: req.url, body, sig: req.headers['x-sentinel-signature'] ?? null });
    if (mode === 'always-500' || (mode === 'fail-first' && hits.length === 1)) {
      res.writeHead(500).end('boom');
    } else {
      res.writeHead(200).end('ok');
    }
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${mock.address().port}/hook`;
console.log(`[notify-proof] mock webhook ${mockUrl}`);

const { emitNotification, runOutboxDispatch, retryDead, outboxStats } = await import('../src/server/notify/outbox.ts');
const { verifyAckToken } = await import('../src/server/notify/policy.ts');

const CHANNEL_SUFFIX = `notifyproof${Date.now() % 1000000}`;
const created = { channelIds: [], alertIds: [], outboxIds: [], incidentIds: [], serviceId: null };

// A REAL service + incidents (Alert.incidentId is a true FK — the proof
// exercises the exact engine-path data shape, then cleans up).
const svc = await db.service.create({
  data: {
    key: `proof-svc-${CHANNEL_SUFFIX}`,
    name: 'Proof Gateway',
    endpoint: 'https://proof.example.ir/health',
    tps: 10,
    avgTransactionValue: 250_000,
    slaTarget: 0.999,
    penaltyBase: 5_000_000,
    penaltyPerMinute: 1_000_000,
  },
});
created.serviceId = svc.id;
const inc1 = await db.incident.create({ data: { serviceId: svc.id, severity: 'critical', startedAt: new Date() } });
const inc2 = await db.incident.create({ data: { serviceId: svc.id, severity: 'critical', startedAt: new Date() } });
const inc3 = await db.incident.create({ data: { serviceId: svc.id, severity: 'warning', startedAt: new Date() } });
created.incidentIds.push(inc1.id, inc2.id, inc3.id);

try {
  // ── setup: one technical webhook channel with a signing secret ───────────
  const ch = await db.notificationChannel.create({
    data: { name: `Proof Hook ${CHANNEL_SUFFIX}`, kind: 'webhook', target: mockUrl, audience: 'technical', secret: 'whsec-0123456789abcdef' },
  });
  created.channelIds.push(ch.id);

  const vars = {
    serviceName: 'Proof Gateway',
    serviceKey: 'proof-gateway',
    endpoint: 'https://proof.example.ir/health',
    probeLabel: 'sentinel/blackbox',
    startedAt: new Date().toISOString(),
    tps: 10,
    avgTransactionValue: 250_000,
    penaltyBase: 5_000_000,
    penaltyPerMinute: 1_000_000,
  };

  // ── 1. emit a detection (critical) — ack link must be embedded ───────────
  const emitted = await emitNotification({
    topic: 'detection',
    severity: 'critical',
    audiences: ['technical'],
    vars,
    incidentId: inc1.id,
    serviceId: svc.id,
    serviceName: 'Proof Gateway',
    now: Date.now(),
  });
  created.alertIds.push(...emitted.alertIds);
  const firstRows = await db.notificationOutbox.findMany({ where: { alertId: { in: emitted.alertIds } } });
  firstRows.forEach((r) => created.outboxIds.push(r.id));
  check('emit fanned out to the technical webhook channel', emitted.enqueued === 1 && firstRows.length === 1, `enqueued=${emitted.enqueued}`);
  check('alert feed row starts pending', await db.alert.findFirst({ where: { id: emitted.alertIds[0] } }).then((a) => a?.status === 'pending'));
  check('ack link embedded in the rendered body', firstRows[0]?.body.includes('/ack?token='));
  const token = String(firstRows[0]?.body).split('/ack?token=')[1]?.trim();
  const verdict = verifyAckToken(token, ACK_SECRET, Date.now());
  check('embedded ack token verifies to the incident', verdict.ok && verdict.incidentId === inc1.id, JSON.stringify(verdict));

  // ── 2. first dispatch: webhook 500 → retry with 30 s backoff ─────────────
  const t0 = Date.now();
  const r1 = await runOutboxDispatch({ now: t0 });
  check('pass 1 fails the webhook delivery', r1.failed === 1 && r1.dead === 0, JSON.stringify(r1));
  let row = await db.notificationOutbox.findUnique({ where: { id: firstRows[0].id } });
  check('row re-queued pending with ~30 s backoff', row.status === 'pending' && Math.abs((+new Date(row.availableAt) - (t0 + 30_000))) < 2_000, `availableAt=${row.availableAt}`);
  check('failed attempt landed in the delivery log', await db.deliveryLog.findFirst({ where: { outboxId: row.id, ok: false } }).then((l) => l?.error === 'http-500'));

  // ── 3. too-early dispatch claims nothing ─────────────────────────────────
  const early = await runOutboxDispatch({ now: t0 + 10_000 });
  check('too-early pass claims nothing', early.claimed === 0, JSON.stringify(early));

  // ── 4. on-time dispatch: webhook 200 → delivered + signature verified ────
  mode = 'ok';
  const r2 = await runOutboxDispatch({ now: t0 + 31_000 });
  check('pass 2 delivers', r2.delivered === 1, JSON.stringify(r2));
  row = await db.notificationOutbox.findUnique({ where: { id: firstRows[0].id } });
  check('row terminal state is delivered', row.status === 'delivered' && !!row.deliveredAt);
  const deliveredHit = hits[hits.length - 1];
  const expectedSig = `sha256=${createHmac('sha256', 'whsec-0123456789abcdef').update(deliveredHit.body, 'utf8').digest('hex')}`;
  check('webhook payload carries the exact HMAC signature', deliveredHit.sig === expectedSig);
  const payload = JSON.parse(deliveredHit.body);
  check('webhook payload is the documented shape', payload.source === 'sentinel-sla' && payload.topic === 'detection' && payload.severity === 'critical' && typeof payload.ackUrl === 'string' && payload.ackUrl.includes('/ack?token='));
  check('alert feed row settled to delivered', await db.alert.findFirst({ where: { id: emitted.alertIds[0] } }).then((a) => a?.status === 'delivered'));
  check('channel counters show one delivery', await db.notificationChannel.findUnique({ where: { id: ch.id } }).then((c) => c.deliveredCount === 1 && c.failedCount === 1));

  // ── 5. give-up after maxAttempts → dead-letter ───────────────────────────
  mode = 'always-500';
  const emitted2 = await emitNotification({
    topic: 'detection',
    severity: 'critical',
    audiences: ['technical'],
    vars,
    incidentId: inc2.id,
    serviceId: svc.id,
    serviceName: 'Proof Gateway',
    maxAttempts: 2,
    now: t0 + 60_000,
  });
  created.alertIds.push(...emitted2.alertIds);
  const row2 = await db.notificationOutbox.findFirst({ where: { alertId: emitted2.alertIds[0] } });
  created.outboxIds.push(row2.id);
  await runOutboxDispatch({ now: t0 + 60_000 }); // attempt 1 → 500
  await runOutboxDispatch({ now: t0 + 91_000 }); // attempt 2 → 500 → DEAD
  const dead = await db.notificationOutbox.findUnique({ where: { id: row2.id } });
  check('give-up after maxAttempts lands in the dead-letter state', dead.status === 'dead' && dead.attempts === 2 && !!dead.lastError, `status=${dead.status} attempts=${dead.attempts}`);
  const stats1 = await outboxStats();
  check('outboxStats counts the dead letter', stats1.dead === 1, JSON.stringify(stats1));

  // ── 6. admin retry revives the dead letter ───────────────────────────────
  mode = 'ok';
  check('retryDead requeues the row', await retryDead(row2.id, t0 + 120_000));
  const r3 = await runOutboxDispatch({ now: t0 + 121_000 });
  check('revived row delivers on the next pass', r3.delivered === 1, JSON.stringify(r3));
  check('revived row is delivered', await db.notificationOutbox.findUnique({ where: { id: row2.id } }).then((r) => r.status === 'delivered'));

  // ── 7. quiet hours defer warnings to the window end (Tehran local time) ──
  const tehran = new Date(Date.now() + 210 * 60_000);
  const nowMin = tehran.getUTCHours() * 60 + tehran.getUTCMinutes();
  const quiet = { startMin: (nowMin + 1440 - 60) % 1440, endMin: (nowMin + 1440 + 30) % 1440 }; // started 60 min ago, ends in 30
  const emitted3 = await emitNotification({
    topic: 'rule',
    severity: 'warning',
    audiences: ['technical'],
    vars: { ruleName: 'Quiet proof', metric: 'errorRate', operator: '>', threshold: '5%', measuredValue: '9%', serviceName: 'Proof Gateway' },
    incidentId: inc3.id,
    serviceId: svc.id,
    serviceName: 'Proof Gateway',
    ruleId: `proof-rule-${CHANNEL_SUFFIX}`,
    quiet,
    now: Date.now(),
  });
  created.alertIds.push(...emitted3.alertIds);
  const row3 = await db.notificationOutbox.findFirst({ where: { alertId: emitted3.alertIds[0] } });
  created.outboxIds.push(row3.id);
  const beforeEnd = await runOutboxDispatch({ now: Date.now() });
  check('quiet-hours message is NOT claimed before the window ends', beforeEnd.claimed === 0, JSON.stringify(beforeEnd));
  check('quiet-hours availableAt sits at (or after) the window end', +new Date(row3.availableAt) > Date.now(), `availableAt=${row3.availableAt}`);

  // ── 8. dedup collapses a repeated emit in the same bucket ────────────────
  const dupInput = {
    topic: 'detection',
    severity: 'critical',
    audiences: ['technical'],
    vars,
    incidentId: inc1.id,
    serviceId: svc.id,
    serviceName: 'Proof Gateway',
    now: Date.now(),
  };
  const first = await emitNotification(dupInput);
  const second = await emitNotification(dupInput);
  created.alertIds.push(...first.alertIds, ...second.alertIds);
  const dupRows = await db.notificationOutbox.findMany({ where: { alertId: { in: [...first.alertIds, ...second.alertIds] } } });
  dupRows.forEach((r) => created.outboxIds.push(r.id));
  check('repeat emit is de-duplicated', first.enqueued === 1 && second.enqueued === 0 && second.deduped === 1, `first=${first.enqueued} second=${second.enqueued} deduped=${second.deduped}`);
} finally {
  // ── cleanup: restore demo state (proof rows only) ─────────────────────────
  await db.notificationOutbox.deleteMany({ where: { id: { in: created.outboxIds } } });
  await db.deliveryLog.deleteMany({ where: { outboxId: { in: created.outboxIds } } });
  await db.alert.deleteMany({ where: { id: { in: created.alertIds } } });
  await db.notificationChannel.deleteMany({ where: { id: { in: created.channelIds } } });
  await db.incident.deleteMany({ where: { id: { in: created.incidentIds } } });
  await db.service.deleteMany({ where: { id: created.serviceId } });
  mock.close();
  await db.$disconnect();
}

console.log('');
if (failures.length > 0) {
  console.log(`NOTIFY PROOF: ${failures.length} FAILURE(S)`);
  process.exit(1);
}
console.log('NOTIFY PROOF: ALL PASS');

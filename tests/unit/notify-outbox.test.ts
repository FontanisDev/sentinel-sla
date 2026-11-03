// Outbox dispatcher — behaviour tests over an in-memory store.
//
// The stub db implements EXACTLY the raw-SQL surface outbox.ts uses (routed by
// SQL shape), so the real SQL strings are what get exercised. Covers: retry on failure with backoff, give-up after N tries, dead-letter
// state, group merging, de-dup, channel counters, and the Alert feed row
// settlement (pending → delivered | failed).

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
  channels: [] as Array<Row & { id: string; kind: string; target: string; audience: string; enabled: number; secret: string | null; deliveredCount: number; failedCount: number; lastError: string | null }>,
  outbox: [] as Array<Row & { id: string; status: string; attempts: number; maxAttempts: number; groupKey: string | null; dedupKey: string | null; alertId: string | null; channelId: string | null; availableAt: Date; createdAt: Date; lastError: string | null }>,
  logs: [] as Array<Row & { outboxId: string; ok: boolean; error: string | null }>,
  alerts: [] as Array<Row & { id: string; status: string; audience: string }>,
  seq: 0,
}));

function id(prefix: string): string {
  store.seq += 1;
  return `${prefix}-${store.seq}`;
}

/** Rebuild the tagged-template SQL with ? placeholders. */
function text(strings: TemplateStringsArray): string {
  return strings.join(' ? ');
}

function makeDb(): any {
  const TERMINAL = ['delivered', 'dead'];
  const openish = (r: Row): boolean => !TERMINAL.includes(String(r.status));

  return {
    // ── prisma model API surface used by outbox.ts ──
    notificationOutbox: {
      create: async ({ data }: { data: Row }) => {
        const row = {
          id: id('ob'),
          status: 'pending',
          attempts: 0,
          maxAttempts: 5,
          groupKey: null,
          dedupKey: null,
          alertId: null,
          channelId: null,
          availableAt: new Date(),
          createdAt: new Date(),
          lastError: null,
          ...data,
        };
        store.outbox.push(row);
        return row;
      },
    },
    alert: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: id('al'), audience: 'technical', status: 'pending', ...data };
        store.alerts.push(row);
        return row;
      },
    },
    deliveryLog: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: id('dl'), outboxId: '', ok: true, error: null, at: new Date(), ...data };
        store.logs.push(row);
        return row;
      },
    },
    integrationSetting: {
      findUnique: async () => null,
    },

    // ── raw SQL surface (routed by shape) ──
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> => {
      const q = text(strings);
      if (q.includes('FROM NotificationChannel') && q.includes('enabled = TRUE')) {
        const audience = String(values[0]);
        return store.channels.filter((c) => c.enabled === 1 && (c.audience === audience || c.audience === 'both'));
      }
      if (q.includes('WHERE dedupKey')) {
        const key = String(values[0]);
        const hit = store.outbox.find((r) => r.dedupKey === key && openish(r));
        return hit ? [{ id: hit.id }] : [];
      }
      if (q.includes("status = 'pending'") && q.includes('availableAt <=') && q.includes('SELECT id FROM NotificationOutbox')) {
        const nowMs = Number(values[0]); // production binds epoch-ms (INTEGER column)
        const limit = Number(values[1] ?? 25);
        const sevRank = (r: Row): number => (r.severity === 'critical' ? 0 : r.severity === 'warning' ? 1 : 2);
        return store.outbox
          .filter((r) => r.status === 'pending' && +new Date(r.availableAt) <= nowMs)
          .sort((a, b) => sevRank(a) - sevRank(b) || +new Date(a.createdAt) - +new Date(b.createdAt))
          .slice(0, limit)
          .map((r) => ({ id: r.id }));
      }
      if (q.includes('FROM NotificationOutbox WHERE id =')) {
        const row = store.outbox.find((r) => r.id === String(values[0]));
        return row ? [row as Row] : [];
      }
      if (q.includes('FROM NotificationChannel WHERE id =')) {
        const row = store.channels.find((c) => c.id === String(values[0]));
        return row ? [{ secret: row.secret }] : [];
      }
      if (q.includes('FROM NotificationOutbox WHERE alertId')) {
        const rows = store.outbox.filter((r) => r.alertId === String(values[0]));
        return [
          {
            open: rows.filter(openish).length,
            dead: rows.filter((r) => r.status === 'dead').length,
            total: rows.length,
          },
        ];
      }
      if (q.includes('FROM NotificationOutbox') && q.includes('SUM(')) {
        // outboxStats: SELECT SUM(pending+delivering) AS depth, SUM(dead) AS dead
        return [
          {
            depth: store.outbox.filter(openish).length,
            dead: store.outbox.filter((r) => r.status === 'dead').length,
          },
        ];
      }
      // prune + anything unanticipated: empty result
      return [];
    },

    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      const q = text(strings);
      if (q.includes("SET status = 'delivering'")) {
        const row = store.outbox.find((r) => r.id === String(values[1]) && r.status === 'pending');
        if (!row) return 0;
        row.status = 'delivering';
        row.attempts = Number(row.attempts) + 1;
        return 1;
      }
      if (q.includes("SET status = 'delivered'")) {
        const row = store.outbox.find((r) => r.id === String(values[1]));
        if (!row) return 0;
        row.status = 'delivered';
        row.lastError = null;
        return 1;
      }
      if (q.includes("SET status = 'dead'")) {
        const row = store.outbox.find((r) => r.id === String(values[1]));
        if (!row) return 0;
        row.status = 'dead';
        row.lastError = String(values[0] ?? 'failed');
        return 1;
      }
      if (q.includes("SET status = 'pending', availableAt")) {
        const row = store.outbox.find((r) => r.id === String(values[2]));
        if (!row) return 0;
        row.status = 'pending';
        // production writes epoch-ms numbers into the INTEGER datetime column
        row.availableAt = new Date(Number(values[0]));
        row.lastError = String(values[1] ?? 'failed');
        return 1;
      }
      if (q.includes('SET deliveredCount')) {
        const ch = store.channels.find((c) => c.id === String(values[1]));
        if (!ch) return 0;
        ch.deliveredCount += 1;
        ch.lastError = null;
        return 1;
      }
      if (q.includes('SET failedCount')) {
        const ch = store.channels.find((c) => c.id === String(values[1]));
        if (!ch) return 0;
        ch.failedCount += 1;
        ch.lastError = String(values[0] ?? 'failed');
        return 1;
      }
      if (q.includes('UPDATE Alert SET status')) {
        const a = store.alerts.find((x) => x.id === String(values[1]));
        if (!a) return 0;
        a.status = String(values[0]);
        return 1;
      }
      if (q.startsWith('DELETE FROM')) return 0;
      return 0;
    },
  };
}

vi.mock('@/lib/db', () => ({ db: makeDb() }));

const configState = vi.hoisted(() => ({ mode: 'demo', notifyTransport: 'simulate' }));
vi.mock('@/server/config', () => ({
  getConfig: () => ({
    mode: configState.mode,
    notifyTransport: configState.notifyTransport,
    port: 3000,
    role: 'all',
    dataDir: '.',
    reportsDir: '.',
    fontDir: null,
    reportPython: null,
    reportScript: '',
    pollIntervalSec: 15,
    liveFailureThreshold: 3,
    liveSuccessThreshold: 2,
    webhookBearer: null,
  }),
}));

vi.mock('@/server/locks', () => ({
  tryAcquireSchedulerLock: async () => true,
  releaseSchedulerLock: async () => undefined,
  withSchedulerLock: async <T,>(fn: () => Promise<T>) => fn(),
}));

import {
  emitNotification,
  outboxStats,
  runOutboxDispatch,
  sendTestMessage,
} from '@/server/notify/outbox';
import type { OutgoingMessage } from '@/server/notify/adapters';
import { createServer, type Server } from 'node:http';

const NOW = 1_800_000_000_000;

function resetStore(): void {
  store.channels = [];
  store.outbox = [];
  store.logs = [];
  store.alerts = [];
  store.seq = 0;
}

beforeEach(() => {
  resetStore();
  configState.mode = 'demo';
  configState.notifyTransport = 'simulate';
  delete process.env.SENTINEL_ACK_SECRET;
  delete process.env.SENTINEL_TELEGRAM_BOT_TOKEN;
  delete process.env.SENTINEL_BALE_BOT_TOKEN;
});

function techChannel(kind: string, target: string, secret: string | null = null): string {
  const c = {
    id: id('ch'),
    kind,
    target,
    audience: 'technical',
    enabled: 1,
    secret,
    deliveredCount: 0,
    failedCount: 0,
    lastError: null,
  };
  store.channels.push(c);
  return c.id;
}

// ── emitNotification (fan-out + dedup + feed rows) ───────────────────────────

describe('emitNotification fan-out', () => {
  it('creates one Alert row per audience and one outbox row per matching channel', async () => {
    techChannel('telegram', '@room');
    techChannel('webhook', 'https://hooks.test/exec', 'whsec');
    // an executive-only channel must NOT receive technical traffic
    store.channels.push({ id: id('ch'), kind: 'webhook', target: 'https://x', audience: 'executive', enabled: 1, secret: null, deliveredCount: 0, failedCount: 0, lastError: null });

    const res = await emitNotification({
      topic: 'detection',
      severity: 'critical',
      audiences: ['technical', 'executive'],
      vars: { serviceName: 'S', startedAt: new Date(NOW).toISOString(), tps: 1, avgTransactionValue: 1 },
      incidentId: 'i1',
      serviceId: 's1',
      serviceName: 'S',
      now: NOW,
    });

    expect(res.alertIds).toHaveLength(2); // technical + executive feed rows
    expect(res.enqueued).toBe(3); // 2 tech + 1 exec channel
    expect(res.deduped).toBe(0);
    expect(store.outbox.every((r) => r.status === 'pending')).toBe(true);
    // technical alerts reference the technical channel rows; webhook secret
    // stays only on the channel, never on the outbox row
    expect(store.outbox.some((r) => r.target === 'https://hooks.test/exec' && r.audience === 'technical')).toBe(true);
  });

  it('no matching channels → the dashboard IS the delivery (feed row delivered)', async () => {
    const res = await emitNotification({
      topic: 'recovery',
      severity: 'info',
      audiences: ['technical'],
      vars: { serviceName: 'S' },
      now: NOW,
    });
    expect(res.enqueued).toBe(0);
    expect(store.alerts[0].status).toBe('delivered');
  });

  it('de-duplicates repeat emissions within the time bucket', async () => {
    techChannel('telegram', '@room');
    const input = {
      topic: 'detection' as const,
      severity: 'critical' as const,
      audiences: ['technical' as const],
      vars: { serviceName: 'S', startedAt: new Date(NOW).toISOString() },
      incidentId: 'i1',
      serviceId: 's1',
      serviceName: 'S',
      now: NOW,
    };
    const first = await emitNotification(input);
    const second = await emitNotification(input);
    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(0);
    expect(second.deduped).toBe(1);
  });

  it('test sends skip dedup (a second test must still go out)', async () => {
    const ch = techChannel('telegram', '@room');
    const a = await sendTestMessage(ch);
    const b = await sendTestMessage(ch);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const testRows = store.outbox.filter((r) => r.topic === 'test');
    expect(testRows.length).toBeGreaterThanOrEqual(2);
  });
});

// ── dispatcher: simulate transport (demo default) ────────────────────────────

describe('dispatcher — simulate transport', () => {
  it('delivers, bumps channel counters and settles the Alert row', async () => {
    const ch = techChannel('telegram', '@room');
    const { alertIds } = await emitNotification({
      topic: 'detection',
      severity: 'critical',
      audiences: ['technical'],
      vars: { serviceName: 'S', startedAt: new Date(NOW).toISOString() },
      incidentId: 'i1',
      serviceId: 's1',
      serviceName: 'S',
      now: NOW,
    });
    expect(store.alerts.find((a) => a.id === alertIds[0])?.status).toBe('pending');

    const report = await runOutboxDispatch({ now: NOW + 1000 });
    expect(report.claimed).toBe(1);
    expect(report.delivered).toBe(1);
    expect(report.failed).toBe(0);
    expect(store.outbox[0].status).toBe('delivered');
    expect(store.channels.find((c) => c.id === ch)?.deliveredCount).toBe(1);
    expect(store.alerts.find((a) => a.id === alertIds[0])?.status).toBe('delivered');
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0].ok).toBe(true);
  });

  it('reports the backlog as pending+delivering, dead separately', async () => {
    techChannel('telegram', '@room');
    await emitNotification({
      topic: 'detection',
      severity: 'critical',
      audiences: ['technical'],
      vars: { serviceName: 'S' },
      incidentId: 'i1',
      serviceId: 's1',
      serviceName: 'S',
      now: NOW,
    });
    const before = await outboxStats();
    expect(before.depth).toBe(1);
    expect(before.dead).toBe(0);
    await runOutboxDispatch({ now: NOW + 1000 });
    const after = await outboxStats();
    expect(after.depth).toBe(0);
    expect(after.dead).toBe(0);
  });
});

// ── dispatcher: REAL webhook transport — retry, give-up, dead-letter ────────

function webhookServer(status: () => number): Promise<{ server: Server; url: string; count: () => number }> {
  let n = 0;
  const server = createServer((_req, res) => {
    n += 1;
    res.statusCode = status();
    res.end('x');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/hook`, count: () => n });
    });
  });
}

describe('dispatcher — real transport retry policy ', () => {
  it('retries a failing webhook with backoff, gives up after maxAttempts, dead-letters', async () => {
    const { server, url, count } = await webhookServer(() => 500);
    configState.notifyTransport = 'real';
    techChannel('webhook', url, 'whsec-0123456789abcdef');
    await emitNotification({
      topic: 'detection',
      severity: 'critical',
      audiences: ['technical'],
      vars: { serviceName: 'S', startedAt: new Date(NOW).toISOString() },
      incidentId: 'i2',
      serviceId: 's2',
      serviceName: 'S',
      maxAttempts: 3,
      now: NOW,
    });

    // pass 1 at NOW → attempt 1 fails → retry at +30s
    const r1 = await runOutboxDispatch({ now: NOW });
    expect(r1.failed).toBe(1);
    expect(store.outbox[0].status).toBe('pending');
    expect(+new Date(store.outbox[0].availableAt)).toBe(NOW + 30_000);
    // too early: nothing due
    const early = await runOutboxDispatch({ now: NOW + 10_000 });
    expect(early.claimed).toBe(0);
    // pass 2 at +31s → attempt 2 fails → retry at +1m
    await runOutboxDispatch({ now: NOW + 31_000 });
    expect(store.outbox[0].attempts).toBe(2);
    // pass 3 at +92s (past +1m backoff) → attempt 3 === maxAttempts → DEAD
    const r3 = await runOutboxDispatch({ now: NOW + 92_000 });
    expect(r3.dead).toBe(1);
    expect(store.outbox[0].status).toBe('dead');
    expect(count()).toBe(3); // exactly three real HTTP attempts
    // three failed delivery-log rows, none ok
    expect(store.logs).toHaveLength(3);
    expect(store.logs.every((l) => !l.ok)).toBe(true);
    // all rows for the alert are dead → feed row failed
    expect(store.alerts[0].status).toBe('failed');
    // channel health counters show the pain
    expect(store.channels[0].failedCount).toBe(3);
    server.close();
  });

  it('recovers when the webhook comes back: 500 → 200 → delivered', async () => {
    let flip = false;
    const { server, url } = await webhookServer(() => (flip = !flip, flip ? 500 : 200));
    configState.notifyTransport = 'real';
    techChannel('webhook', url);
    await emitNotification({
      topic: 'detection',
      severity: 'warning',
      audiences: ['technical'],
      vars: { serviceName: 'S', startedAt: new Date(NOW).toISOString() },
      incidentId: 'i3',
      serviceId: 's3',
      serviceName: 'S',
      maxAttempts: 5,
      now: NOW,
    });
    await runOutboxDispatch({ now: NOW }); // 500
    await runOutboxDispatch({ now: NOW + 31_000 }); // 200
    expect(store.outbox[0].status).toBe('delivered');
    expect(store.alerts[0].status).toBe('delivered');
    expect(store.channels[0].deliveredCount).toBe(1);
    server.close();
  });

  it('groups same-channel same-service messages into ONE real send', async () => {
    const { server, url, count } = await webhookServer(() => 200);
    configState.notifyTransport = 'real';
    techChannel('webhook', url);
    await emitNotification({
      topic: 'detection',
      severity: 'critical',
      audiences: ['technical'],
      vars: { serviceName: 'Svc', startedAt: new Date(NOW).toISOString() },
      incidentId: 'i4',
      serviceId: 's4',
      serviceName: 'Svc',
      now: NOW,
    });
    await emitNotification({
      topic: 'recovery',
      severity: 'info',
      audiences: ['technical'],
      vars: { serviceName: 'Svc' },
      incidentId: 'i4',
      serviceId: 's4',
      serviceName: 'Svc',
      now: NOW + 1000,
    });
    expect(store.outbox).toHaveLength(2);
    const report = await runOutboxDispatch({ now: NOW + 2000 });
    expect(report.grouped).toBe(1);
    expect(count()).toBe(1); // ONE HTTP call for both messages
    expect(store.outbox.every((r) => r.status === 'delivered')).toBe(true);
    server.close();
  });
});

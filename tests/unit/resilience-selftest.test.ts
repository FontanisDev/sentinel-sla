// Resilience — unit tests.
//
// Covers: the self-test gate math and weekly due/next instants (pure), the
// bilingual self-test failure templates, the chaos-hook dispatcher (against a
// local mock HTTP server, HMAC-verified), launchLiveChaos refusals (synthetic
// target / missing opt-in hook), the live-path busy guard, and the weekly
// scheduler's catch-up-once behaviour over a stub db.

import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateGate, selfTestDueInstant, selfTestNextInstant, SELFTEST_DEFAULTS } from '@/server/resilience/selftest';
import { renderNotification } from '@/server/notify/templates';
import { dispatchChaosHook, launchLiveChaos } from '@/server/resilience/chaoshook';
import { HttpError } from '@/server/http';

// ── pure math: gate ──────────────────────────────────────────────────────────

describe('self-test gate math (pure)', () => {
  it('passes strictly below the gate', () => {
    expect(evaluateGate(59.9)).toBe(true);
    expect(evaluateGate(0)).toBe(true);
  });

  it('fails at and above the gate (60s is NOT < 60s)', () => {
    expect(evaluateGate(60)).toBe(false);
    expect(evaluateGate(120.5)).toBe(false);
  });

  it('undetectable runs have no verdict', () => {
    expect(evaluateGate(null)).toBeNull();
    expect(evaluateGate(undefined)).toBeNull();
    expect(evaluateGate(Number.NaN)).toBeNull();
  });

  it('honours a custom gate', () => {
    expect(evaluateGate(45, 30)).toBe(false);
    expect(evaluateGate(29, 30)).toBe(true);
  });
});

// ── pure math: weekly due/next instants ──────────────────────────────────────

describe('self-test weekly schedule math (pure)', () => {
  const cfg = SELFTEST_DEFAULTS; // enabled, Friday (5) 03:00 UTC

  it('disabled config never fires', () => {
    const now = new Date(Date.UTC(2026, 9, 8, 12, 0, 0)); // Thursday
    expect(selfTestDueInstant({ ...cfg, enabled: false }, now)).toBeNull();
    expect(selfTestNextInstant({ ...cfg, enabled: false }, now)).toBeNull();
  });

  it('malformed hour/day never fire', () => {
    const now = new Date(Date.UTC(2026, 9, 8, 12, 0, 0));
    expect(selfTestDueInstant({ ...cfg, hour: 24 }, now)).toBeNull();
    expect(selfTestDueInstant({ ...cfg, hour: -1 }, now)).toBeNull();
    expect(selfTestDueInstant({ ...cfg, dayOfWeek: 7 }, now)).toBeNull();
    expect(selfTestNextInstant({ ...cfg, dayOfWeek: 7 }, now)).toBeNull();
  });

  it('catch-up: finds the most recent past Friday 03:00', () => {
    // 2026-10-08 is a Thursday; the most recent Friday 03:00 UTC is Oct 2.
    const now = new Date(Date.UTC(2026, 9, 8, 12, 0, 0));
    expect(selfTestDueInstant(cfg, now)).toEqual(new Date(Date.UTC(2026, 9, 2, 3, 0, 0)));
  });

  it('fires at the exact due instant (boundary inclusive)', () => {
    const now = new Date(Date.UTC(2026, 9, 2, 3, 0, 0)); // exactly Friday 03:00
    expect(selfTestDueInstant(cfg, now)).toEqual(now);
  });

  it('next instant is the following Friday 03:00', () => {
    const now = new Date(Date.UTC(2026, 9, 2, 3, 0, 1));
    expect(selfTestNextInstant(cfg, now)).toEqual(new Date(Date.UTC(2026, 9, 9, 3, 0, 0)));
  });

  it('next instant skips forward a full week past this week\u2019s slot', () => {
    const now = new Date(Date.UTC(2026, 9, 2, 10, 0, 0)); // Friday after 03:00
    expect(selfTestNextInstant(cfg, now)).toEqual(new Date(Date.UTC(2026, 9, 9, 3, 0, 0)));
  });
});

// ── bilingual failure templates ──────────────────────────────────────────────

describe('selftest notification templates', () => {
  const vars = {
    runId: 'run-123',
    mttdSec: null,
    mttrSec: null,
    gateSec: 60,
    selfTestError: 'detection-timeout',
    sentAt: new Date(Date.UTC(2026, 9, 8, 9, 0, 0)).toISOString(),
  };

  it('EN technical page names the gate, the stage and the run id', () => {
    const { title, body } = renderNotification('selftest', 'critical', 'technical', vars);
    expect(title).toContain('[SELF-TEST FAILED]');
    expect(title).toContain('60');
    expect(body).toContain('never detected');
    expect(body).toContain('detection-timeout');
    expect(body).toContain('run-123');
  });

  it('EN includes a real MTTD when the gate was missed but detection happened', () => {
    const { body } = renderNotification('selftest', 'critical', 'technical', { ...vars, mttdSec: 74.2 });
    expect(body).toContain('1m 14s'); // fmtDur(74.2) — human duration, not raw seconds
    expect(body).not.toContain('never detected');
  });

  it('FA executive page is formal Persian naming the 60s ceiling', () => {
    const { title, body } = renderNotification('selftest', 'critical', 'executive', vars);
    expect(title).toContain('شکست خودسنجی');
    expect(body).toContain('۶۰');
    expect(body).toContain('هدف آزمایشی');
    expect(body).toContain('run-123');
  });
});

// ── chaos hook dispatcher (real HTTP against a local mock) ───────────────────

describe('chaos hook dispatcher (mock HTTP)', () => {
  let server: Server | null = null;
  let url = '';
  let last: { method: string; headers: Record<string, unknown>; body: string } | null = null;

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
  });

  const listen = (status = 200): Promise<string> =>
    new Promise((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          last = { method: req.method ?? '', headers: req.headers, body };
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(status === 200 ? '{"ok":true}' : '{"error":"nope"}');
        });
      });
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}/hook`));
    });

  const payload = {
    experimentId: 'exp-1',
    serviceKey: 'payment-gateway',
    serviceName: 'Payment Gateway',
    type: 'outage',
    durationSec: 0,
    startedAt: new Date(Date.UTC(2026, 9, 8, 9, 0, 0)).toISOString(),
  };

  it('POSTs the envelope and signs it when a secret is configured', async () => {
    url = await listen(200);
    const secret = 'topsecret-hook-key';
    const r = await dispatchChaosHook(url, secret, payload);
    expect(r.ok).toBe(true);
    expect(r.statusCode).toBe(200);
    expect(last!.method).toBe('POST');
    expect(JSON.parse(last!.body)).toMatchObject({ experimentId: 'exp-1', serviceKey: 'payment-gateway' });
    const expected = 'sha256=' + createHmac('sha256', secret).update(last!.body, 'utf8').digest('hex');
    expect(last!.headers['x-sentinel-chaos-signature']).toBe(expected);
  });

  it('omits the signature header when no secret is configured', async () => {
    url = await listen(200);
    const r = await dispatchChaosHook(url, null, payload);
    expect(r.ok).toBe(true);
    expect(last!.headers['x-sentinel-chaos-signature']).toBeUndefined();
  });

  it('reports a hook-side HTTP failure honestly', async () => {
    url = await listen(500);
    const r = await dispatchChaosHook(url, null, payload);
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(500);
    expect(r.error).toContain('500');
  });

  it('reports an unreachable hook without throwing', async () => {
    const r = await dispatchChaosHook('http://127.0.0.1:9/hook', null, payload); // discard port
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBeNull();
    expect(r.error).toBeTruthy();
  });
});

// ── launchLiveChaos refusals + dispatch (stub db) ────────────────────────────

vi.mock('@/lib/db', () => ({ db: makeDb() }));
vi.mock('@/server/locks', () => ({
  tryAcquireSchedulerLock: async () => true,
  releaseSchedulerLock: async () => undefined,
  withSchedulerLock: async <T,>(_name: string, fn: () => Promise<T>) => fn(),
}));
const engineState = vi.hoisted(() => ({ mode: 'demo' as 'demo' | 'live', launchChaos: vi.fn() }));
vi.mock('@/server/config', () => ({
  getConfig: () => ({ mode: engineState.mode, role: 'all', pollIntervalSec: 15, liveFailureThreshold: 3, liveSuccessThreshold: 2 }),
}));
vi.mock('@/server/notify/outbox', () => ({
  emitNotification: vi.fn(async () => ({ alertIds: [], enqueued: 0 })),
  startOutboxDispatcher: () => undefined,
  stopOutboxDispatcher: () => undefined,
  outboxStats: vi.fn(async () => ({ depth: 0, dead: 0 })),
}));
vi.mock('@/server/engine', () => ({ getEngine: () => ({ launchChaos: engineState.launchChaos }) }));

interface Row {
  id: string;
  [k: string]: unknown;
}

function makeDb() {
  const settings = new Map<string, string>();
  const runs: Row[] = [];
  const incidents: Row[] = [];
  const experiments: Row[] = [];
  const services: Row[] = [];
  let seq = 0;
  const nextId = () => `id-${++seq}`;
  return {
    settings,
    runs,
    incidents,
    experiments,
    services,
    integrationSetting: {
      findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
        where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) })),
      findUnique: async ({ where }: { where: { key: string } }) =>
        settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: { key: string };
        update: { value: string };
        create: { key: string; value: string };
      }) => {
        settings.set(where.key, update.value ?? create.value);
        return { key: where.key, value: settings.get(where.key) };
      },
    },
    selfTestRun: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId(), createdAt: new Date(), startedAt: new Date(), ...data } as Row;
        runs.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = runs.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      count: async ({ where }: { where: { status: string } }) => runs.filter((r) => r.status === where.status).length,
      findFirst: async ({ where }: { where: { status?: string; mode?: string } }) =>
        runs.find((r) => (where.status ? r.status === where.status : true) && (where.mode ? r.mode === where.mode : true)) ?? null,
      findMany: async () => runs,
      aggregate: async () => ({ _count: { id: runs.length }, _avg: { mttdSec: null } }),
    },
    service: {
      findUnique: async ({ where }: { where: { key?: string; id?: string } }) =>
        services.find((s) => (where.key ? s.key === where.key : true) && (where.id ? s.id === where.id : true)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId(), ...data } as Row;
        services.push(row);
        return row;
      },
    },
    incident: {
      findFirst: async ({ where }: { where: { serviceId?: string; status?: string; source?: string } }) =>
        incidents.find(
          (i) =>
            (where.serviceId ? i.serviceId === where.serviceId : true) &&
            (where.status ? i.status === where.status : true) &&
            (where.source ? i.source === where.source : true),
        ) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => incidents.find((i) => i.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = incidents.find((i) => i.id === where.id);
        if (!row) throw new Error(`incident ${where.id} not found`);
        return row;
      },
    },
    chaosExperiment: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: nextId(), startedAt: new Date(), ...data } as Row;
        experiments.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = experiments.find((e) => e.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      findFirst: async ({ where }: { where: { serviceId?: string; status?: string } }) =>
        experiments.find((e) => (where.serviceId ? e.serviceId === where.serviceId : true) && (where.status ? e.status === where.status : true)) ?? null,
    },
  };
}

type Db = ReturnType<typeof makeDb>;
const db = (await import('@/lib/db')).db as unknown as Db;

describe('launchLiveChaos refusals (live mode chaos is opt-in only)', () => {
  beforeEach(() => {
    db.settings.clear();
    db.runs.length = 0;
    db.incidents.length = 0;
    db.experiments.length = 0;
    db.services.length = 0;
    engineState.mode = 'live';
  });

  it('refuses the self-test synthetic target with a named 409', async () => {
    await expect(
      launchLiveChaos({ id: 's1', key: 'selftest-synthetic', name: 'Self-test synthetic target', chaosHookUrl: null, chaosHookSecret: null, enabled: true }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses services without a customer-provided hook (chaos-hook-not-configured)', async () => {
    await expect(
      launchLiveChaos({ id: 's2', key: 'payment-gateway', name: 'Payment Gateway', chaosHookUrl: null, chaosHookSecret: null, enabled: true }),
    ).rejects.toSatisfy((err: unknown) => err instanceof HttpError && err.message.includes('chaos-hook-not-configured'));
  });
});

// ── live-path busy guard + weekly scheduler (stub db) ────────────────────────

describe('self-test paths over a stub db', () => {
  beforeEach(() => {
    db.settings.clear();
    db.runs.length = 0;
    db.incidents.length = 0;
    db.experiments.length = 0;
    db.services.length = 0;
    engineState.mode = 'live';
  });

  it('live run refuses honestly when the synthetic target already has an ongoing incident', async () => {
    // seed the synthetic service so ensureSyntheticService finds it
    await db.service.create({
      data: { key: 'selftest-synthetic', name: 'Self-test synthetic target', nameFa: null, tenantId: null },
    });
    db.incidents.push({
      id: 'inc-busy',
      serviceId: (db.services[0] as { id: string }).id,
      status: 'ongoing',
      source: 'live',
      startedAt: new Date(),
      resolvedAt: null,
      mttrSec: null,
    });
    const { runSelfTest } = await import('@/server/resilience/selftest');
    const result = await runSelfTest('manual');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('selftest-target-busy');
    // the run row exists and is marked failed with the named error
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]).toMatchObject({ status: 'failed', error: 'selftest-target-busy' });
  });

  it('demo weekly scheduler fires catch-up-once and passes with a detected incident', async () => {
    engineState.mode = 'demo';
    // synthetic service already known to the engine stub
    const svc = await db.service.create({ data: { key: 'selftest-synthetic', name: 'Self-test synthetic target' } });
    engineState.launchChaos.mockImplementation(async () => {
      const now = Date.now();
      db.incidents.push({
        id: 'inc-1',
        serviceId: (svc as { id: string }).id,
        status: 'resolved',
        source: 'chaos',
        startedAt: new Date(now),
        detectedAt: new Date(now + 8_000),
        resolvedAt: new Date(now + 25_000),
        mttrSec: 25,
        chaosExperimentId: 'exp-1',
      });
      return { id: 'exp-1', startedAt: new Date(now) };
    });

    const { runDueSelfTests } = await import('@/server/resilience/selftest');
    // The scheduler's due math uses the passed instant; the run itself anchors
    // its fault injection to the real clock (catch-up runs measure from
    // injection, not from the stale slot).
    const first = await runDueSelfTests(new Date());
    expect(first).toBe(1); // fired (catch-up — the slot is in the past)
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]).toMatchObject({ trigger: 'weekly', mode: 'demo', status: 'passed', gatePassed: true });
    expect(db.runs[0].mttdSec).toBe(8);
    expect(db.runs[0].mttrSec).toBe(25);
    // a second pass in the same window must NOT re-fire
    const second = await runDueSelfTests(new Date(Date.UTC(2026, 9, 8, 12, 1, 0)));
    expect(second).toBe(0);
    expect(db.runs).toHaveLength(1);
  });

  it('disabled schedule never fires', async () => {
    await db.integrationSetting.upsert({ where: { key: 'selfTestEnabled' }, update: { value: '0' }, create: { key: 'selfTestEnabled', value: '0' } });
    const { runDueSelfTests } = await import('@/server/resilience/selftest');
    expect(await runDueSelfTests(new Date(Date.UTC(2026, 9, 8, 12, 0, 0)))).toBe(0);
    expect(db.runs).toHaveLength(0);
  });
});

// Sentinel-SLA — self-test: "the system tests itself".
//
// The requirement: "weekly job that runs a controlled experiment
// against the product's own detection pipeline (a synthetic target that the
// product controls), measures MTTD/MTTR, stores the result, alerts if
// MTTD ≥ 60 s. Make it real and visible on /resilience."
//
// Design:
// - The synthetic target is a REAL service row (key `selftest-synthetic`,
//   tenant-less, zero money model) so the whole pipeline treats it like any
//   other service — probes, streaks, incidents, alerts, measurement. It is
//   excluded from spontaneous simulation: the only faults it ever gets are
//   the ones the self-test injects (deterministic measurements).
// - Demo mode: the fault is injected through the engine's chaos path
//   (launchChaos) and detected by the simulation tick's probe pipeline.
// - Live mode: the fault window is stored on the SelfTestRun row; the
//   ingestion loop synthesizes the probe from that window (probeSource
//   {kind:"synthetic"}) and everything downstream — failure streaks, the
//   detection state machine, incident evidence, alerts, resolution — is the
//   exact live pipeline. No Prometheus or external system is involved, so
//   the self-test works air-gapped.
// - MTTD gate = 60 s (product requirement). A missed gate (or a run that errors out) emits
//   ONE bilingual notification through the outbox (topic `selftest`); passes
//   stay visible on /resilience only — weekly pass messages would be noise.
// - Scheduling mirrors the digest: IntegrationSetting keys, pure due/next
//   math, catch-up-once, advisory lock ('selftest-scheduler') so web/worker
//   replicas never double-run. Default schedule: weekly, Friday 03:00 UTC
//   (Friday pre-dawn = Iranian weekend, the quietest window).

import { db } from '@/lib/db';
import { getConfig } from '@/server/config';
import { withSchedulerLock } from '@/server/locks';
import { emitNotification } from '@/server/notify/outbox';
import type { NotifyVars } from '@/server/notify/templates';

export const SELFTEST_SERVICE_KEY = 'selftest-synthetic';
export const SELFTEST_GATE_SEC = 60; // (detect a downed service in < 60 s
/** How long the injected fault lasts. Detection (~10–20 s) + recovery happen inside it. */
export const SELFTEST_FAULT_SEC = 25;
/** Wait cap for detection before the run is marked failed (gate + margin). */
export const SELFTEST_DETECT_CAP_MS = (SELFTEST_GATE_SEC + 30) * 1000;
/** Wait cap for resolution after detection before the run is failed on MTTR. */
export const SELFTEST_RESOLVE_CAP_MS = 300 * 1000;
const POLL_MS = 1000;

export type SelfTestTrigger = 'manual' | 'weekly';
export type SelfTestStatus = 'running' | 'passed' | 'failed';

// ── pure math (unit-tested, no db) ──────────────────────────────────────────

/** The gate verdict: MTTD must be strictly below the gate. null = undetectable. */
export function evaluateGate(mttdSec: number | null | undefined, gateSec = SELFTEST_GATE_SEC): boolean | null {
  if (mttdSec === null || mttdSec === undefined || !Number.isFinite(mttdSec)) return null;
  return mttdSec < gateSec;
}

export interface SelfTestConfig {
  enabled: boolean;
  /** UTC hour 0-23. */
  hour: number;
  /** UTC day 0-6 (0=Sunday). */
  dayOfWeek: number;
}

export const SELFTEST_DEFAULTS: SelfTestConfig = { enabled: true, hour: 3, dayOfWeek: 5 }; // Fri 03:00 UTC

/**
 * The latest due instant at or before `now` for this weekly config, or null
 * when disabled/malformed. Missed slots (app down at the due instant) fire
 * exactly once — catch-up-once, mirroring the digest/report schedulers.
 */
export function selfTestDueInstant(cfg: Pick<SelfTestConfig, 'enabled' | 'hour' | 'dayOfWeek'>, now: Date): Date | null {
  if (!cfg.enabled) return null;
  const hour = Number(cfg.hour);
  const dow = Number(cfg.dayOfWeek);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    d.setUTCHours(hour, 0, 0, 0);
    if (d.getUTCDay() === dow && d.getTime() <= now.getTime()) return d;
  }
  return null;
}

/** Next due instant strictly after `now` (UI "next self-test" display). */
export function selfTestNextInstant(cfg: Pick<SelfTestConfig, 'enabled' | 'hour' | 'dayOfWeek'>, now: Date): Date | null {
  if (!cfg.enabled) return null;
  const hour = Number(cfg.hour);
  const dow = Number(cfg.dayOfWeek);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + i);
    d.setUTCHours(hour, 0, 0, 0);
    if (d.getUTCDay() === dow && d.getTime() > now.getTime()) return d;
  }
  return null;
}

// ── config persistence (IntegrationSetting keys) ────────────────────────────

export async function readSelfTestConfig(): Promise<SelfTestConfig> {
  const rows = await db.integrationSetting.findMany({
    where: { key: { in: ['selfTestEnabled', 'selfTestHour', 'selfTestDayOfWeek'] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value] as const));
  const hour = Number(map.get('selfTestHour') ?? SELFTEST_DEFAULTS.hour);
  const dayOfWeek = Number(map.get('selfTestDayOfWeek') ?? SELFTEST_DEFAULTS.dayOfWeek);
  return {
    // default ON: the self-test is the product's core promise, and it only
    // ever touches its own synthetic target
    enabled: map.get('selfTestEnabled') !== '0',
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : SELFTEST_DEFAULTS.hour,
    dayOfWeek:
      Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6 ? dayOfWeek : SELFTEST_DEFAULTS.dayOfWeek,
  };
}

export async function writeSelfTestConfig(cfg: SelfTestConfig): Promise<void> {
  const pairs: Array<[string, string]> = [
    ['selfTestEnabled', cfg.enabled ? '1' : '0'],
    ['selfTestHour', String(cfg.hour)],
    ['selfTestDayOfWeek', String(cfg.dayOfWeek)],
  ];
  for (const [key, value] of pairs) {
    await db.integrationSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
}

async function readLastWeeklyRunAt(): Promise<number> {
  const row = await db.integrationSetting.findUnique({ where: { key: 'selfTestLastWeeklyRunAt' } });
  if (!row) return 0;
  const ms = new Date(row.value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

async function recordWeeklyRun(at: Date): Promise<void> {
  await db.integrationSetting.upsert({
    where: { key: 'selfTestLastWeeklyRunAt' },
    update: { value: at.toISOString() },
    create: { key: 'selfTestLastWeeklyRunAt', value: at.toISOString() },
  });
}

// ── synthetic target ────────────────────────────────────────────────────────

/**
 * Find-or-create the synthetic service the self-test faults. Zero money
 * model (tps/penalties 0) so a self-test incident never distorts customer
 * money aggregates; tenant-less so it only appears in fleet views; excluded
 * from spontaneous simulation by the engine (key check).
 */
export async function ensureSyntheticService() {
  const existing = await db.service.findUnique({ where: { key: SELFTEST_SERVICE_KEY } });
  if (existing) return existing;
  return db.service.create({
    data: {
      key: SELFTEST_SERVICE_KEY,
      name: 'Self-test synthetic target',
      nameFa: 'هدف آزمایشی خودسنجی',
      tenantId: null,
      tier: 'tier-3',
      criticality: 'low',
      endpoint: 'internal://selftest',
      baseLatencyMs: 1,
      tps: 0,
      avgTransactionValue: 0,
      slaTarget: 0.999,
      penaltyBase: 0,
      penaltyPerMinute: 0,
      enabled: true,
      probeSource: JSON.stringify({ kind: 'synthetic' }),
    },
  });
}

// ── result ledger helpers ───────────────────────────────────────────────────

export interface SelfTestStats {
  lastRun: {
    id: string;
    trigger: SelfTestTrigger;
    status: SelfTestStatus;
    startedAt: string;
    mttdSec: number | null;
    mttrSec: number | null;
    gatePassed: boolean | null;
  } | null;
  /** Runs finished in the last 30 days. */
  windowRuns: number;
  windowPasses: number;
  avgMttdSec: number | null;
  consecutivePasses: number;
}

export async function selfTestStats(): Promise<SelfTestStats> {
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  const finishedWhere = { status: { not: 'running' } } as const;
  const [last, agg, passes, recent] = await Promise.all([
    db.selfTestRun.findFirst({
      where: finishedWhere,
      orderBy: { startedAt: 'desc' },
    }),
    db.selfTestRun.aggregate({
      where: { ...finishedWhere, startedAt: { gte: since } },
      _count: { id: true },
      _avg: { mttdSec: true },
    }),
    db.selfTestRun.count({ where: { ...finishedWhere, status: 'passed', startedAt: { gte: since } } }),
    db.selfTestRun.findMany({
      where: finishedWhere,
      orderBy: { startedAt: 'desc' },
      take: 50,
      select: { status: true },
    }),
  ]);
  let consecutivePasses = 0;
  for (const r of recent) {
    if (r.status !== 'passed') break;
    consecutivePasses++;
  }
  return {
    lastRun: last
      ? {
          id: last.id,
          trigger: last.trigger as SelfTestTrigger,
          status: last.status as SelfTestStatus,
          startedAt: last.startedAt.toISOString(),
          mttdSec: last.mttdSec,
          mttrSec: last.mttrSec,
          gatePassed: last.gatePassed,
        }
      : null,
    windowRuns: agg._count.id,
    windowPasses: passes,
    avgMttdSec: agg._avg.mttdSec === null || agg._avg.mttdSec === undefined ? null : agg._avg.mttdSec,
    consecutivePasses,
  };
}

export async function hasRunningSelfTest(): Promise<boolean> {
  return (await db.selfTestRun.count({ where: { status: 'running' } })) > 0;
}

// ── the experiment itself ───────────────────────────────────────────────────

export interface SelfTestResult {
  ok: boolean;
  runId: string | null;
  status: SelfTestStatus;
  error: string | null;
  mttdSec: number | null;
  mttrSec: number | null;
  gatePassed: boolean | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run one controlled self-test NOW (manual trigger or the weekly scheduler).
 * Never throws — every failure lands in the SelfTestRun row and, for gate
 * misses / internal errors, in exactly one outbox notification.
 */
export async function runSelfTest(trigger: SelfTestTrigger, nowMs = Date.now()): Promise<SelfTestResult> {
  const mode = getConfig().mode;
  let runId: string | null = null;
  try {
    if (await hasRunningSelfTest()) {
      return { ok: false, runId: null, status: 'running', error: 'selftest-already-running', mttdSec: null, mttrSec: null, gatePassed: null };
    }
    const service = await ensureSyntheticService();
    const run = await db.selfTestRun.create({
      data: { serviceId: service.id, trigger, mode, status: 'running', gateSec: SELFTEST_GATE_SEC },
    });
    runId = run.id;

    const outcome =
      mode === 'demo'
        ? await runDemoSelfTest(service.id, run.id, nowMs)
        : await runLiveSelfTest(service.id, run.id, nowMs);

    const gatePassed = evaluateGate(outcome.mttdSec, SELFTEST_GATE_SEC);
    const failed = outcome.error !== null || gatePassed !== true;
    await db.selfTestRun.update({
      where: { id: run.id },
      data: {
        status: failed ? 'failed' : 'passed',
        finishedAt: new Date(),
        detectedAt: outcome.detectedAt ? new Date(outcome.detectedAt) : null,
        resolvedAt: outcome.resolvedAt ? new Date(outcome.resolvedAt) : null,
        mttdSec: outcome.mttdSec,
        mttrSec: outcome.mttrSec,
        gatePassed,
        incidentId: outcome.incidentId,
        experimentId: outcome.experimentId,
        error: outcome.error,
      },
    });

    if (failed) {
      await emitGateMissAlert(run.id, outcome);
      await db.selfTestRun.update({ where: { id: run.id }, data: { alerted: true } });
    }
    console.log(
      `[sentinel:selftest] ${trigger} run ${failed ? 'FAILED' : 'passed'} — mode=${mode} ` +
        `MTTD ${outcome.mttdSec === null ? 'n/a' : `${outcome.mttdSec.toFixed(1)}s`} (gate ${SELFTEST_GATE_SEC}s)` +
        `${outcome.mttrSec !== null ? `, MTTR ${outcome.mttrSec.toFixed(1)}s` : ''}${outcome.error ? `, error=${outcome.error}` : ''}`,
    );
    return {
      ok: !failed,
      runId: run.id,
      status: failed ? 'failed' : 'passed',
      error: outcome.error,
      mttdSec: outcome.mttdSec,
      mttrSec: outcome.mttrSec,
      gatePassed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[sentinel:selftest] run errored:', msg);
    if (runId) {
      await db.selfTestRun
        .update({
          where: { id: runId },
          data: { status: 'failed', finishedAt: new Date(), error: msg, gatePassed: null, alerted: true },
        })
        .catch(() => undefined);
      await emitGateMissAlert(runId, { mttdSec: null, mttrSec: null, error: msg }).catch(() => undefined);
    }
    return { ok: false, runId, status: 'failed', error: msg, mttdSec: null, mttrSec: null, gatePassed: null };
  }
}

interface Outcome {
  detectedAt: number | null;
  resolvedAt: number | null;
  mttdSec: number | null;
  mttrSec: number | null;
  incidentId: string | null;
  experimentId: string | null;
  error: string | null;
}

/** Demo mode: chaos-forced outage on the synthetic service, engine tick detects. */
async function runDemoSelfTest(serviceId: string, _runId: string, _nowMs: number): Promise<Outcome> {
  const { getEngine } = await import('@/server/engine');
  const engine = getEngine();
  // 409s (active incident / running experiment on the target) surface as
  // honest named errors — never a fake measurement.
  const experiment = await engine.launchChaos({ serviceId, type: 'outage', durationSec: SELFTEST_FAULT_SEC });

  // All deadlines anchor to the REAL clock: a catch-up weekly run (whose
  // scheduled instant may be hours old) must measure from when the fault is
  // actually injected, not from the stale schedule slot.
  const detectDeadline = Date.now() + SELFTEST_DETECT_CAP_MS;
  let incidentId: string | null = null;
  let detectedAt: number | null = null;
  while (Date.now() < detectDeadline) {
    await sleep(POLL_MS);
    const inc = await db.incident.findFirst({
      where: { chaosExperimentId: experiment.id },
      orderBy: { startedAt: 'desc' },
    });
    if (inc?.detectedAt) {
      incidentId = inc.id;
      detectedAt = inc.detectedAt.getTime();
      break;
    }
  }
  if (detectedAt === null) {
    // Abort the experiment so it cannot block future runs (a stuck 'running'
    // row would 409 every retry until the next engine restart).
    await db.chaosExperiment
      .update({ where: { id: experiment.id }, data: { status: 'aborted', endedAt: new Date(), notes: 'self-test detection timeout' } })
      .catch(() => undefined);
    return {
      detectedAt: null, resolvedAt: null, mttdSec: null, mttrSec: null,
      incidentId, experimentId: experiment.id,
      error: 'detection-timeout',
    };
  }
  const incident = await db.incident.findUniqueOrThrow({ where: { id: incidentId! } });
  const mttdSec = round1((detectedAt - incident.startedAt.getTime()) / 1000);

  const resolveDeadline = detectedAt + SELFTEST_RESOLVE_CAP_MS;
  let resolvedAt: number | null = null;
  while (Date.now() < resolveDeadline) {
    await sleep(POLL_MS);
    const fresh = await db.incident.findUnique({ where: { id: incidentId! } });
    if (fresh?.status === 'resolved' && fresh.resolvedAt) {
      resolvedAt = fresh.resolvedAt.getTime();
      break;
    }
  }
  const mttrSec = resolvedAt !== null ? round1((resolvedAt - incident.startedAt.getTime()) / 1000) : null;
  return {
    detectedAt, resolvedAt, mttdSec, mttrSec,
    incidentId, experimentId: experiment.id,
    error: resolvedAt === null ? 'resolution-timeout' : null,
  };
}

/** Live mode: DB-backed fault window; the ingestion loop's synthetic probe + state machine do the rest. */
async function runLiveSelfTest(serviceId: string, runId: string, _nowMs: number): Promise<Outcome> {
  const busy = await db.incident.findFirst({ where: { serviceId, status: 'ongoing' } });
  if (busy) {
    return {
      detectedAt: null, resolvedAt: null, mttdSec: null, mttrSec: null,
      incidentId: null, experimentId: null, error: 'selftest-target-busy',
    };
  }
  const faultStartMs = Date.now();
  await db.selfTestRun.update({
    where: { id: runId },
    data: { faultUntil: new Date(faultStartMs + SELFTEST_FAULT_SEC * 1000) },
  });

  const detectDeadline = faultStartMs + SELFTEST_DETECT_CAP_MS;
  let incident: { id: string; startedAt: Date } | null = null;
  while (Date.now() < detectDeadline) {
    await sleep(POLL_MS);
    const opened = await db.incident.findFirst({
      where: { serviceId, status: 'ongoing', source: 'live', startedAt: { gte: new Date(faultStartMs) } },
      orderBy: { startedAt: 'asc' },
    });
    if (opened) {
      incident = { id: opened.id, startedAt: opened.startedAt };
      break;
    }
  }
  if (!incident) {
    return {
      detectedAt: null, resolvedAt: null, mttdSec: null, mttrSec: null,
      incidentId: null, experimentId: null, error: 'detection-timeout',
    };
  }
  // Live incidents open at the moment the failure threshold is crossed —
  // that IS the detection instant. MTTD = opened − fault injection.
  const mttdSec = round1((incident.startedAt.getTime() - faultStartMs) / 1000);

  const resolveDeadline = Date.now() + SELFTEST_RESOLVE_CAP_MS;
  let resolvedAt: number | null = null;
  while (Date.now() < resolveDeadline) {
    await sleep(POLL_MS);
    const fresh = await db.incident.findUnique({ where: { id: incident.id } });
    if (fresh?.status === 'resolved' && fresh.resolvedAt) {
      resolvedAt = fresh.resolvedAt.getTime();
      break;
    }
  }
  const mttrSec = resolvedAt !== null ? round1((resolvedAt - incident.startedAt.getTime()) / 1000) : null;
  return {
    detectedAt: incident.startedAt.getTime(), resolvedAt,
    mttdSec, mttrSec,
    incidentId: incident.id, experimentId: null,
    error: resolvedAt === null ? 'resolution-timeout' : null,
  };
}

/** One bilingual notification when the promise breaks (gate missed / run errored). */
async function emitGateMissAlert(
  runId: string,
  outcome: Pick<Outcome, 'mttdSec' | 'mttrSec' | 'error'>,
): Promise<void> {
  const vars: NotifyVars = {
    runId,
    mttdSec: outcome.mttdSec,
    mttrSec: outcome.mttrSec,
    gateSec: SELFTEST_GATE_SEC,
    selfTestError: outcome.error ?? 'unknown',
    sentAt: new Date().toISOString(),
  };
  await emitNotification({
    topic: 'selftest',
    severity: 'critical',
    audiences: ['technical', 'executive'],
    vars,
    incidentId: null,
    serviceId: null,
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ── scheduler (same shape as the digest) ────────────────────────────────────

/**
 * Engine/worker hook: fire the weekly self-test when its due instant passed
 * since the last weekly run. Advisory-locked; catch-up-once. Returns 1 when
 * a run started, 0 otherwise (null = another replica holds the lock).
 */
export async function runDueSelfTests(now = new Date()): Promise<number | null> {
  return withSchedulerLock('selftest-scheduler', async () => {
    const cfg = await readSelfTestConfig();
    if (!cfg.enabled) return 0;
    const due = selfTestDueInstant(cfg, now);
    if (!due) return 0;
    const lastMs = await readLastWeeklyRunAt();
    if (lastMs >= due.getTime()) return 0;
    // Record the scheduling intent BEFORE the run so a crashed run is not
    // re-fired every minute; the run's own row carries the outcome.
    await recordWeeklyRun(now);
    const result = await runSelfTest('weekly', now.getTime());
    return result.runId ? 1 : 0;
  });
}

const LOOP_KEY = '__sentinel_selftest_loop__';

interface LoopState {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
}

function loopState(): LoopState {
  const g = globalThis as unknown as { [LOOP_KEY]?: LoopState };
  if (!g[LOOP_KEY]) g[LOOP_KEY] = { timer: null, running: false };
  return g[LOOP_KEY];
}

/** Idempotent start (engine backgroundLoops / worker live mode). */
export function startSelfTestScheduler(intervalMs = 60_000): number {
  const st = loopState();
  if (st.timer !== null) return intervalMs;
  st.timer = setInterval(() => {
    if (st.running) return;
    st.running = true;
    void runDueSelfTests()
      .catch((err: unknown) =>
        console.error('[sentinel:selftest] scheduler pass failed:', err instanceof Error ? err.message : err),
      )
      .finally(() => {
        st.running = false;
      });
  }, intervalMs);
  console.log(`[sentinel:selftest] scheduler started (checked every ${Math.round(intervalMs / 1000)}s)`);
  return intervalMs;
}

export function stopSelfTestScheduler(): void {
  const st = loopState();
  if (st.timer !== null) {
    clearInterval(st.timer);
    st.timer = null;
    console.log('[sentinel:selftest] scheduler stopped');
  }
}

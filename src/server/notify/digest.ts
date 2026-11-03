// Sentinel-SLA — executive digest scheduler.
//
// The requirement: "Executive digest: scheduled message
// (daily/weekly) with money summary in Persian to a channel; PDF attached
// when the channel supports files."
//
// Design:
// - Configuration lives in IntegrationSetting keys (digestFrequency /
//   digestHour / digestDayOfWeek) so admins manage it like every other
//   integration — via GET/PUT /api/integrations/digest, audit-logged.
//   Default is OFF: an instance must opt in to messaging executives.
// - Window math is pure and UTC-anchored (like the report scheduler):
//   daily = today@hour, weekly = dayOfWeek@hour. Missed slots (app down at
//   the due instant) fire exactly once — catch-up, not catch-up-n-times —
//   mirroring runDueReportSchedules semantics.
// - Money summary comes from the Incident ledger (the same rows the
//   dashboard and reports read): incidents whose startedAt falls in the
//   window, summed revenue loss / penalties / lost transactions, worst
//   service by revenue loss. Honest zeros — a quiet window says so.
// - Delivery reuses the outbox end-to-end: emitNotification(topic 'digest')
//   fans out to executive channels, the dispatcher records DeliveryLog rows,
//   and for file-capable channels (telegram/bale) the newest archived PDF
//   report is attached when one exists (see outbox dispatch + adapters).
//   No report → text-only digest, never a fake attachment.
//
// Concurrency: runDueDigests takes the shared advisory lock
// ('digest-scheduler') so web/worker replicas never double-send.

import { db } from '@/lib/db';
import { withSchedulerLock } from '@/server/locks';
import { emitNotification } from '@/server/notify/outbox';
import type { NotifyVars } from '@/server/notify/templates';

export type DigestFrequency = 'off' | 'daily' | 'weekly';

export interface DigestConfig {
  frequency: DigestFrequency;
  /** UTC hour 0-23 the digest fires at. */
  hour: number;
  /** UTC day 0-6 (0=Sunday) — weekly only. */
  dayOfWeek: number;
}

export const DIGEST_DEFAULTS: DigestConfig = { frequency: 'off', hour: 8, dayOfWeek: 6 };

// ── pure window / due math (unit-tested, no db) ─────────────────────────────

/**
 * The latest due instant at or before `now` for this config, or null when the
 * config cannot fire (off / malformed hour). Mirrors the report scheduler's
 * lastDueInstant: missed due instants while the app was down still resolve,
 * which is what makes catch-up-once possible.
 */
export function digestDueInstant(
  cfg: Pick<DigestConfig, 'frequency' | 'hour' | 'dayOfWeek'>,
  now: Date,
): Date | null {
  const hour = Number(cfg.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (cfg.frequency === 'daily') {
    const d = new Date(now);
    d.setUTCHours(hour, 0, 0, 0);
    if (d.getTime() <= now.getTime()) return d;
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  }
  if (cfg.frequency === 'weekly') {
    const dow = Number(cfg.dayOfWeek);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
    for (let i = 0; i <= 7; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      d.setUTCHours(hour, 0, 0, 0);
      if (d.getUTCDay() === dow && d.getTime() <= now.getTime()) return d;
    }
    return null;
  }
  return null;
}

/** Next due instant strictly after `now` (UI "next digest" display). */
export function digestNextInstant(
  cfg: Pick<DigestConfig, 'frequency' | 'hour' | 'dayOfWeek'>,
  now: Date,
): Date | null {
  const hour = Number(cfg.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (cfg.frequency === 'daily') {
    const d = new Date(now);
    d.setUTCHours(hour, 0, 0, 0);
    if (d.getTime() > now.getTime()) return d;
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  if (cfg.frequency === 'weekly') {
    const dow = Number(cfg.dayOfWeek);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
    for (let i = 0; i <= 7; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + i);
      d.setUTCHours(hour, 0, 0, 0);
      if (d.getUTCDay() === dow && d.getTime() > now.getTime()) return d;
    }
    return null;
  }
  return null;
}

export interface DigestWindow {
  startMs: number;
  endMs: number;
  /** EN technical label, e.g. "last 24 hours". */
  labelEn: string;
  /** FA executive label, e.g. "۲۴ ساعت گذشته". */
  labelFa: string;
}

/** The money window a digest covers: 24h for daily, 7d for weekly. */
export function digestWindow(cfg: Pick<DigestConfig, 'frequency'>, nowMs: number): DigestWindow | null {
  if (cfg.frequency === 'daily') {
    return { startMs: nowMs - 24 * 3600_000, endMs: nowMs, labelEn: 'last 24 hours', labelFa: '۲۴ ساعت گذشته' };
  }
  if (cfg.frequency === 'weekly') {
    return { startMs: nowMs - 7 * 24 * 3600_000, endMs: nowMs, labelEn: 'last 7 days', labelFa: '۷ روز گذشته' };
  }
  return null;
}

// ── config persistence (IntegrationSetting keys) ────────────────────────────

function normalizeFrequency(v: string | null | undefined): DigestFrequency {
  return v === 'daily' || v === 'weekly' ? v : 'off';
}

export async function readDigestConfig(): Promise<DigestConfig> {
  const rows = await db.integrationSetting.findMany({
    where: { key: { in: ['digestFrequency', 'digestHour', 'digestDayOfWeek'] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value] as const));
  const hour = Number(map.get('digestHour') ?? DIGEST_DEFAULTS.hour);
  const dayOfWeek = Number(map.get('digestDayOfWeek') ?? DIGEST_DEFAULTS.dayOfWeek);
  return {
    frequency: normalizeFrequency(map.get('digestFrequency')),
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DIGEST_DEFAULTS.hour,
    dayOfWeek: Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6 ? dayOfWeek : DIGEST_DEFAULTS.dayOfWeek,
  };
}

export async function writeDigestConfig(cfg: DigestConfig): Promise<void> {
  const pairs: Array<[string, string]> = [
    ['digestFrequency', cfg.frequency],
    ['digestHour', String(cfg.hour)],
    ['digestDayOfWeek', String(cfg.dayOfWeek)],
  ];
  for (const [key, value] of pairs) {
    await db.integrationSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
}

export interface DigestRunInfo {
  lastRunAt: string | null;
  lastRunOk: boolean;
  lastError: string | null;
}

export async function readDigestRunInfo(): Promise<DigestRunInfo> {
  const rows = await db.integrationSetting.findMany({
    where: { key: { in: ['digestLastRunAt', 'digestLastRunOk', 'digestLastError'] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value] as const));
  return {
    lastRunAt: map.get('digestLastRunAt') ?? null,
    lastRunOk: map.get('digestLastRunOk') === '1',
    lastError: map.get('digestLastError') ?? null,
  };
}

async function recordDigestRun(ok: boolean, error: string | null, at: Date): Promise<void> {
  const pairs: Array<[string, string]> = [
    ['digestLastRunAt', at.toISOString()],
    ['digestLastRunOk', ok ? '1' : '0'],
    ['digestLastError', error ?? ''],
  ];
  for (const [key, value] of pairs) {
    await db.integrationSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }
}

// ── money summary from the incident ledger ──────────────────────────────────

export interface DigestStats {
  incidentsCount: number;
  resolvedCount: number;
  openCount: number;
  lostTransactions: number;
  revenueLossTomans: number;
  penaltyTomans: number;
  worstServiceName: string;
  worstServiceNameFa: string | null;
  worstServiceLossTomans: number;
}

/**
 * Sum the window's impact from Incident rows (startedAt within the window —
 * the same ledger the dashboard/analytics read). Worst service by revenue
 * loss, joined for its bilingual display name. Pure aggregation over the db;
 * a quiet window returns honest zeros with an empty worst service.
 */
export async function collectDigestStats(startMs: number, endMs: number): Promise<DigestStats> {
  const totals = (
    await db.$queryRaw`
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolvedN,
             SUM(CASE WHEN status = 'ongoing' THEN 1 ELSE 0 END) AS openN,
             COALESCE(SUM(lostTransactions), 0) AS lostTx,
             COALESCE(SUM(revenueLossTomans), 0) AS revenueLoss,
             COALESCE(SUM(penaltyTomans), 0) AS penalty
      FROM Incident
      WHERE startedAt >= ${startMs} AND startedAt < ${endMs}
    `
  ) as Array<{
    n: number | null; resolvedN: number | null; openN: number | null;
    lostTx: number | null; revenueLoss: number | null; penalty: number | null;
  }>;

  const worst = (
    await db.$queryRaw`
      SELECT s.name AS name, s.nameFa AS nameFa, SUM(i.revenueLossTomans) AS loss
      FROM Incident i JOIN Service s ON s.id = i.serviceId
      WHERE i.startedAt >= ${startMs} AND i.startedAt < ${endMs}
      GROUP BY s.name, s.nameFa
      ORDER BY loss DESC
      LIMIT 1
    `
  ) as Array<{ name: string; nameFa: string | null; loss: number | null }>;

  const t = totals[0] ?? {};
  return {
    incidentsCount: Number(t.n ?? 0),
    resolvedCount: Number(t.resolvedN ?? 0),
    openCount: Number(t.openN ?? 0),
    lostTransactions: Number(t.lostTx ?? 0),
    revenueLossTomans: Number(t.revenueLoss ?? 0),
    penaltyTomans: Number(t.penalty ?? 0),
    worstServiceName: worst[0]?.name ?? '—',
    worstServiceNameFa: worst[0]?.nameFa ?? null,
    worstServiceLossTomans: Number(worst[0]?.loss ?? 0),
  };
}

/** Jalali clock for the FA executive audience (Asia/Tehran). */
function jalaliClock(ms: number): string {
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Tehran',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Emit one digest NOW (manual "Run now" or the scheduler). Returns the
 * emit result (alert ids + enqueued count) so the API can report what
 * happened. Always executive audience — the digest is the Persian money
 * summary by definition; the EN variant exists in templates for the feed.
 */
export async function runDigestNow(nowMs = Date.now()): Promise<{
  ok: boolean;
  error: string | null;
  enqueued: number;
  alertIds: string[];
}> {
  try {
    const cfg = await readDigestConfig();
    if (cfg.frequency === 'off') {
      // honest: an explicit run of a disabled schedule does nothing
      return { ok: false, error: 'digest-disabled', enqueued: 0, alertIds: [] };
    }
    const window = digestWindow(cfg, nowMs);
    if (!window) return { ok: false, error: 'digest-disabled', enqueued: 0, alertIds: [] };
    const stats = await collectDigestStats(window.startMs, window.endMs);
    const vars: NotifyVars = {
      windowLabel: window.labelEn,
      windowLabelFa: window.labelFa,
      incidentsCount: stats.incidentsCount,
      resolvedCount: stats.resolvedCount,
      openCount: stats.openCount,
      lostTransactions: stats.lostTransactions,
      revenueLossTomans: Math.round(stats.revenueLossTomans),
      penaltyTomans: Math.round(stats.penaltyTomans),
      worstService: stats.worstServiceName,
      worstServiceFa: stats.worstServiceNameFa ?? stats.worstServiceName,
      worstServiceLossTomans: Math.round(stats.worstServiceLossTomans),
      digestGeneratedAt: jalaliClock(nowMs),
    };
    const result = await emitNotification({
      topic: 'digest',
      severity: 'info',
      audiences: ['executive'],
      vars,
      now: nowMs,
      // digests are periodic summaries — no incident/rule to dedup against
      incidentId: null,
      serviceId: null,
    });
    await recordDigestRun(true, null, new Date(nowMs));
    return { ok: true, error: null, enqueued: result.enqueued, alertIds: result.alertIds };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordDigestRun(false, msg, new Date(nowMs)).catch(() => undefined);
    return { ok: false, error: msg, enqueued: 0, alertIds: [] };
  }
}

/**
 * Engine/worker hook: fire the digest when its due instant passed since the
 * last run. Advisory-locked (two replicas never double-send); returns the
 * number of digests emitted (0 most ticks) or null when another replica
 * holds the lock. Catch-up-once semantics via lastRunAt comparison.
 */
export async function runDueDigests(now = new Date()): Promise<number | null> {
  return withSchedulerLock('digest-scheduler', async () => {
    const cfg = await readDigestConfig();
    if (cfg.frequency === 'off') return 0;
    const due = digestDueInstant(cfg, now);
    if (!due) return 0;
    const info = await readDigestRunInfo();
    const lastRunMs = info.lastRunAt ? new Date(info.lastRunAt).getTime() : 0;
    if (!Number.isNaN(lastRunMs) && lastRunMs >= due.getTime()) return 0;
    const result = await runDigestNow(now.getTime());
    if (result.ok) {
      console.log(`[sentinel:digest] ${cfg.frequency} digest emitted (${result.enqueued} channel row(s))`);
      return 1;
    }
    console.error(`[sentinel:digest] run failed: ${result.error}`);
    return 0;
  });
}

// ── loop lifecycle (same shape as the outbox dispatcher) ────────────────────

const LOOP_KEY = '__sentinel_digest_loop__';

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
export function startDigestScheduler(intervalMs = 60_000): number {
  const st = loopState();
  if (st.timer !== null) return intervalMs;
  st.timer = setInterval(() => {
    if (st.running) return;
    st.running = true;
    void runDueDigests()
      .catch((err: unknown) =>
        console.error('[sentinel:digest] scheduler pass failed:', err instanceof Error ? err.message : err),
      )
      .finally(() => {
        st.running = false;
      });
  }, intervalMs);
  console.log(`[sentinel:digest] scheduler started (every ${Math.round(intervalMs / 1000)}s)`);
  return intervalMs;
}

export function stopDigestScheduler(): void {
  const st = loopState();
  if (st.timer !== null) {
    clearInterval(st.timer);
    st.timer = null;
    console.log('[sentinel:digest] scheduler stopped');
  }
}

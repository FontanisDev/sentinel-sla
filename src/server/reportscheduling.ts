// Sentinel-SLA — v2.4 report-schedule data access + cron-style due logic.
//
// Same parameterized raw-SQL pattern as alertgovernance.ts/maintenance.ts
// (HMR-safe under `prisma db push`; every value bound — OWASP ASVS L1).
//
// Due semantics (UTC, like the rest of the engine):
// - weekly: due every `dayOfWeek` at `hour`:00 UTC.
// - monthly: due on `dayOfMonth` at `hour`:00 UTC (day clamped to 1-28 so
//   every month is valid — no skipped Februarys).
// A schedule RUNS when the current time has passed its latest due instant
// and lastRunAt is older than that instant (missed runs while the app was
// down fire once on startup — catch-up, not catch-up-n-times).

import { db } from '@/lib/db';
import { withSchedulerLock } from '@/server/locks';
import { HttpError } from '@/server/http';
import { generateSlaReport } from '@/server/reportgen';
import { getTenantById } from '@/server/tenants';
import type { CreateReportSchedulePayload, ReportFrequency, ReportScheduleDTO, ScheduleRunDTO } from '@/lib/types';

export interface ReportScheduleRow {
  id: string;
  label: string;
  frequency: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hour: number | unknown;
  periodHours: number | unknown;
  kind: string | unknown;
  language: string | unknown;
  tenantId: string | null;
  enabled: number | unknown;
  lastRunAt: Date | string | null;
  createdAt: Date | string;
  tenantName?: string | null;
}

function newId(): string {
  const t = Date.now().toString(36).padStart(8, '0');
  const rand = Math.random().toString(36).slice(2, 12);
  return `c${t}${rand}`;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The most recent due instant at or before `now` for one schedule.
 * Pure date math — unit-testable, no DB. Returns null for malformed rows.
 */
export function lastDueInstant(
  sched: Pick<ReportScheduleRow, 'frequency' | 'dayOfWeek' | 'dayOfMonth' | 'hour'>,
  now: Date,
): Date | null {
  const hour = Number(sched.hour ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;

  if (sched.frequency === 'weekly') {
    const dow = Number(sched.dayOfWeek ?? 0);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
    // Walk back at most 7 days to find the latest matching weekday.
    for (let i = 0; i <= 7; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      d.setUTCHours(hour, 0, 0, 0);
      if (d.getUTCDay() === dow && d.getTime() <= now.getTime()) return d;
    }
    return null;
  }

  if (sched.frequency === 'monthly') {
    const dom = Number(sched.dayOfMonth ?? 1);
    if (!Number.isInteger(dom) || dom < 1 || dom > 28) return null;
    // This month's instant, else last month's (both valid — dom ≤ 28).
    for (const monthOffset of [0, 1]) {
      const d = new Date(now);
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - monthOffset);
      d.setUTCDate(dom);
      d.setUTCHours(hour, 0, 0, 0);
      if (d.getTime() <= now.getTime()) return d;
    }
    return null;
  }

  return null;
}

/** Next due instant strictly after `now` (for the UI's "next run" display). */
export function nextDueInstant(
  sched: Pick<ReportScheduleRow, 'frequency' | 'dayOfWeek' | 'dayOfMonth' | 'hour'>,
  now: Date,
): Date | null {
  const hour = Number(sched.hour ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;

  if (sched.frequency === 'weekly') {
    const dow = Number(sched.dayOfWeek ?? 0);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
    for (let i = 0; i <= 7; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + i);
      d.setUTCHours(hour, 0, 0, 0);
      if (d.getUTCDay() === dow && d.getTime() > now.getTime()) return d;
    }
    return null;
  }

  if (sched.frequency === 'monthly') {
    const dom = Number(sched.dayOfMonth ?? 1);
    if (!Number.isInteger(dom) || dom < 1 || dom > 28) return null;
    for (const monthOffset of [0, 1, 2]) {
      const d = new Date(now);
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + monthOffset);
      d.setUTCDate(dom);
      d.setUTCHours(hour, 0, 0, 0);
      if (d.getTime() > now.getTime()) return d;
    }
    return null;
  }

  return null;
}

export function toReportScheduleDTO(row: ReportScheduleRow, now = new Date()): ReportScheduleDTO {
  const enabled = Boolean(row.enabled);
  return {
    id: row.id,
    label: row.label,
    frequency: row.frequency === 'monthly' ? 'monthly' : 'weekly',
    dayOfWeek: row.frequency === 'monthly' ? null : Number(row.dayOfWeek ?? 0),
    dayOfMonth: row.frequency === 'monthly' ? Number(row.dayOfMonth ?? 1) : null,
    hour: Number(row.hour ?? 0),
    periodHours: Number(row.periodHours ?? 24),
    kind: row.kind === 'statement' ? 'statement' : 'executive',
    language: row.language === 'fa' ? 'fa' : 'en',
    tenantId: row.tenantId ?? null,
    tenantName: row.tenantName ?? null,
    enabled,
    lastRunAt: toIso(row.lastRunAt),
    nextRunAt: enabled ? toIso(nextDueInstant(row, now)) : null,
    createdAt: toIso(row.createdAt) ?? new Date().toISOString(),
  };
}

/** All schedules, enabled first, oldest created first. */
export async function listReportSchedules(): Promise<ReportScheduleDTO[]> {
  const rows = (await db.$queryRaw`
    SELECT s.id, s.label, s.frequency, s.dayOfWeek, s.dayOfMonth, s.hour, s.periodHours,
           s.kind, s.language, s.tenantId, s.enabled, s.lastRunAt, s.createdAt, t.name AS tenantName
    FROM ReportSchedule s
    LEFT JOIN Tenant t ON t.id = s.tenantId
    ORDER BY CASE WHEN s.enabled = TRUE THEN 1 ELSE 0 END DESC, s.createdAt ASC
  `) as ReportScheduleRow[];
  const now = new Date();
  return rows.map((r) => toReportScheduleDTO(r, now));
}

async function getScheduleRow(id: string): Promise<ReportScheduleRow | null> {
  const rows = (await db.$queryRaw`
    SELECT s.id, s.label, s.frequency, s.dayOfWeek, s.dayOfMonth, s.hour, s.periodHours,
           s.kind, s.language, s.tenantId, s.enabled, s.lastRunAt, s.createdAt, t.name AS tenantName
    FROM ReportSchedule s
    LEFT JOIN Tenant t ON t.id = s.tenantId
    WHERE s.id = ${id} LIMIT 1
  `) as ReportScheduleRow[];
  return rows.length > 0 ? rows[0] : null;
}

/** Validate frequency-specific day fields (OWASP ASVS L1 — reject before storing). */
function validateScheduleFields(payload: CreateReportSchedulePayload): string | null {
  if (payload.frequency === 'weekly') {
    const dow = payload.dayOfWeek ?? 0;
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return 'dayOfWeek must be an integer 0-6 for weekly schedules';
    return null;
  }
  const dom = payload.dayOfMonth ?? 1;
  if (!Number.isInteger(dom) || dom < 1 || dom > 28) return 'dayOfMonth must be an integer 1-28 for monthly schedules';
  return null;
}

export async function createReportSchedule(payload: CreateReportSchedulePayload): Promise<ReportScheduleDTO> {
  const fieldError = validateScheduleFields(payload);
  if (fieldError) throw new HttpError(400, fieldError);
  if (!Number.isInteger(payload.hour) || payload.hour < 0 || payload.hour > 23) {
    throw new HttpError(400, 'hour must be an integer 0-23 (UTC)');
  }
  if (payload.tenantId) {
    const tenant = await getTenantById(payload.tenantId);
    if (!tenant) throw new HttpError(404, `Tenant '${payload.tenantId}' not found`);
  }
  const id = newId();
  const now = new Date(); // Date param → ORM-native storage (see maintenance.ts note)
  const periodHours = (payload.periodHours ?? 24) as number;
  const kind = payload.kind ?? 'executive';
  const language = payload.language ?? 'en';
  if (kind === 'statement' && !payload.tenantId) {
    throw new HttpError(400, 'kind=statement schedules require tenantId (a per-client statement)');
  }
  await db.$executeRaw`
    INSERT INTO ReportSchedule
      (id, label, frequency, dayOfWeek, dayOfMonth, hour, periodHours, tenantId, enabled, lastRunAt, createdAt, kind, language)
    VALUES
      (${id}, ${payload.label}, ${payload.frequency},
       ${payload.frequency === 'weekly' ? (payload.dayOfWeek ?? 0) : null},
       ${payload.frequency === 'monthly' ? (payload.dayOfMonth ?? 1) : null},
       ${payload.hour}, ${periodHours}, ${payload.tenantId ?? null},
       ${payload.enabled === false ? 0 : 1}, NULL, ${now}, ${kind}, ${language})
  `;
  const row = await getScheduleRow(id);
  if (!row) throw new HttpError(500, 'Report schedule creation failed');
  return toReportScheduleDTO(row);
}

/** Toggle a schedule. 404 unknown id; returns the updated schedule. */
export async function setReportScheduleEnabled(id: string, enabled: boolean): Promise<ReportScheduleDTO> {
  const updated = await db.$executeRaw`
    UPDATE ReportSchedule SET enabled = ${enabled ? 1 : 0} WHERE id = ${id}
  `;
  if (updated === 0) throw new HttpError(404, 'Report schedule not found');
  const row = await getScheduleRow(id);
  if (!row) throw new HttpError(500, 'Report schedule update failed');
  return toReportScheduleDTO(row);
}

export async function deleteReportSchedule(id: string): Promise<void> {
  const deleted = await db.$executeRaw`DELETE FROM ReportSchedule WHERE id = ${id}`;
  if (deleted === 0) throw new HttpError(404, 'Report schedule not found');
}

/** Audit-trail rows kept per deployment (v2.5; newest-first prune). */
export const SCHEDULE_RUNS_KEEP = 50;

export interface ScheduleRunRow {
  id: string;
  scheduleId: string;
  label: string;
  trigger: string;
  startedAt: Date | string;
  durationMs: number | unknown;
  success: number | unknown;
  reportId: string | null;
  fileName: string | null;
  fileSize: number | unknown;
  error: string | null;
}

function toScheduleRunDTO(row: ScheduleRunRow): ScheduleRunDTO {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    label: row.label,
    trigger: row.trigger === 'manual' ? 'manual' : 'due',
    startedAt: toIso(row.startedAt) ?? new Date().toISOString(),
    durationMs: Number(row.durationMs ?? 0),
    success: Boolean(row.success),
    reportId: row.reportId,
    fileName: row.fileName,
    fileSize: row.fileSize === null || row.fileSize === undefined ? null : Number(row.fileSize),
    error: row.error,
  };
}

/** Newest schedule firings (audit trail, v2.5). */
export async function listScheduleRuns(limit = 8): Promise<ScheduleRunDTO[]> {
  const rows = (await db.$queryRaw`
    SELECT id, scheduleId, label, trigger, startedAt, durationMs, success,
           reportId, fileName, fileSize, error
    FROM ScheduleRun
    ORDER BY startedAt DESC
    LIMIT ${limit}
  `) as ScheduleRunRow[];
  return rows.map(toScheduleRunDTO);
}

/** Keep the audit trail bounded: newest SCHEDULE_RUNS_KEEP, delete the rest. */
async function pruneScheduleRuns(): Promise<void> {
  await db.$executeRaw`
    DELETE FROM ScheduleRun WHERE id NOT IN (
      SELECT id FROM ScheduleRun ORDER BY startedAt DESC LIMIT ${SCHEDULE_RUNS_KEEP}
    )
  `;
}

/**
 * Record one firing (success or failure) in the audit trail. Label is
 * snapshotted from the schedule row so history survives renames/deletes.
 */
async function recordScheduleRun(params: {
  scheduleId: string;
  label: string;
  trigger: 'due' | 'manual';
  startedAt: Date;
  durationMs: number;
  reportId?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  error?: string | null;
}): Promise<void> {
  const errText = params.error ? params.error.split('\n')[0].slice(0, 300) : null;
  await db.$executeRaw`
    INSERT INTO ScheduleRun
      (id, scheduleId, label, trigger, startedAt, durationMs, success, reportId, fileName, fileSize, error, createdAt)
    VALUES
      (${newId()}, ${params.scheduleId}, ${params.label}, ${params.trigger},
       ${params.startedAt}, ${Math.max(0, Math.round(params.durationMs))},
       ${params.error ? 0 : 1}, ${params.reportId ?? null}, ${params.fileName ?? null},
       ${params.fileSize ?? null}, ${errText}, ${new Date()})
  `;
  await pruneScheduleRuns().catch(() => undefined);
}

/**
 * Fire one schedule's report pipeline immediately (generatedBy 'scheduled')
 * and advance lastRunAt. Used by the engine's due-check AND the UI's
 * "Run now" button — the exact same code path either way. v2.5: every firing
 * (success or failure) lands in the ScheduleRun audit trail.
 */
export async function runReportSchedule(id: string, trigger: 'due' | 'manual' = 'due'): Promise<ReportScheduleDTO> {
  const row = await getScheduleRow(id);
  if (!row) throw new HttpError(404, 'Report schedule not found');

  const startedAt = new Date();
  const t0 = performance.now();
  const kind = (row.kind ?? 'executive') as 'executive' | 'statement';
  const language = (row.language ?? 'en') as 'en' | 'fa';
  try {
    if (kind === 'statement' && !row.tenantId) {
      throw new HttpError(500, `Schedule '${row.label}' produces a statement but has no tenant scope`);
    }
    const report = await generateSlaReport({
      kind,
      language,
      tenantId: row.tenantId ?? null,
      generatedBy: 'scheduled',
      generatedByName: `schedule: ${row.label}`,
    });
    await recordScheduleRun({
      scheduleId: id,
      label: row.label,
      trigger,
      startedAt,
      durationMs: performance.now() - t0,
      reportId: report.id,
      fileName: report.fileName,
      fileSize: report.fileSize,
    });
    const updated = await db.$executeRaw`
      UPDATE ReportSchedule
      SET lastRunAt = ${new Date(report.generatedAt)}
      WHERE id = ${id}
    `;
    if (updated === 0) throw new HttpError(404, 'Report schedule not found');
    const after = await getScheduleRow(id);
    if (!after) throw new HttpError(500, 'Report schedule run failed');
    return toReportScheduleDTO(after);
  } catch (err) {
    // Failed firings are part of the audit trail too (they answer "did the
    // 08:00 digest actually go out?"). Re-throw for the caller to map.
    await recordScheduleRun({
      scheduleId: id,
      label: row.label,
      trigger,
      startedAt,
      durationMs: performance.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    throw err;
  }
}

/**
 * Engine hook: run every schedule whose latest due instant has passed since
 * its last run. Returns the number of reports generated (0 most ticks), or
 * null when another replica holds the scheduler lock two
 * replicas must never double-generate). Missed due instants fire exactly
 * once (catch-up semantics).
 */
export async function runDueReportSchedules(now = new Date()): Promise<number | null> {
  return withSchedulerLock('report-schedules', async () => {
    const rows = (await db.$queryRaw`
    SELECT id, label, frequency, dayOfWeek, dayOfMonth, hour, periodHours,
           tenantId, enabled, lastRunAt, createdAt
    FROM ReportSchedule
    WHERE enabled = TRUE
  `) as ReportScheduleRow[];

    let generated = 0;
    for (const row of rows) {
      const due = lastDueInstant(row, now);
      if (!due) continue;
      const lastRunMs = row.lastRunAt
        ? new Date(row.lastRunAt instanceof Date ? row.lastRunAt : String(row.lastRunAt)).getTime()
        : 0;
      if (Number.isNaN(lastRunMs) || lastRunMs >= due.getTime()) continue;
      try {
        await runReportSchedule(row.id);
        generated += 1;
        console.log(`[sentinel:schedules] due run fired: ${row.label} (${row.frequency})`);
      } catch (err) {
        // one failing schedule must never break the tick loop
        console.error(`[sentinel:schedules] run failed for '${row.label}':`, err);
      }
    }
    return generated;
  });
}

// ── seeding (demo schedule so the UI never renders empty) ────────────────────

let seeded = false;

/** Seed one weekly fleet digest + one monthly tenant digest (idempotent). */
export async function ensureScheduleSeeded(): Promise<void> {
  if (seeded) return;
  const existing = (await db.$queryRaw`
    SELECT COUNT(*) AS n FROM ReportSchedule
  `) as { n: number | unknown }[];
  if (Number(existing[0]?.n ?? 0) === 0) {
    const now = new Date(); // Date param → ORM-native storage
    // Pick a real tenant row so the monthly per-client digest has a valid scope.
    const tenants = (await db.$queryRaw`
      SELECT id FROM Tenant ORDER BY createdAt ASC LIMIT 1
    `) as { id: string }[];
    const tenantId = tenants.length > 0 ? tenants[0].id : null;
    await db.$executeRaw`
      INSERT INTO ReportSchedule
        (id, label, frequency, dayOfWeek, dayOfMonth, hour, periodHours, tenantId, enabled, lastRunAt, createdAt)
      VALUES
        (${newId()}, 'Weekly board digest', 'weekly', 1, NULL, 8, 24, NULL, 1, NULL, ${now}),
        (${newId()}, 'Monthly client digest', 'monthly', NULL, 1, 9, 24, ${tenantId}, 1, NULL, ${now})
    `;
  }
  seeded = true;
}

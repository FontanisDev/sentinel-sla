// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA — report data snapshots.
//
// One snapshot builder per report template. A snapshot is the COMPLETE data
// a report shows — plain JSON, no presentation. The SHA-256 over its
// canonical form is printed in the title block so any later alteration of
// the numbers is detectable against the archived row (tamper-evident).
//
// Rules:
//   • no invented numbers — every figure traces to DB rows + the pure domain
//     functions (same primitives the /contracts page uses);
//   • the same snapshot feeds EN and FA — language is presentation only and
//     never changes the hash;
//   • the snapshot EXCLUDES generation metadata (who/when rendered) — the
//     hash pins the data, not the print event.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'crypto';
import {
  JALALI_MONTHS_EN,
  JALALI_MONTHS_FA,
  jalaliToGregorian,
} from '@/lib/jalali';
import {
  jalaliMonthWindow,
  overlapSec,
  type MonthWindow,
} from '@/server/contracts';
import type { ContractServiceRow } from '@/lib/types';

// ── hash plumbing ───────────────────────────────────────────────────────────

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/** SHA-256 hex of the canonical snapshot form — the title-block fingerprint. */
export function snapshotHash(snapshot: unknown): string {
  return createHash('sha256').update(canonicalJson(snapshot), 'utf-8').digest('hex');
}

// ── shared shapes ───────────────────────────────────────────────────────────

export type ReportLanguage = 'en' | 'fa';
export type ReportKind = 'executive' | 'statement' | 'incident';

export interface SnapshotWindow {
  start: string; // ISO
  end: string; // ISO
  jy: number;
  jm: number;
  labelEn: string;
  labelFa: string;
  lengthSec: number;
  /** true when the window is still open (month-to-date reports) */
  partial: boolean;
}

export function windowOf(win: MonthWindow, now: Date): SnapshotWindow {
  return {
    start: win.start.toISOString(),
    end: win.end.toISOString(),
    jy: win.jy,
    jm: win.jm,
    labelEn: `${JALALI_MONTHS_EN[win.jm - 1]} ${win.jy}`,
    labelFa: `${JALALI_MONTHS_FA[win.jm - 1]} ${win.jy}`,
    lengthSec: win.lengthSec,
    partial: now.getTime() < win.end.getTime(),
  };
}

export interface ExecutiveSnapshot {
  kind: 'executive';
  window: SnapshotWindow;
  scopeTenant: { id: string; name: string; nameFa: string | null } | null;
  headline: {
    penaltyToDateTomans: number;
    projectedPenaltyTomans: number | null;
    revenueLossTomans: number;
    downtimeSec: number;
    incidentsCount: number;
    servicesTotal: number;
    servicesCompliant: number;
    breaches: number;
  };
  /** per-client aggregation for the SLA-compliance table (fleet view) */
  clients: Array<{
    tenantId: string | null;
    tenantName: string | null;
    tenantNameFa: string | null;
    servicesTotal: number;
    compliant: number;
    breaches: number;
    penaltyToDateTomans: number;
    worstAvailabilityPct: number | null;
  }>;
  /** the same per-service rows the /contracts page shows (one source of truth) */
  perService: ContractServiceRow[];
  worstIncidents: Array<{
    id: string;
    serviceName: string;
    serviceNameFa: string | null;
    severity: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
    durationSec: number;
    penaltyTomans: number;
    revenueLossTomans: number;
    lostTransactions: number;
  }>;
  /** three fixed spans of the Jalali month (days 1–10 / 11–20 / 21–end) */
  trend: Array<{
    labelEn: string;
    labelFa: string;
    start: string;
    end: string;
    penaltyTomans: number;
    downtimeSec: number;
    incidents: number;
  }>;
  risk: {
    projectedPenaltyTomans: number | null;
    /** services to watch: highest projected (or accrued, when not projectable) */
    watchServices: Array<{
      serviceKey: string;
      serviceName: string;
      serviceNameFa: string | null;
      penaltyToDateTomans: number;
      projectedPenaltyTomans: number | null;
      targetPct: number;
      availabilityPct: number | null;
      compliance: string;
    }>;
  };
}

export interface TrendBucket {
  labelEn: string;
  labelFa: string;
  start: Date;
  end: Date;
}

/**
 * Thirds of a Jalali month by day number: 1–10, 11–20, 21–end. Pure.
 * Persian reporting convention (دههٔ ماه) — honest fixed spans, no rounding.
 */
export function jalaliMonthThirds(win: MonthWindow): TrendBucket[] {
  const second = jalaliToGregorian(win.jy, win.jm, 11);
  const third = jalaliToGregorian(win.jy, win.jm, 21);
  return [
    {
      labelEn: 'Days 1–10',
      labelFa: 'روزهای ۱ تا ۱۰',
      start: win.start,
      end: second,
    },
    {
      labelEn: 'Days 11–20',
      labelFa: 'روزهای ۱۱ تا ۲۰',
      start: second,
      end: third,
    },
    {
      labelEn: 'Days 21–end',
      labelFa: 'روزهای ۲۱ تا پایان ماه',
      start: third,
      end: win.end,
    },
  ];
}

/**
 * Merge overlapping [start, end) intervals so union sums never double-count.
 * Pure; used for planned-maintenance exclusion coverage. Returns seconds of
 * the union overlapping [winStartMs, winEndMs).
 */
export function unionOverlapSec(
  intervals: Array<{ startMs: number; endMs: number }>,
  winStartMs: number,
  winEndMs: number,
): number {
  const clipped = intervals
    .map((iv) => ({ s: Math.max(iv.startMs, winStartMs), e: Math.min(iv.endMs, winEndMs) }))
    .filter((iv) => iv.e > iv.s)
    .sort((a, b) => a.s - b.s);
  let total = 0;
  let curS: number | null = null;
  let curE: number | null = null;
  for (const iv of clipped) {
    if (curS === null || curE === null) {
      curS = iv.s;
      curE = iv.e;
    } else if (iv.s <= curE) {
      curE = Math.max(curE, iv.e);
    } else {
      total += curE - curS;
      curS = iv.s;
      curE = iv.e;
    }
  }
  if (curS !== null && curE !== null) total += curE - curS;
  return Math.round(total / 1000);
}

// ── statement shapes ────────────────────────────────────────────────────────

export type OutageCategory = 'chargeable' | 'planned-covered';

export interface StatementSnapshot {
  kind: 'statement';
  window: SnapshotWindow;
  contract: {
    tenantId: string;
    tenantName: string;
    tenantNameFa: string | null;
    services: Array<{
      serviceId: string;
      serviceKey: string;
      serviceName: string;
      serviceNameFa: string | null;
      slaTargetPct: number;
      availabilityNaivePct: number | null;
      availabilityContractualPct: number | null;
      downtimeTotalSec: number;
      downtimeExcludedSec: number;
      downtimeChargeableSec: number;
      penaltyDueTomans: number;
      compliance: 'compliant' | 'breach' | 'pending';
    }>;
  };
  outages: Array<{
    id: string;
    serviceName: string;
    serviceNameFa: string | null;
    severity: string;
    category: OutageCategory;
    startedAt: string;
    endedAt: string | null;
    durationSec: number;
    chargeableSec: number;
    excludedSec: number;
    penaltyTomans: number;
    lostTransactions: number;
    evidence: string;
  }>;
  plannedWindows: Array<{
    reason: string;
    startAt: string;
    endAt: string;
    serviceScope: string; // service names or "fleet-wide"
  }>;
  totals: {
    penaltyDueTomans: number;
    downtimeChargeableSec: number;
    downtimeExcludedSec: number;
    outagesCount: number;
  };
}

// ── incident shapes ─────────────────────────────────────────────────────────

export interface IncidentSnapshot {
  kind: 'incident';
  incident: {
    id: string;
    status: string;
    severity: string;
    source: string;
    startedAt: string;
    detectedAt: string | null;
    acknowledgedAt: string | null;
    acknowledgedBy: string | null;
    escalatedAt: string | null;
    escalatedTo: string | null;
    resolvedAt: string | null;
    mttdSec: number | null;
    mttaSec: number | null;
    mttrSec: number | null;
    durationSec: number | null;
    lostTransactions: number;
    revenueLossTomans: number;
    penaltyTomans: number;
  };
  service: {
    id: string;
    key: string;
    name: string;
    nameFa: string | null;
    tier: string;
    slaTargetPct: number;
  };
  tenant: { id: string; name: string; nameFa: string | null } | null;
  moneyModel: {
    penaltyBaseTomans: number;
    penaltyPerMinuteTomans: number;
    weightPct: number;
    billedMinutes: number | null;
    tps: number;
    avgTransactionValueTomans: number;
    formulaTomans: string; // concrete substitution with the real inputs
  };
  timeline: Array<{ ts: string; event: string; detail: string }>;
  postMortem: { source: 'llm' | 'heuristic' | null; text: string | null };
  /** rule-based cause-hypothesis candidates (localized by the template) */
  hypotheses: Array<{ key: string; endpoint: string; tier: string }>;
}

// ═══════════════════════════════════════════════════════════════════════
// Server query wrappers — build the snapshots from real DB rows.
// Every number below traces to either the incident LEDGER (the exact
// figures the UI shows) or the same pure domain functions /contracts uses.
// ═══════════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getTenantById } from '@/server/tenants';
import { buildContractRows, type ContractIncidentInput, type ContractServiceInput, type ContractWindowInput } from '@/server/contracts';
import { parseIncidentEvents, faultHypothesisKeys } from '@/server/postmortem';

const CLIP_NOW = (win: MonthWindow, now: Date): number => Math.min(now.getTime(), win.end.getTime());

function parseEvents(raw: string): Array<{ ts: string; event: string; detail: string }> {
  return parseIncidentEvents(raw ?? '[]').map((e) => ({
    ts: new Date(e.ts as unknown as string | number | Date).toISOString(),
    event: e.event ?? '',
    detail: e.detail ?? '',
  }));
}

/** Executive monthly snapshot for a tenant scope (null = fleet-wide). */
export async function getExecutiveSnapshot(
  tenantId: string | null,
): Promise<ExecutiveSnapshot> {
  const now = new Date();
  const win = jalaliMonthWindow(now);
  const nowMs = CLIP_NOW(win, now);
  const winStart = win.start.getTime();

  const [scopeTenant, services, incidents, maintenance] = await Promise.all([
    tenantId ? getTenantById(tenantId) : Promise.resolve(null),
    db.service.findMany({
      where: tenantId ? { tenantId } : {},
      include: { tenant: true },
      orderBy: { key: 'asc' },
    }),
    db.incident.findMany({
      where: {
        ...(tenantId ? { service: { tenantId } } : {}),
        startedAt: { lt: win.end },
        OR: [{ status: 'ongoing' }, { resolvedAt: { gt: win.start } }],
      },
      include: { service: true },
      orderBy: { startedAt: 'asc' },
    }),
    db.maintenanceWindow.findMany({
      where: {
        status: { not: 'cancelled' },
        startAt: { lt: win.end },
        endAt: { gt: win.start },
        ...(tenantId ? { OR: [{ tenantId }, { tenantId: null }] } : {}),
      },
      orderBy: { startAt: 'asc' },
    }),
  ]);

  const inputs: ContractServiceInput[] = services.map((s) => ({
    id: s.id,
    key: s.key,
    name: s.name,
    nameFa: s.nameFa,
    tenantId: s.tenantId,
    tenantName: s.tenant?.name ?? null,
    tenantNameFa: s.tenant?.nameFa ?? null,
    slaTarget: s.slaTarget,
    penaltyBase: s.penaltyBase,
    penaltyPerMinute: s.penaltyPerMinute,
  }));
  const incidentInputs: ContractIncidentInput[] = incidents.map((i) => ({
    id: i.id,
    serviceId: i.serviceId,
    status: i.status,
    severity: i.severity,
    startedAt: i.startedAt,
    resolvedAt: i.resolvedAt,
    penaltyTomans: i.penaltyTomans,
  }));
  const windowInputs: ContractWindowInput[] = maintenance.map((w) => ({
    id: w.id,
    serviceId: w.serviceId,
    startAt: w.startAt,
    endAt: w.endAt,
  }));

  const perService = buildContractRows(inputs, incidentInputs, windowInputs, now);

  // headline money — downtime counted as window overlap, money as ledger sums
  let downtimeSec = 0;
  for (const inc of incidents) {
    const endMs =
      inc.status === 'resolved' && inc.resolvedAt ? inc.resolvedAt.getTime() : nowMs;
    downtimeSec += overlapSec(inc.startedAt.getTime(), endMs, winStart, nowMs);
  }
  const revenueLossTomans = incidents.reduce(
    (acc, i) => acc + Math.round(i.revenueLossTomans),
    0,
  );
  const penaltyToDateTomans = perService.reduce((acc, r) => acc + r.penaltyToDate, 0);
  const projectionsComplete =
    perService.length > 0 && perService.every((r) => r.projectedPenalty !== null);
  const projectedPenaltyTomans =
    projectionsComplete
      ? perService.reduce((acc, r) => acc + (r.projectedPenalty ?? 0), 0)
      : null;

  // per-client compliance aggregation
  const clientMap = new Map<string, ExecutiveSnapshot['clients'][number]>();
  for (const r of perService) {
    const key = r.tenantId ?? '(unassigned)';
    const entry = clientMap.get(key) ?? {
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      tenantNameFa: r.tenantNameFa,
      servicesTotal: 0,
      compliant: 0,
      breaches: 0,
      penaltyToDateTomans: 0,
      worstAvailabilityPct: null as number | null,
    };
    entry.servicesTotal += 1;
    if (r.compliance === 'compliant') entry.compliant += 1;
    if (r.compliance === 'breach') entry.breaches += 1;
    entry.penaltyToDateTomans += r.penaltyToDate;
    if (r.availabilityPct !== null) {
      entry.worstAvailabilityPct =
        entry.worstAvailabilityPct === null
          ? r.availabilityPct
          : Math.min(entry.worstAvailabilityPct, r.availabilityPct);
    }
    clientMap.set(key, entry);
  }

  // worst incidents (ledger figures, whole-incident money)
  const worstIncidents = [...incidents]
    .sort((a, b) => b.penaltyTomans - a.penaltyTomans)
    .slice(0, 5)
    .map((i) => ({
      id: i.id,
      serviceName: i.service.name,
      serviceNameFa: i.service.nameFa,
      severity: i.severity,
      status: i.status,
      startedAt: i.startedAt.toISOString(),
      endedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
      durationSec:
        i.durationSec ??
        (i.resolvedAt
          ? Math.round((i.resolvedAt.getTime() - i.startedAt.getTime()) / 1000)
          : Math.round((nowMs - i.startedAt.getTime()) / 1000)),
      penaltyTomans: Math.round(i.penaltyTomans),
      revenueLossTomans: Math.round(i.revenueLossTomans),
      lostTransactions: i.lostTransactions,
    }));

  // trend across the month thirds — penalty attributed to the bucket holding
  // the incident START (ledger figure stays whole), downtime by overlap.
  const trend = jalaliMonthThirds(win).map((b) => {
    const bStart = b.start.getTime();
    const bEnd = Math.min(b.end.getTime(), win.end.getTime());
    let penaltyTomans = 0;
    let bucketDowntime = 0;
    let count = 0;
    for (const inc of incidents) {
      const endMs =
        inc.status === 'resolved' && inc.resolvedAt ? inc.resolvedAt.getTime() : nowMs;
      bucketDowntime += overlapSec(inc.startedAt.getTime(), endMs, bStart, bEnd);
      if (inc.startedAt.getTime() >= bStart && inc.startedAt.getTime() < bEnd) {
        count += 1;
        penaltyTomans += Math.round(inc.penaltyTomans);
      }
    }
    return {
      labelEn: b.labelEn,
      labelFa: b.labelFa,
      start: b.start.toISOString(),
      end: b.end.toISOString(),
      penaltyTomans,
      downtimeSec: bucketDowntime,
      incidents: count,
    };
  });

  // risk — the honest projection + the services driving it
  const watchServices = [...perService]
    .sort(
      (a, b) =>
        (b.projectedPenalty ?? b.penaltyToDate) - (a.projectedPenalty ?? a.penaltyToDate),
    )
    .slice(0, 3)
    .map((r) => ({
      serviceKey: r.serviceKey,
      serviceName: r.serviceName,
      serviceNameFa: r.serviceNameFa,
      penaltyToDateTomans: r.penaltyToDate,
      projectedPenaltyTomans: r.projectedPenalty,
      targetPct: r.targetPct,
      availabilityPct: r.availabilityPct,
      compliance: r.compliance,
    }));

  return {
    kind: 'executive',
    window: windowOf(win, now),
    scopeTenant: scopeTenant
      ? { id: scopeTenant.id, name: scopeTenant.name, nameFa: scopeTenant.nameFa }
      : null,
    headline: {
      penaltyToDateTomans,
      projectedPenaltyTomans,
      revenueLossTomans,
      downtimeSec,
      incidentsCount: incidents.length,
      servicesTotal: perService.length,
      servicesCompliant: perService.filter((r) => r.compliance === 'compliant').length,
      breaches: perService.filter((r) => r.compliance === 'breach').length,
    },
    clients: [...clientMap.values()].sort((a, b) =>
      (a.tenantName ?? '').localeCompare(b.tenantName ?? ''),
    ),
    perService,
    worstIncidents,
    trend,
    risk: { projectedPenaltyTomans, watchServices },
  };
}

/** Client SLA statement for ONE tenant (the per-contract statement). */
export async function getStatementSnapshot(
  tenantId: string,
): Promise<StatementSnapshot | null> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) return null;

  const now = new Date();
  const win = jalaliMonthWindow(now);
  const nowMs = CLIP_NOW(win, now);
  const winStart = win.start.getTime();

  const [services, incidents, maintenance] = await Promise.all([
    db.service.findMany({
      where: { tenantId: tenant.id },
      orderBy: { key: 'asc' },
    }),
    db.incident.findMany({
      where: {
        service: { tenantId: tenant.id },
        startedAt: { lt: win.end },
        OR: [{ status: 'ongoing' }, { resolvedAt: { gt: win.start } }],
      },
      include: { service: true },
      orderBy: { startedAt: 'desc' },
    }),
    db.maintenanceWindow.findMany({
      where: {
        status: { not: 'cancelled' },
        startAt: { lt: win.end },
        endAt: { gt: win.start },
        OR: [{ tenantId: tenant.id }, { tenantId: null }],
      },
      orderBy: { startAt: 'asc' },
    }),
  ]);

  const inputs: ContractServiceInput[] = services.map((s) => ({
    id: s.id,
    key: s.key,
    name: s.name,
    nameFa: s.nameFa,
    tenantId: s.tenantId,
    tenantName: tenant.name,
    tenantNameFa: tenant.nameFa,
    slaTarget: s.slaTarget,
    penaltyBase: s.penaltyBase,
    penaltyPerMinute: s.penaltyPerMinute,
  }));
  const rows = buildContractRows(
    inputs,
    incidents.map((i) => ({
      id: i.id,
      serviceId: i.serviceId,
      status: i.status,
      severity: i.severity,
      startedAt: i.startedAt,
      resolvedAt: i.resolvedAt,
      penaltyTomans: i.penaltyTomans,
    })),
    maintenance.map((w) => ({
      id: w.id,
      serviceId: w.serviceId,
      startAt: w.startAt,
      endAt: w.endAt,
    })),
    now,
  );
  const rowByService = new Map(rows.map((r) => [r.serviceId, r]));

  // planned-exclusion seconds per service (union of covering windows)
  const windowsFor = (serviceId: string): Array<{ startMs: number; endMs: number }> =>
    maintenance
      .filter((w) => w.serviceId === null || w.serviceId === serviceId)
      .map((w) => ({ startMs: w.startAt.getTime(), endMs: w.endAt.getTime() }));

  const serviceRows = services.map((s) => {
    const row = rowByService.get(s.id);
    const downtimeTotalSec = row?.downtimeSec ?? 0;
    const excludedSec = unionOverlapSec(windowsFor(s.id), winStart, nowMs);
    const chargeable = Math.max(0, downtimeTotalSec - excludedSec);
    const elapsedSec = row?.elapsedSec ?? Math.max(0, Math.round((nowMs - winStart) / 1000));
    const availabilityContractualPct =
      elapsedSec > 0 ? Math.max(0, ((elapsedSec - chargeable) / elapsedSec) * 100) : null;
    return {
      serviceId: s.id,
      serviceKey: s.key,
      serviceName: s.name,
      serviceNameFa: s.nameFa,
      slaTargetPct: s.slaTarget * 100,
      availabilityNaivePct: row?.availabilityPct ?? null,
      availabilityContractualPct,
      downtimeTotalSec,
      downtimeExcludedSec: excludedSec,
      downtimeChargeableSec: chargeable,
      penaltyDueTomans: row?.penaltyToDate ?? 0,
      compliance: row?.compliance ?? ('pending' as const),
    };
  });

  // per-outage detail — category from planned coverage of the outage overlap
  const outages = incidents.map((i) => {
    const endMs =
      i.status === 'resolved' && i.resolvedAt ? i.resolvedAt.getTime() : nowMs;
    const clip = overlapSec(i.startedAt.getTime(), endMs, winStart, nowMs);
    const covered = unionOverlapSec(
      windowsFor(i.serviceId).map((w) => ({
        startMs: Math.max(w.startMs, i.startedAt.getTime()),
        endMs: Math.min(w.endMs, endMs),
      })),
      winStart,
      nowMs,
    );
    const chargeableSec = Math.max(0, clip - covered);
    const eventsCount = parseEvents(i.events).length;
    return {
      id: i.id,
      serviceName: i.service.name,
      serviceNameFa: i.service.nameFa,
      severity: i.severity,
      category: (chargeableSec <= 0 && clip > 0
        ? 'planned-covered'
        : 'chargeable') as OutageCategory,
      startedAt: i.startedAt.toISOString(),
      endedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
      durationSec: clip,
      chargeableSec,
      excludedSec: covered,
      penaltyTomans: Math.round(i.penaltyTomans),
      lostTransactions: i.lostTransactions,
      evidence: `${i.source} · ${eventsCount} ev${i.evidence ? ' · probe samples recorded' : ''}`,
    };
  });

  const plannedWindows = maintenance.map((w) => ({
    reason: w.reason,
    startAt: w.startAt.toISOString(),
    endAt: w.endAt.toISOString(),
    serviceScope:
      w.serviceId === null
        ? 'fleet-wide'
        : services.find((s) => s.id === w.serviceId)?.name ?? w.serviceId,
  }));

  return {
    kind: 'statement',
    window: windowOf(win, now),
    contract: {
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantNameFa: tenant.nameFa,
      services: serviceRows,
    },
    outages,
    plannedWindows,
    totals: {
      penaltyDueTomans: serviceRows.reduce((acc, r) => acc + r.penaltyDueTomans, 0),
      downtimeChargeableSec: serviceRows.reduce((acc, r) => acc + r.downtimeChargeableSec, 0),
      downtimeExcludedSec: serviceRows.reduce((acc, r) => acc + r.downtimeExcludedSec, 0),
      outagesCount: outages.length,
    },
  };
}

/** Incident report snapshot for ONE incident; null when unknown. */
export async function getIncidentSnapshot(
  incidentId: string,
): Promise<IncidentSnapshot | null> {
  const inc = await db.incident.findUnique({
    where: { id: incidentId },
    include: { service: { include: { tenant: true } } },
  });
  if (!inc) return null;

  const svc = inc.service;
  const durationSec =
    inc.durationSec ??
    (inc.resolvedAt
      ? Math.round((inc.resolvedAt.getTime() - inc.startedAt.getTime()) / 1000)
      : null);
  const weightPct = inc.severity === 'warning' ? 30 : 100;
  const billedMinutes = durationSec !== null ? Math.max(1, Math.ceil(durationSec / 60)) : null;
  const penaltyBase = Math.round(svc.penaltyBase);
  const penaltyPerMinute = Math.round(svc.penaltyPerMinute);
  const formulaTomans =
    billedMinutes !== null
      ? `penalty = ${penaltyBase.toLocaleString('en-US')} + ${penaltyPerMinute.toLocaleString('en-US')} `
        + `× ${billedMinutes} min × ${weightPct}% = ${Math.round(inc.penaltyTomans).toLocaleString('en-US')} T`
      : 'penalty accrues until the incident resolves (ongoing)';
  const revenueLossFormula =
    `${inc.lostTransactions.toLocaleString('en-US')} lost tx × ${svc.avgTransactionValue.toLocaleString('en-US')} T `
    + `= ${Math.round(inc.revenueLossTomans).toLocaleString('en-US')} T`;

  return {
    kind: 'incident',
    incident: {
      id: inc.id,
      status: inc.status,
      severity: inc.severity,
      source: inc.source,
      startedAt: inc.startedAt.toISOString(),
      detectedAt: inc.detectedAt ? inc.detectedAt.toISOString() : null,
      acknowledgedAt: inc.acknowledgedAt ? inc.acknowledgedAt.toISOString() : null,
      acknowledgedBy: inc.acknowledgedBy,
      escalatedAt: inc.escalatedAt ? inc.escalatedAt.toISOString() : null,
      escalatedTo: inc.escalatedTo,
      resolvedAt: inc.resolvedAt ? inc.resolvedAt.toISOString() : null,
      mttdSec: inc.mttdSec,
      mttaSec: inc.mttaSec,
      mttrSec: inc.mttrSec,
      durationSec,
      lostTransactions: inc.lostTransactions,
      revenueLossTomans: Math.round(inc.revenueLossTomans),
      penaltyTomans: Math.round(inc.penaltyTomans),
    },
    service: {
      id: svc.id,
      key: svc.key,
      name: svc.name,
      nameFa: svc.nameFa,
      tier: svc.tier,
      slaTargetPct: svc.slaTarget * 100,
    },
    tenant: svc.tenant
      ? { id: svc.tenant.id, name: svc.tenant.name, nameFa: svc.tenant.nameFa }
      : null,
    moneyModel: {
      penaltyBaseTomans: penaltyBase,
      penaltyPerMinuteTomans: penaltyPerMinute,
      weightPct,
      billedMinutes,
      tps: svc.tps,
      avgTransactionValueTomans: svc.avgTransactionValue,
      formulaTomans: `${formulaTomans}  |  revenue loss = ${revenueLossFormula}`,
    },
    timeline: parseEvents(inc.events),
    postMortem:
      inc.aiSummary && inc.aiSummary.trim()
        ? {
            source: (inc.aiSource === 'llm' ? 'llm' : 'heuristic') as 'llm' | 'heuristic',
            text: inc.aiSummary,
          }
        : { source: null, text: null },
    hypotheses: faultHypothesisKeys(inc.severity).map((key) => ({
      key,
      endpoint: svc.endpoint,
      tier: svc.tier,
    })),
  };
}

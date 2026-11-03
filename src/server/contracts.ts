// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA — contract compliance view.
//
// The runtime SLA record is the incident ledger (Service.penaltyBase /
// penaltyPerMinute are the contractual scheme fields, Service.slaTarget the
// contractual target). This module derives, per service and per CLIENT:
//
//   • the measurement window — the current Jalali month (the domain default
//     `WindowKind = 'jalali-month'`; the product is Persian-first),
//   • chargeable downtime inside the window (incidents clipped to
//     [windowStart, now], resolved AND ongoing),
//   • measured availability = (elapsed − downtime) ÷ elapsed,
//   • penalty accrued to date — the LEDGER's stored penaltyTomans for
//     incidents fully inside the window (the exact number the incident page
//     shows), the pure domain rule (penaltyFixedPerMinute, warning = 30 %)
//     recomputed for window-clipped or still-ongoing incidents,
//   • a linear projection of the penalty to the window end — honest formula,
//     surfaced in the UI popover, suppressed until 5 % of the month elapsed,
//   • planned maintenance windows overlapping the window — INFORMATIONAL
//     exclusions: pages are suppressed during planned work, the SLA record
//     itself is never altered (engine invariant since v2.1).
//
// No invented numbers: every figure traces to the DB rows + the pure domain
// functions, and the UI exposes the formula + inputs via FormulaPopover.
// ═══════════════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import {
  gregorianToJalali,
  jalaliToGregorian,
  jalaliMonthLength,
  JALALI_MONTHS_EN,
  JALALI_MONTHS_FA,
} from '@/lib/jalali';
import { penaltyFixedPerMinute } from '@/domain/contract';
import type { ContractServiceRow, ContractsSnapshotDTO } from '@/lib/types';

// ── pure window math (unit-tested) ──────────────────────────────────────────

/** The current Jalali month as concrete instant bounds [start, end). */
export interface MonthWindow {
  start: Date;
  end: Date;
  jy: number;
  jm: number;
  lengthSec: number;
}

export function jalaliMonthWindow(now: Date): MonthWindow {
  const { jy, jm } = gregorianToJalali(now);
  const start = jalaliToGregorian(jy, jm, 1);
  const nm = jm === 12 ? 1 : jm + 1;
  const ny = jm === 12 ? jy + 1 : jy;
  const end = jalaliToGregorian(ny, nm, 1);
  return { start, end, jy, jm, lengthSec: Math.round((end.getTime() - start.getTime()) / 1000) };
}

/**
 * Seconds of [incStartMs, incEndMs) overlapping [winStartMs, winEndMs).
 * incEndMs may be null (ongoing) — the caller resolves it to `now`.
 */
export function overlapSec(
  incStartMs: number,
  incEndMs: number | null,
  winStartMs: number,
  winEndMs: number,
): number {
  const s = Math.max(incStartMs, winStartMs);
  const e = Math.min(incEndMs ?? winEndMs, winEndMs);
  if (e <= s) return 0;
  return Math.round((e - s) / 1000);
}

/**
 * Linear projection of the accrued penalty to the window end. Returns null
 * until 5 % of the window elapsed — a projection from minutes-old data would
 * be noise dressed as a number.
 */
export function projectPenalty(
  penaltyToDate: number,
  elapsedSec: number,
  lengthSec: number,
  minFraction = 0.05,
): number | null {
  if (lengthSec <= 0 || elapsedSec <= 0) return null;
  const fraction = elapsedSec / lengthSec;
  if (fraction < minFraction) return null;
  return Math.round(penaltyToDate / fraction);
}

/** Compliance of one availability measurement against the target (percent). */
export type Compliance = 'compliant' | 'breach' | 'pending';

export function complianceOf(availabilityPct: number | null, targetPct: number): Compliance {
  if (availabilityPct === null) return 'pending';
  return availabilityPct >= targetPct ? 'compliant' : 'breach';
}

// ── pure row assembly (unit-tested; DB-shaped inputs) ──────────────────────

/** Minimal incident shape the builder needs (Prisma rows satisfy it). */
export interface ContractIncidentInput {
  id: string;
  serviceId: string;
  status: string; // ongoing | resolved
  severity: string; // critical | warning
  startedAt: Date;
  resolvedAt: Date | null;
  penaltyTomans: number;
}

/** Minimal maintenance-window shape (Prisma rows satisfy it). */
export interface ContractWindowInput {
  id: string;
  serviceId: string | null;
  startAt: Date;
  endAt: Date;
}

export interface ContractServiceInput {
  id: string;
  key: string;
  name: string;
  nameFa: string | null;
  tenantId: string | null;
  tenantName: string | null;
  tenantNameFa: string | null;
  slaTarget: number; // 0.999
  penaltyBase: number; // Tomans
  penaltyPerMinute: number; // Tomans
}

/**
 * Build the per-service contract rows. Pure: same inputs → same rows, so the
 * unit tests can pin every number the UI will show.
 */
export function buildContractRows(
  services: ContractServiceInput[],
  incidents: ContractIncidentInput[],
  maintenance: ContractWindowInput[],
  now: Date,
): ContractServiceRow[] {
  const win = jalaliMonthWindow(now);
  const winStart = win.start.getTime();
  const winEnd = win.end.getTime();
  const nowMs = Math.min(now.getTime(), winEnd); // never bill into the future
  const elapsedSec = Math.max(0, Math.round((nowMs - winStart) / 1000));

  const incidentsByService = new Map<string, ContractIncidentInput[]>();
  for (const inc of incidents) {
    const list = incidentsByService.get(inc.serviceId);
    if (list) list.push(inc);
    else incidentsByService.set(inc.serviceId, [inc]);
  }

  return services.map((svc) => {
    const rows = incidentsByService.get(svc.id) ?? [];
    let downtimeSec = 0;
    let penaltyToDate = 0;
    let incidentsCount = 0;

    for (const inc of rows) {
      const endMs =
        inc.status === 'resolved' && inc.resolvedAt
          ? inc.resolvedAt.getTime()
          : nowMs; // ongoing — accrues until now
      const clip = overlapSec(inc.startedAt.getTime(), endMs, winStart, nowMs);
      if (clip <= 0) continue;
      incidentsCount += 1;
      downtimeSec += clip;
      // Fully-contained resolved incidents carry the engine's own penalty —
      // the exact figure the ledger shows. Clipped or ongoing incidents are
      // recomputed with the SAME pure domain rule (warning = 30 % weight).
      const contained =
        inc.status === 'resolved' &&
        inc.startedAt.getTime() >= winStart &&
        endMs <= winEnd;
      if (contained) {
        penaltyToDate += Math.round(inc.penaltyTomans);
      } else {
        const weight = inc.severity === 'warning' ? 30 : 100;
        penaltyToDate += penaltyFixedPerMinute(
          Math.round(svc.penaltyBase),
          Math.round(svc.penaltyPerMinute),
          clip,
          weight,
        );
      }
    }

    const targetPct = svc.slaTarget * 100;
    const availabilityPct =
      elapsedSec > 0
        ? Math.max(0, ((elapsedSec - downtimeSec) / elapsedSec) * 100)
        : null;

    // Planned maintenance overlapping the window (informational exclusions).
    // Same matching rule as the engine's activeWindowsForService: a
    // fleet-wide window (serviceId null) covers every service.
    let plannedWindows = 0;
    let plannedSec = 0;
    for (const w of maintenance) {
      if (w.serviceId !== null && w.serviceId !== svc.id) continue;
      const clip = overlapSec(
        w.startAt.getTime(),
        w.endAt.getTime(),
        winStart,
        winEnd,
      );
      if (clip > 0) {
        plannedWindows += 1;
        plannedSec += clip;
      }
    }

    return {
      serviceId: svc.id,
      serviceKey: svc.key,
      serviceName: svc.name,
      serviceNameFa: svc.nameFa,
      tenantId: svc.tenantId,
      tenantName: svc.tenantName,
      tenantNameFa: svc.tenantNameFa,
      targetPct,
      penaltyBase: svc.penaltyBase,
      penaltyPerMinute: svc.penaltyPerMinute,
      downtimeSec,
      billedMinutes: downtimeSec > 0 ? Math.max(1, Math.ceil(downtimeSec / 60)) : 0,
      elapsedSec,
      availabilityPct,
      compliance: complianceOf(availabilityPct, targetPct),
      penaltyToDate,
      projectedPenalty: projectPenalty(penaltyToDate, elapsedSec, win.lengthSec),
      plannedWindows,
      plannedSec,
      incidentsCount,
    } satisfies ContractServiceRow;
  });
}

// ── server query wrapper ───────────────────────────────────────────────────

/** The full /contracts payload for a tenant scope (null = fleet-wide). */
export async function getContractsSnapshot(
  tenantId: string | null,
): Promise<ContractsSnapshotDTO> {
  const now = new Date();
  const win = jalaliMonthWindow(now);

  const [services, incidents, maintenance] = await Promise.all([
    db.service.findMany({
      where: tenantId ? { tenantId } : {},
      include: { tenant: true },
      orderBy: { key: 'asc' },
    }),
    db.incident.findMany({
      where: {
        ...(tenantId ? { service: { tenantId } } : {}),
        // anything that could overlap the window: started before it ends,
        // and (ongoing OR ended after it started)
        startedAt: { lt: win.end },
        OR: [{ status: 'ongoing' }, { resolvedAt: { gt: win.start } }],
      },
      orderBy: { startedAt: 'asc' },
    }),
    db.maintenanceWindow.findMany({
      // cancelled windows never excluded anything — drop them up front
      where: {
        status: { not: 'cancelled' },
        startAt: { lt: win.end },
        endAt: { gt: win.start },
        ...(tenantId ? { OR: [{ tenantId }, { tenantId: null }] } : {}),
      },
      orderBy: { startAt: 'asc' },
    }),
  ]);

  const rows = buildContractRows(
    services.map((s) => ({
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
    })),
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

  const elapsedSec = rows[0]?.elapsedSec ?? Math.round((now.getTime() - win.start.getTime()) / 1000);
  const breaches = rows.filter((r) => r.compliance === 'breach').length;
  const penaltyToDate = rows.reduce((acc, r) => acc + r.penaltyToDate, 0);
  const projectedSum = rows.reduce((acc, r) => acc + (r.projectedPenalty ?? 0), 0);
  const projectionsComplete = rows.every((r) => r.projectedPenalty !== null);
  const tenants = new Set(rows.map((r) => r.tenantId).filter(Boolean));

  return {
    window: {
      start: win.start.toISOString(),
      end: win.end.toISOString(),
      jy: win.jy,
      jm: win.jm,
      labelEn: `${JALALI_MONTHS_EN[win.jm - 1]} ${win.jy}`,
      labelFa: `${JALALI_MONTHS_FA[win.jm - 1]} ${win.jy}`,
      lengthSec: win.lengthSec,
    },
    generatedAt: now.toISOString(),
    elapsedSec,
    totals: {
      tenants: tenants.size,
      services: rows.length,
      breaches,
      penaltyToDate,
      projectedPenalty: projectionsComplete && rows.length > 0 ? projectedSum : null,
      plannedWindows: rows.reduce((acc, r) => acc + r.plannedWindows, 0),
    },
    rows,
  };
}

/**
 * The current-window contract row for ONE service — the /services/[key]
 * detail page. A filtered special case of getContractsSnapshot: same window,
 * same clipping, same ledger-vs-recompute rule, same maintenance matching
 * (the service's tenant windows + fleet-wide ones; a fleet-unassigned service
 * sees all windows, mirroring the fleet view). NOT a divergent reimplementation.
 */
export async function getServiceContractRow(
  serviceId: string,
): Promise<ContractServiceRow | null> {
  const now = new Date();
  const win = jalaliMonthWindow(now);

  const svc = await db.service.findUnique({
    where: { id: serviceId },
    include: { tenant: true },
  });
  if (!svc) return null;

  const [incidents, maintenance] = await Promise.all([
    db.incident.findMany({
      where: {
        serviceId,
        startedAt: { lt: win.end },
        OR: [{ status: 'ongoing' }, { resolvedAt: { gt: win.start } }],
      },
      orderBy: { startedAt: 'asc' },
    }),
    db.maintenanceWindow.findMany({
      // cancelled windows never excluded anything — drop them up front
      where: {
        status: { not: 'cancelled' },
        startAt: { lt: win.end },
        endAt: { gt: win.start },
        ...(svc.tenantId ? { OR: [{ tenantId: svc.tenantId }, { tenantId: null }] } : {}),
      },
      orderBy: { startAt: 'asc' },
    }),
  ]);

  return (
    buildContractRows(
      [
        {
          id: svc.id,
          key: svc.key,
          name: svc.name,
          nameFa: svc.nameFa,
          tenantId: svc.tenantId,
          tenantName: svc.tenant?.name ?? null,
          tenantNameFa: svc.tenant?.nameFa ?? null,
          slaTarget: svc.slaTarget,
          penaltyBase: svc.penaltyBase,
          penaltyPerMinute: svc.penaltyPerMinute,
        },
      ],
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
    )[0] ?? null
  );
}

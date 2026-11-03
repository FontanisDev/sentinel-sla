// Unit tests — /contracts pure math (src/server/contracts.ts).
// Pins every number the UI will show: window clipping, availability,
// penalty sums (ledger + domain rule), projections and the 5 % guard.

import { describe, expect, it } from 'vitest';
import {
  buildContractRows,
  complianceOf,
  jalaliMonthWindow,
  overlapSec,
  projectPenalty,
  type ContractIncidentInput,
  type ContractServiceInput,
  type ContractWindowInput,
} from '@/server/contracts';
import { penaltyFixedPerMinute } from '@/domain/contract';

// Fixed "now": 1405-07-10 (local) — mid Mehr 1405, far from any boundary.
const NOW = new Date(2026, 9, 2, 12, 0, 0); // local noon, 2 Oct 2026

describe('jalaliMonthWindow', () => {
  it('starts at local midnight of the Jalali month\u2019s first day', () => {
    const win = jalaliMonthWindow(NOW);
    expect(win.jy).toBe(1405);
    expect(win.jm).toBe(7); // Mehr
    expect(win.start.getFullYear()).toBe(2026);
    expect(win.start.getMonth()).toBe(8); // September (Mehr 1 = Sep 23 in 2026)
    expect(win.start.getHours()).toBe(0);
    expect(win.start.getMinutes()).toBe(0);
  });

  it('ends exactly at the next month\u2019s start; length matches the month', () => {
    const win = jalaliMonthWindow(NOW);
    expect(win.lengthSec).toBe(30 * 86400); // Mehr = 30 days
    const next = jalaliMonthWindow(new Date(2026, 11, 15)); // Azar → Dey boundary spans the year end
    expect(next.jm).toBe(9);
    expect(next.lengthSec).toBe(30 * 86400);
  });

  it('Esfand of a leap Jalali year has 30 days', () => {
    // 1403 is a leap Jalali year (Esfand 30 exists).
    const esfand = jalaliMonthWindow(new Date(2025, 1, 20));
    expect(esfand.jm).toBe(12);
    expect(esfand.lengthSec).toBe(30 * 86400);
  });
});

describe('overlapSec', () => {
  const winStart = 1_000_000;
  const winEnd = 2_000_000;

  it('clips an incident spanning the window start', () => {
    expect(overlapSec(winStart - 500_000, winStart + 60_000, winStart, winEnd)).toBe(60);
  });

  it('returns 0 for a fully-outside incident', () => {
    expect(overlapSec(winStart - 50_000, winStart - 10_000, winStart, winEnd)).toBe(0);
    expect(overlapSec(winEnd + 10_000, winEnd + 60_000, winStart, winEnd)).toBe(0);
  });

  it('treats null end as running to the window end', () => {
    expect(overlapSec(winStart + 10_000, null, winStart, winEnd)).toBe((winEnd - winStart - 10_000) / 1000);
  });
});

describe('projectPenalty', () => {
  it('projects linearly from the elapsed fraction', () => {
    // half the month elapsed, 1 000 000 accrued → 2 000 000 projected
    expect(projectPenalty(1_000_000, 15 * 86400, 30 * 86400)).toBe(2_000_000);
  });

  it('returns null before 5 % of the window elapsed', () => {
    expect(projectPenalty(500_000, 1 * 86400, 30 * 86400)).toBeNull(); // 3.3 % < 5 %
    expect(projectPenalty(500_000, 2 * 86400, 30 * 86400)).toBe(500_000 / (2 / 30));
  });

  it('returns null on degenerate windows', () => {
    expect(projectPenalty(100, 0, 30 * 86400)).toBeNull();
    expect(projectPenalty(100, 100, 0)).toBeNull();
  });
});

describe('complianceOf', () => {
  it('pending without a measurement, compliant at/above target, breach below', () => {
    expect(complianceOf(null, 99.9)).toBe('pending');
    expect(complianceOf(99.9, 99.9)).toBe('compliant');
    expect(complianceOf(99.89, 99.9)).toBe('breach');
  });
});

// ── buildContractRows ───────────────────────────────────────────────────────

const svc: ContractServiceInput = {
  id: 'svc-1',
  key: 'core-banking',
  name: 'Core Banking',
  nameFa: 'بانکداری مرکزی',
  tenantId: 'tenant-1',
  tenantName: 'PSP One',
  tenantNameFa: 'پی‌اس‌پی یک',
  slaTarget: 0.999,
  penaltyBase: 50_000_000,
  penaltyPerMinute: 7_500_000,
};

function inc(overrides: Partial<ContractIncidentInput>): ContractIncidentInput {
  return {
    id: 'i1',
    serviceId: 'svc-1',
    status: 'resolved',
    severity: 'critical',
    startedAt: new Date(NOW.getTime() - 3 * 86400_000),
    resolvedAt: new Date(NOW.getTime() - 3 * 86400_000 + 120_000), // 2 min
    penaltyTomans: 65_000_000, // 50M base + 15M (2 × 7.5M)
    ...overrides,
  };
}

describe('buildContractRows — contained resolved incidents use the ledger penalty', () => {
  it('sums stored penaltyTomans and bills ceil-minutes', () => {
    const rows = buildContractRows([svc], [inc({})], [], NOW);
    const r = rows[0];
    expect(r.penaltyToDate).toBe(65_000_000);
    expect(r.downtimeSec).toBe(120);
    expect(r.billedMinutes).toBe(2);
    expect(r.incidentsCount).toBe(1);
    expect(r.compliance).toBe('compliant'); // 2 min over ~7 days ≈ 99.99 %
    expect(r.projectedPenalty).not.toBeNull();
  });

  it('recomputes clipped incidents with the domain rule (warning = 30 %)', () => {
    // Incident started 1 min before the window began, ran 3 min total.
    const win = jalaliMonthWindow(NOW);
    const started = new Date(win.start.getTime() - 60_000);
    const row = buildContractRows(
      [svc],
      [inc({ severity: 'warning', startedAt: started, resolvedAt: new Date(started.getTime() + 180_000), penaltyTomans: 999 })],
      [],
      NOW,
    )[0];
    // 120 chargeable seconds inside the window → 2 billed minutes, warning weight.
    expect(row.downtimeSec).toBe(120);
    expect(row.penaltyToDate).toBe(
      penaltyFixedPerMinute(svc.penaltyBase, svc.penaltyPerMinute, 120, 30),
    );
  });

  it('accrues ongoing incidents up to now (never into the future)', () => {
    const row = buildContractRows(
      [svc],
      [inc({ status: 'ongoing', startedAt: new Date(NOW.getTime() - 600_000), resolvedAt: null })],
      [],
      NOW,
    )[0];
    expect(row.downtimeSec).toBe(600);
    // 10 billed minutes: 50M + 10 × 7.5M
    expect(row.penaltyToDate).toBe(50_000_000 + 10 * 7_500_000);
  });

  it('ignores incidents that ended before the window or start after now', () => {
    const win = jalaliMonthWindow(NOW);
    const before = buildContractRows(
      [svc],
      [inc({ startedAt: new Date(win.start.getTime() - 10 * 86400_000), resolvedAt: new Date(win.start.getTime() - 9 * 86400_000) })],
      [],
      NOW,
    )[0];
    expect(before.downtimeSec).toBe(0);
    expect(before.penaltyToDate).toBe(0);
    expect(before.incidentsCount).toBe(0);
    expect(before.billedMinutes).toBe(0);
  });

  it('computes availability from elapsed vs downtime', () => {
    const win = jalaliMonthWindow(NOW);
    const elapsed = Math.round((NOW.getTime() - win.start.getTime()) / 1000);
    const row = buildContractRows([svc], [inc({})], [], NOW)[0];
    expect(row.elapsedSec).toBe(elapsed);
    expect(row.availabilityPct).toBeCloseTo(((elapsed - 120) / elapsed) * 100, 6);
    expect(row.targetPct).toBeCloseTo(99.9, 6);
  });

  it('flags a breach when downtime overwhelms the window', () => {
    // 2 days fully inside the ~9.5-day elapsed window → ~79 % availability.
    const row = buildContractRows(
      [svc],
      [inc({ startedAt: new Date(NOW.getTime() - 3 * 86400_000), resolvedAt: new Date(NOW.getTime() - 1 * 86400_000) })],
      [],
      NOW,
    )[0];
    expect(row.compliance).toBe('breach');
    expect(row.penaltyToDate).toBe(65_000_000); // contained → ledger value
  });

  it('counts planned maintenance windows overlapping the window (informational)', () => {
    const win = jalaliMonthWindow(NOW);
    const mw: ContractWindowInput[] = [
      { id: 'm1', serviceId: 'svc-1', startAt: new Date(win.start.getTime() + 3600_000), endAt: new Date(win.start.getTime() + 7200_000) },
      { id: 'm2', serviceId: 'other-svc', startAt: win.start, endAt: new Date(win.start.getTime() + 3600_000) }, // not ours
      { id: 'm3', serviceId: null, startAt: win.start, endAt: new Date(win.start.getTime() + 1800_000) }, // fleet-wide
    ];
    const row = buildContractRows([svc], [], mw, NOW)[0];
    expect(row.plannedWindows).toBe(2);
    expect(row.plannedSec).toBe(5400);
  });

  it('keeps rows tenant-labelled and service-keyed', () => {
    const rows = buildContractRows([svc], [], [], NOW);
    expect(rows[0].tenantName).toBe('PSP One');
    expect(rows[0].serviceKey).toBe('core-banking');
  });
});

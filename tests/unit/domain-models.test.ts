// Domain unit tests — money model, contract tiers, outage merging, availability.

import { describe, expect, it } from 'vitest';
import {
  DomainError,
  computeLoss,
  defaultMoneyModel,
  resolveTpsAt,
  validateMoneyModel,
} from '@/domain/money-model';
import {
  capPenalty,
  defaultContract,
  penaltyFixedPerMinute,
  tierForAvailability,
  validateContract,
} from '@/domain/contract';
import {
  clipOutagesToWindow,
  effectiveCategory,
  mergeOutages,
  totalSeconds,
  type Outage,
} from '@/domain/outage';
import { evaluateAvailability, evaluateContract } from '@/domain/availability';

const HOUR = 3600;
const DAY = 86_400;
const MONTH = 30 * DAY; // 2 592 000 s

describe('money model — resolveTpsAt', () => {
  it('static source returns the number', () => {
    expect(resolveTpsAt({ kind: 'static', tps: 37.5 }, new Date())).toBe(37.5);
  });
  it('hour-of-week profile honours the timezone offset', () => {
    // 168 buckets of 100; bucket 42 (Monday 18:00 UTC) = 7.
    const profile = Array.from({ length: 168 }, (_, i) => (i === 42 ? 7 : 100));
    const at = new Date('2026-01-05T18:00:00.000Z'); // Monday
    expect(resolveTpsAt({ kind: 'hourOfWeekProfile', profile, tzOffsetMinutes: 0 }, at)).toBe(7);
    // Tehran +210 min: Monday 18:00 UTC = Monday 21:30 local → still bucket 42+3=45? 18:00+3:30 = 21:30 → bucket (1*24+21)=45 → 100
    expect(resolveTpsAt({ kind: 'hourOfWeekProfile', profile, tzOffsetMinutes: 210 }, at)).toBe(100);
  });
  it('profile wraps around the week boundary', () => {
    const profile = Array.from({ length: 168 }, (_, i) => (i === 0 ? 5 : 100));
    // Saturday 23:30 UTC + 30 min offset → minutes-into-week 10050 + 30 = 10080
    // → 10080 / 60 = 168 → wraps to bucket 0 (Sunday 00:00 local).
    const at = new Date('2026-01-03T23:30:00.000Z'); // Saturday
    expect(resolveTpsAt({ kind: 'hourOfWeekProfile', profile, tzOffsetMinutes: 30 }, at)).toBe(5);
  });
  it('promql uses the injected resolver, then the fallback, else throws', () => {
    const src = { kind: 'promql' as const, query: 'sum(rate(tx[5m]))' };
    expect(resolveTpsAt(src, new Date(), () => 12.5)).toBe(12.5);
    expect(resolveTpsAt({ ...src, fallbackTps: 3 }, new Date())).toBe(3);
    expect(() => resolveTpsAt(src, new Date())).toThrow(/promql source requires/);
  });
  it('rejects malformed profiles and tps', () => {
    expect(() =>
      resolveTpsAt({ kind: 'hourOfWeekProfile', profile: [1, 2, 3], tzOffsetMinutes: 0 }, new Date()),
    ).toThrow(/168/);
    expect(() => resolveTpsAt({ kind: 'static', tps: -1 }, new Date())).toThrow(DomainError);
  });
});

describe('money model — computeLoss', () => {
  it('defaults (100 % attribution, 0 recovery, 100 % margin) pass value through', () => {
    const m = defaultMoneyModel();
    const r = computeLoss(m, { tps: 40, seconds: 3600 });
    // 40 tps × 3600 s = 144 000 tx × 2 500 000 IRR = 360 000 000 000 IRR
    expect(r.grossLostRials).toBe(360_000_000_000);
    expect(r.attributedRials).toBe(360_000_000_000);
    expect(r.recoveryCreditRials).toBe(0);
    expect(r.netRials).toBe(360_000_000_000);
    expect(r.finalRials).toBe(360_000_000_000);
    expect(r.lines).toHaveLength(5);
    expect(r.lines[0]).toContain('360,000,000,000');
  });
  it('recovery credits back a share; margin scales the final number', () => {
    const m = defaultMoneyModel({ recoveryFactorPct: 20, grossMarginOrFeePct: 25, basis: 'fee' });
    const r = computeLoss(m, { tps: 40, seconds: 3600 });
    expect(r.attributedRials).toBe(360_000_000_000);
    expect(r.recoveryCreditRials).toBe(72_000_000_000);
    expect(r.netRials).toBe(288_000_000_000);
    expect(r.finalRials).toBe(72_000_000_000); // 25 % of net
  });
  it('partial-loss outage (lossBps) scales gross value', () => {
    const r = computeLoss(defaultMoneyModel(), { tps: 40, seconds: 3600, lossBps: 3250 });
    expect(r.grossLostRials).toBe(117_000_000_000); // 32.5 % of 360e9 — exact
  });
  it('zero seconds or zero tps lose nothing', () => {
    expect(computeLoss(defaultMoneyModel(), { tps: 40, seconds: 0 }).finalRials).toBe(0);
    expect(computeLoss(defaultMoneyModel(), { tps: 0, seconds: 3600 }).finalRials).toBe(0);
  });
  it('rejects bad inputs', () => {
    expect(() => computeLoss(defaultMoneyModel(), { tps: 40, seconds: 1.5 })).toThrow(DomainError);
    expect(() => computeLoss(defaultMoneyModel(), { tps: 40, seconds: 10, lossBps: 20_000 })).toThrow(DomainError);
  });
});

describe('money model — validateMoneyModel', () => {
  it('accepts the default and rejects tampering', () => {
    expect(() => validateMoneyModel(defaultMoneyModel())).not.toThrow();
    expect(() => validateMoneyModel(defaultMoneyModel({ currency: 'USD' as 'IRR' }))).toThrow(/currency/);
    expect(() => validateMoneyModel(defaultMoneyModel({ version: 0 }))).toThrow(/version/);
    expect(() => validateMoneyModel(defaultMoneyModel({ effectiveFrom: 'not-a-date' }))).toThrow(/effectiveFrom/);
    expect(() => validateMoneyModel(defaultMoneyModel({ avgTicketRials: -1 }))).toThrow(/avgTicketRials/);
    expect(() => validateMoneyModel(defaultMoneyModel({ failureAttributionPct: 150 }))).toThrow();
    expect(() => validateMoneyModel(defaultMoneyModel({ basis: 'other' as 'revenue' }))).toThrow(/basis/);
    expect(() =>
      validateMoneyModel(defaultMoneyModel({ txPerSecond: { kind: 'hourOfWeekProfile', profile: [], tzOffsetMinutes: 0 } })),
    ).toThrow(/168/);
    expect(() => validateMoneyModel(defaultMoneyModel({ txPerSecond: { kind: 'promql', query: '' } }))).toThrow(/query/);
    expect(() =>
      validateMoneyModel(defaultMoneyModel({ txPerSecond: { kind: 'nope' } as never })),
    ).toThrow(/unknown source kind/);
  });
});

describe('contract — tiers', () => {
  const c = defaultContract();
  it('meets target → no tier', () => {
    expect(tierForAvailability(c, 99.9)).toBeNull();
    expect(tierForAvailability(c, 100)).toBeNull();
  });
  it('picks the deepest matching tier', () => {
    expect(tierForAvailability(c, 99.89)?.penaltyPct).toBe(5);
    expect(tierForAvailability(c, 99.4)?.penaltyPct).toBe(15);
    expect(tierForAvailability(c, 98.9)?.penaltyPct).toBe(30);
    expect(tierForAvailability(c, 0)?.penaltyPct).toBe(30);
  });
  it('rejects out-of-range availability', () => {
    expect(() => tierForAvailability(c, 100.1)).toThrow(DomainError);
  });
});

describe('contract — fixedPerMinute + cap', () => {
  it('ceil-to-minute with a 1-minute minimum (engine-locked rule)', () => {
    expect(penaltyFixedPerMinute(500_000, 100_000, 0)).toBe(600_000);
    expect(penaltyFixedPerMinute(500_000, 100_000, 61)).toBe(700_000);
    expect(penaltyFixedPerMinute(500_000, 100_000, 600)).toBe(1_500_000);
  });
  it('weightPct scales the total (warning = 30 %)', () => {
    expect(penaltyFixedPerMinute(500_000, 100_000, 600, 30)).toBe(450_000);
    expect(penaltyFixedPerMinute(500_001, 100_000, 600, 30)).toBe(450_000); // 1_500_003 × 0.3 = 450_000.9 → 450_001? check half-even below
  });
  it('cap applies at the end', () => {
    expect(capPenalty(900, 500)).toBe(500);
    expect(capPenalty(400, 500)).toBe(400);
    expect(capPenalty(400, null)).toBe(400);
    expect(() => capPenalty(1, -5)).toThrow(DomainError);
  });
  it('rejects negative seconds', () => {
    expect(() => penaltyFixedPerMinute(0, 0, -1)).toThrow(DomainError);
  });
});

describe('contract — validate', () => {
  it('accepts the default and rejects tampering', () => {
    expect(() => validateContract(defaultContract())).not.toThrow();
    expect(() => validateContract(defaultContract({ targetAvailabilityPct: 101 }))).toThrow(/targetAvailabilityPct/);
    expect(() => validateContract(defaultContract({ windowKind: 'week' as 'jalali-month' }))).toThrow(/windowKind/);
    expect(() => validateContract(defaultContract({ monthlyFeeRials: -1 }))).toThrow(/monthlyFee/);
    expect(() => validateContract(defaultContract({ graceMinutes: -1 }))).toThrow(/grace/);
    expect(() => validateContract(defaultContract({ tenantId: '' }))).toThrow(/tenantId/);
    expect(() => validateContract(defaultContract({ serviceKey: '' }))).toThrow(/serviceKey/);
    expect(() => validateContract(defaultContract({ minChargeableOutageSec: -1 }))).toThrow(/minChargeableOutageSec/);
    expect(() => validateContract(defaultContract({ penaltyCapRials: -1 }))).toThrow(/penaltyCap/);
    expect(() => validateContract(defaultContract({ effectiveFrom: 'x' }))).toThrow(/effectiveFrom/);
    expect(() =>
      validateContract(defaultContract({ penalty: { mode: 'tiers', tiers: [] } })),
    ).toThrow(/at least one tier/);
    expect(() =>
      validateContract(defaultContract({ penalty: { mode: 'tiers', tiers: [{ belowPct: 120, penaltyPct: 5 }] } })),
    ).toThrow(/belowPct/);
    expect(() =>
      validateContract(defaultContract({ penalty: { mode: 'tiers', tiers: [{ belowPct: 99, penaltyPct: -1 }] } })),
    ).toThrow(/penaltyPct/);
    expect(() =>
      validateContract(defaultContract({ penalty: { mode: 'fixedPerMinute', baseRials: -1, perMinuteRials: 0 } })),
    ).toThrow(/baseRials/);
    expect(() =>
      validateContract(defaultContract({ penalty: { mode: 'fixedPerMinute', baseRials: 0, perMinuteRials: -1 } })),
    ).toThrow(/perMinuteRials/);
    expect(() => validateContract(defaultContract({ penalty: { mode: 'other' } as never }))).toThrow(/unknown mode/);
  });
});

describe('outage — classification & merging', () => {
  const policyOn = { excludePlanned: true, excludeExternal: true };
  const policyOff = { excludePlanned: false, excludeExternal: false };

  it('unexcluded causes become chargeable', () => {
    const planned: Outage = { startSec: 0, endSec: 60, category: 'planned' };
    expect(effectiveCategory(planned, policyOn)).toBe('planned');
    expect(effectiveCategory(planned, policyOff)).toBe('chargeable');
  });
  it('chargeable wins overlaps (provider may not launder an outage)', () => {
    const merged = mergeOutages(
      [
        { id: 'a', startSec: 0, endSec: HOUR, category: 'chargeable' },
        { id: 'm', startSec: 1800, endSec: 2 * HOUR, category: 'planned' },
      ],
      policyOn,
    );
    expect(merged).toEqual([
      { id: 'a', startSec: 0, endSec: HOUR, category: 'chargeable' },
      { id: 'm', startSec: HOUR, endSec: 2 * HOUR, category: 'planned' },
    ]);
  });
  it('touching intervals of equal category merge', () => {
    const merged = mergeOutages(
      [
        { id: 'a', startSec: 0, endSec: 60, category: 'chargeable' },
        { id: 'b', startSec: 60, endSec: 120, category: 'chargeable' },
      ],
      policyOn,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ startSec: 0, endSec: 120 });
  });
  it('tie between two chargeable outages prefers the deeper loss', () => {
    const merged = mergeOutages(
      [
        { id: 'degraded', startSec: 0, endSec: 100, category: 'chargeable', lossBps: 3250 },
        { id: 'full', startSec: 50, endSec: 150, category: 'chargeable', lossBps: 10_000 },
      ],
      policyOn,
    );
    // [0,50) covered by degraded only → 3250; [50,100) tie → deeper (full)
    // wins; [100,150) full only → adjacent equal-category-equal-depth merge.
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ startSec: 0, endSec: 50, lossBps: 3250 });
    expect(merged[1]).toMatchObject({ startSec: 50, endSec: 150, lossBps: 10_000 });
  });
  it('zero-length outages are dropped; invalid intervals rejected', () => {
    expect(mergeOutages([{ startSec: 5, endSec: 5, category: 'chargeable' }], policyOn)).toHaveLength(0);
    expect(() => mergeOutages([{ startSec: 10, endSec: 5, category: 'chargeable' }], policyOn)).toThrow(/endSec/);
    expect(() => mergeOutages([{ startSec: 1.5, endSec: 5, category: 'chargeable' }], policyOn)).toThrow(/startSec/);
    expect(() => mergeOutages([{ startSec: 1, endSec: 5, category: 'alien' as 'planned' }], policyOn)).toThrow(/category/);
    expect(() => mergeOutages([{ startSec: 1, endSec: 5, category: 'chargeable', lossBps: -1 }], policyOn)).toThrow(/lossBps/);
  });
  it('clips to the window', () => {
    const clipped = clipOutagesToWindow([{ startSec: 0, endSec: 100, category: 'chargeable' }], 50, 80);
    expect(clipped[0]).toMatchObject({ startSec: 50, endSec: 80 });
    expect(clipOutagesToWindow([{ startSec: 0, endSec: 10, category: 'chargeable' }], 50, 80)).toHaveLength(0);
    expect(clipOutagesToWindow([], 80, 50)).toHaveLength(0);
  });
  it('totalSeconds handles overlapping inputs', () => {
    expect(
      totalSeconds(
        [
          { startSec: 0, endSec: 100, category: 'chargeable' },
          { startSec: 50, endSec: 150, category: 'chargeable' },
        ],
        policyOn,
      ),
    ).toBe(150);
  });
});

describe('availability — evaluateAvailability', () => {
  const contract = defaultContract({ graceMinutes: 0, minChargeableOutageSec: 0 });

  it('one chargeable hour in a 30-day month', () => {
    const r = evaluateAvailability(contract, [{ startSec: 0, endSec: HOUR, category: 'chargeable' }], {
      startSec: 0,
      endSec: MONTH,
    });
    expect(r.windowSec).toBe(MONTH);
    expect(r.chargeableSec).toBe(HOUR);
    expect(r.contractualAvailability).toBeCloseTo(1 - HOUR / MONTH, 12);
    expect(r.naiveAvailability).toBe(r.contractualAvailability);
    expect(r.difference).toBeCloseTo(0, 12);
  });
  it('excluded planned + external outages only hit the naive metric', () => {
    const r = evaluateAvailability(
      contract,
      [
        { startSec: 0, endSec: HOUR, category: 'planned' },
        { startSec: HOUR, endSec: 2 * HOUR, category: 'external' },
      ],
      { startSec: 0, endSec: MONTH },
    );
    expect(r.plannedSec).toBe(HOUR);
    expect(r.externalSec).toBe(HOUR);
    expect(r.chargeableSec).toBe(0);
    expect(r.naiveAvailability).toBeCloseTo(1 - (2 * HOUR) / MONTH, 12);
    expect(r.contractualAvailability).toBe(1);
    expect(r.difference).toBeGreaterThan(0);
  });
  it('grace is subtracted once and never below zero', () => {
    const g = defaultContract({ graceMinutes: 15 });
    const r = evaluateAvailability(g, [{ startSec: 0, endSec: 600, category: 'chargeable' }], { startSec: 0, endSec: MONTH });
    expect(r.chargeableSec).toBe(600);
    expect(r.chargeableAfterGraceSec).toBe(0);
    const r2 = evaluateAvailability(g, [{ startSec: 0, endSec: 100, category: 'chargeable' }], { startSec: 0, endSec: MONTH });
    expect(r2.chargeableAfterGraceSec).toBe(0); // grace > downtime → floor at 0
  });
  it('minimum-duration filter drops short outages', () => {
    const m = defaultContract({ minChargeableOutageSec: 60 });
    const r = evaluateAvailability(
      m,
      [
        { startSec: 0, endSec: 59, category: 'chargeable' },
        { startSec: 100, endSec: 160, category: 'chargeable' },
      ],
      { startSec: 0, endSec: MONTH },
    );
    expect(r.chargeableSec).toBe(60);
  });
  it('rejects an empty/invalid window', () => {
    expect(() => evaluateAvailability(contract, [], { startSec: 10, endSec: 10 })).toThrow(DomainError);
    expect(() => evaluateAvailability(contract, [], { startSec: 20, endSec: 10 })).toThrow(DomainError);
  });
});

describe('evaluateContract — end to end', () => {
  it('tier hit produces fee-percentage penalty with evidence lines', () => {
    const c = defaultContract(); // tiers, fee 1e9, no cap, no grace
    const r = evaluateContract({
      contract: c,
      outages: [{ id: 'i1', startSec: 0, endSec: HOUR, category: 'chargeable' }],
      window: { startSec: 0, endSec: MONTH },
      moneyModel: defaultMoneyModel(),
    });
    // availability = 1 − 3600/2592000 = 99.8611 % < 99.9 → 5 % tier
    expect(r.tier?.penaltyPct).toBe(5);
    expect(r.penaltyRials).toBe(50_000_000);
    expect(r.targetMet).toBe(false);
    expect(r.money?.finalRials).toBe(360_000_000_000);
    expect(r.evidence.contractVersion).toBe(1);
    expect(r.evidence.moneyModelVersion).toBe(1);
    expect(r.evidence.lines.length).toBeGreaterThan(4);
  });
  it('target met → zero penalty, no tier', () => {
    const r = evaluateContract({
      contract: defaultContract(),
      outages: [{ startSec: 0, endSec: 60, category: 'chargeable' }],
      window: { startSec: 0, endSec: MONTH },
    });
    expect(r.tier).toBeNull();
    expect(r.penaltyRials).toBe(0);
    expect(r.targetMet).toBe(true);
  });
  it('fixedPerMinute mode + cap + grace + money with per-outage tps', () => {
    const c = defaultContract({
      penalty: { mode: 'fixedPerMinute', baseRials: 50_000_000, perMinuteRials: 7_500_000 },
      graceMinutes: 10,
      penaltyCapRials: 100_000_000,
    });
    const r = evaluateContract({
      contract: c,
      outages: [
        { id: 'a', startSec: 0, endSec: 1200, category: 'chargeable' }, // 20 min
      ],
      window: { startSec: 0, endSec: MONTH },
      moneyModel: defaultMoneyModel(),
      tpsByOutageId: { a: 10 },
    });
    // grace 10 min → charged 10 min → 50M + 75M = 125M → capped 100M
    expect(r.penaltyBeforeCapRials).toBe(125_000_000);
    expect(r.penaltyRials).toBe(100_000_000);
    expect(r.money?.grossLostRials).toBe(10 * 1200 * 2_500_000); // 30 000 000 000
    expect(r.evidence.lines.some((l) => l.includes('cap applied'))).toBe(true);
  });
  it('promql money model without tps hooks falls back or throws', () => {
    const c = defaultContract({ penalty: { mode: 'fixedPerMinute', baseRials: 0, perMinuteRials: 0 } });
    expect(() =>
      evaluateContract({
        contract: c,
        outages: [{ startSec: 0, endSec: 60, category: 'chargeable' }],
        window: { startSec: 0, endSec: MONTH },
        moneyModel: defaultMoneyModel({ txPerSecond: { kind: 'promql', query: 'x' } }),
      }),
    ).toThrow(/needs tps/);
    const r = evaluateContract({
      contract: c,
      outages: [{ startSec: 0, endSec: 60, category: 'chargeable' }],
      window: { startSec: 0, endSec: MONTH },
      moneyModel: defaultMoneyModel({ txPerSecond: { kind: 'promql', query: 'x', fallbackTps: 5 } }),
    });
    expect(r.money?.grossLostRials).toBe(5 * 60 * 2_500_000);
  });
  it('no chargeable outages → zero money breakdown', () => {
    const r = evaluateContract({
      contract: defaultContract(),
      outages: [{ startSec: 0, endSec: 60, category: 'planned' }],
      window: { startSec: 0, endSec: MONTH },
      moneyModel: defaultMoneyModel(),
    });
    expect(r.money?.finalRials).toBe(0);
    expect(r.money?.lines[0]).toContain('no chargeable outage');
  });
  it('tpsAt hook resolves per outage start', () => {
    const c = defaultContract({ penalty: { mode: 'fixedPerMinute', baseRials: 0, perMinuteRials: 0 } });
    const r = evaluateContract({
      contract: c,
      outages: [{ id: 'x', startSec: 0, endSec: 120, category: 'chargeable' }],
      window: { startSec: 0, endSec: MONTH },
      moneyModel: defaultMoneyModel(),
      tpsAt: (ms) => (ms === 0 ? 3 : 99),
    });
    expect(r.money?.grossLostRials).toBe(3 * 120 * 2_500_000);
  });
});

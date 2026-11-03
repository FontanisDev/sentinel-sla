// Property-based tests (fast-check) — the domain invariants:
//   1. overlap merging never exceeds the window length
//   2. availability ∈ [0, 1]
//   3. adding maintenance never increases the penalty
//   4. penalty never exceeds the cap
//   5. money is monotonic in outage duration
//   6. Toman = Rial / 10 exactly
// plus money-core properties (attribution/recovery monotonicity, merge
// idempotence & order-independence, half-even bounds).

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyBps,
  divRoundHalfEven,
  lostValueRials,
  rialToToman,
  sumRials,
  type Rials,
} from '@/domain/money';
import { computeLoss, defaultMoneyModel } from '@/domain/money-model';
import { defaultContract, type Contract } from '@/domain/contract';
import { mergeOutages, clipOutagesToWindow, type Outage } from '@/domain/outage';
import { evaluateContract } from '@/domain/availability';

// ── generators (kept inside the safe-integer envelope) ─────────────────────

const arbWindow = (): fc.Arbitrary<{ startSec: number; endSec: number }> =>
  fc.integer({ min: 0, max: 100_000 }).chain((start) =>
    fc.integer({ min: 1, max: 604_800 }).map((len) => ({ startSec: start, endSec: start + len })),
  );

const arbCategory = (): fc.Arbitrary<Outage['category']> =>
  fc.constantFrom('chargeable' as const, 'planned' as const, 'external' as const);

const arbOutages = (): fc.Arbitrary<Outage[]> =>
  arbWindow().chain((w) =>
    fc
      .array(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 4 }),
          startSec: fc.integer({ min: w.startSec - 1000, max: w.endSec + 999 }),
          lenSec: fc.integer({ min: 1, max: 86_400 }),
          category: arbCategory(),
        }),
        { maxLength: 12 },
      )
      .map((xs) =>
        xs.map((x) => ({
          id: x.id,
          startSec: x.startSec,
          endSec: x.startSec + x.lenSec,
          category: x.category,
        })),
      ),
  );

const arbContract = (): fc.Arbitrary<Contract> =>
  fc.record({
    excludePlanned: fc.boolean(),
    excludeExternal: fc.boolean(),
    graceMinutes: fc.integer({ min: 0, max: 60 }),
    minChargeableOutageSec: fc.integer({ min: 0, max: 300 }),
    targetAvailabilityPct: fc.constantFrom(99, 99.5, 99.9),
    cap: fc.option(fc.integer({ min: 1_000_000, max: 500_000_000 }), { nil: null }),
    tierPenalty: fc.integer({ min: 1, max: 30 }),
  })
    .map(
      (r): Contract => ({
        ...defaultContract(),
        excludePlanned: r.excludePlanned,
        excludeExternal: r.excludeExternal,
        graceMinutes: r.graceMinutes,
        minChargeableOutageSec: r.minChargeableOutageSec,
        targetAvailabilityPct: r.targetAvailabilityPct,
        penalty: {
          mode: 'tiers',
          tiers: [
            { belowPct: r.targetAvailabilityPct, penaltyPct: r.tierPenalty },
            { belowPct: Math.max(0, r.targetAvailabilityPct - 1), penaltyPct: r.tierPenalty * 3 },
          ],
        },
        penaltyCapRials: r.cap,
      }),
    );

// ── invariant 1: merging never exceeds the window ───────────────────────────

describe('property: overlap merging never exceeds the window length', () => {
  it('total merged seconds ≤ window seconds, for any outage set', () => {
    fc.assert(
      fc.property(arbWindow(), arbOutages(), fc.option(arbCategory(), { nil: null }), (w, outages, excl) => {
        const policy = {
          excludePlanned: excl !== 'external',
          excludeExternal: excl !== 'planned',
        };
        const clipped = clipOutagesToWindow(outages, w.startSec, w.endSec);
        const merged = mergeOutages(clipped, policy);
        const total = merged.reduce((acc, m) => acc + (m.endSec - m.startSec), 0);
        expect(total).toBeLessThanOrEqual(w.endSec - w.startSec);
        // merged output is sorted, non-overlapping and minimal
        for (let i = 1; i < merged.length; i++) {
          expect(merged[i]!.startSec).toBeGreaterThanOrEqual(merged[i - 1]!.endSec);
        }
      }),
      { numRuns: 500 },
    );
  });
});

// ── invariant 2: availability ∈ [0, 1] ──────────────────────────────────────

describe('property: availability is always within [0, 1]', () => {
  it('naive and contractual availability stay in range', () => {
    fc.assert(
      fc.property(arbWindow(), arbOutages(), arbContract(), (w, outages, contract) => {
        const r = evaluateContract({ contract, outages, window: w });
        expect(r.availability.naiveAvailability).toBeGreaterThanOrEqual(0);
        expect(r.availability.naiveAvailability).toBeLessThanOrEqual(1);
        expect(r.availability.contractualAvailability).toBeGreaterThanOrEqual(0);
        expect(r.availability.contractualAvailability).toBeLessThanOrEqual(1);
        expect(r.availability.contractualAvailability).toBeGreaterThanOrEqual(r.availability.naiveAvailability);
      }),
      { numRuns: 500 },
    );
  });
});

// ── invariant 3: adding maintenance never increases the penalty ─────────────

describe('property: adding excluded maintenance never increases the penalty', () => {
  it('penalty(outages + planned) ≤ penalty(outages), same contract & window', () => {
    fc.assert(
      fc.property(arbWindow(), arbOutages(), arbContract(), fc.array(fc.record({ startSec: fc.integer({ min: 0, max: 400_000 }), lenSec: fc.integer({ min: 1, max: 86_400 }) }), { maxLength: 6 }), (w, outages, contract, plannedExtra) => {
        const planned: Outage[] = plannedExtra.map((p, i) => ({
          id: `pl-${i}`,
          startSec: p.startSec,
          endSec: p.startSec + p.lenSec,
          category: 'planned' as const,
        }));
        const withExclusions: Contract = { ...contract, excludePlanned: true, excludeExternal: true };
        const base = evaluateContract({ contract: withExclusions, outages, window: w }).penaltyRials;
        const plus = evaluateContract({ contract: withExclusions, outages: [...outages, ...planned], window: w }).penaltyRials;
        expect(plus).toBeLessThanOrEqual(base);
      }),
      { numRuns: 400 },
    );
  });
});

// ── invariant 4: penalty never exceeds the cap ──────────────────────────────

describe('property: penalty never exceeds the cap', () => {
  it('capped contracts pay at most the cap', () => {
    fc.assert(
      fc.property(arbWindow(), arbOutages(), arbContract(), (w, outages, contract) => {
        if (contract.penaltyCapRials === null) return;
        const r = evaluateContract({ contract, outages, window: w });
        expect(r.penaltyRials).toBeLessThanOrEqual(contract.penaltyCapRials);
        expect(r.penaltyRials).toBeLessThanOrEqual(r.penaltyBeforeCapRials);
        expect(r.penaltyRials).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 400 },
    );
  });
});

// ── invariant 5: money is monotonic in duration ─────────────────────────────

describe('property: money is monotonic in outage duration', () => {
  it('longer chargeable outage → availability not higher, penalty not lower', () => {
    fc.assert(
      fc.property(arbWindow(), fc.integer({ min: 1, max: 200_000 }), fc.integer({ min: 0, max: 200_000 }), (w, len1, extra) => {
        const len2 = len1 + extra;
        const mk = (end: number): Outage => ({ id: 'o', startSec: w.startSec, endSec: Math.min(end, w.endSec), category: 'chargeable' });
        const contract = defaultContract({ penaltyCapRials: null, graceMinutes: 0, minChargeableOutageSec: 0 });
        const moneyModel = defaultMoneyModel({ avgTicketRials: 1000 });
        const r1 = evaluateContract({ contract, outages: [mk(w.startSec + len1)], window: w, moneyModel });
        const r2 = evaluateContract({ contract, outages: [mk(w.startSec + len2)], window: w, moneyModel });
        expect(r2.availability.contractualAvailability).toBeLessThanOrEqual(r1.availability.contractualAvailability);
        expect(r2.penaltyRials).toBeGreaterThanOrEqual(r1.penaltyRials);
        expect(r2.money!.finalRials).toBeGreaterThanOrEqual(r1.money!.finalRials);
      }),
      { numRuns: 400 },
    );
  });
});

// ── invariant 6: Toman = Rial / 10 exactly ──────────────────────────────────

describe('property: Toman = Rial / 10 exactly for multiples of 10', () => {
  it('round-trips exactly across the safe envelope', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Math.floor(Number.MAX_SAFE_INTEGER / 100) }), (tomans) => {
        const rials: Rials = tomans * 10;
        expect(rialToToman(rials)).toBe(tomans);
      }),
      { numRuns: 1000 },
    );
  });
});

// ── extra money-core properties ─────────────────────────────────────────────

describe('property: percentage application is contractive and bounded', () => {
  it('applyBps(a, b) ≤ a for b ≤ 100 %, and half-even stays within one unit', () => {
    // keep amount × bps inside the safe-integer envelope for the float oracle
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }).chain((bps) =>
          fc.integer({ min: 0, max: Math.floor(Number.MAX_SAFE_INTEGER / bps) }).map((amount) => ({ amount, bps })),
        ),
        ({ amount, bps }) => {
          const r = applyBps(amount, bps);
          expect(r).toBeLessThanOrEqual(amount);
          expect(r).toBeGreaterThanOrEqual(0);
          const exact = (amount * bps) / 10_000;
          expect(Math.abs(r - exact)).toBeLessThanOrEqual(0.5 + 1e-9);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('property: attribution & recovery are monotone (one knob at a time)', () => {
  it('higher attribution → more attributed money (recovery fixed)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (ticket, sec, attr2, rec) => {
          const gross = lostValueRials(40, sec, Math.max(1, ticket));
          const attr1 = Math.floor(attr2 / 2);
          expect(applyBps(gross, attr2)).toBeGreaterThanOrEqual(applyBps(gross, attr1));
          void rec;
        },
      ),
      { numRuns: 400 },
    );
  });
  it('higher recovery → less or equal net money (attribution fixed)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (ticket, sec, attr, rec2) => {
          const gross = lostValueRials(40, sec, Math.max(1, ticket));
          const a = applyBps(gross, attr);
          const rec1 = Math.floor(rec2 / 2);
          const net1 = a - applyBps(a, rec1);
          const net2 = a - applyBps(a, rec2);
          expect(net2).toBeLessThanOrEqual(net1);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('property: merge is idempotent and order-independent', () => {
  it('merge(merge(x)) == merge(x); merge(shuffle(x)) covers the same seconds', () => {
    fc.assert(
      fc.property(arbWindow(), arbOutages(), (w, outages) => {
        const policy = { excludePlanned: true, excludeExternal: true };
        const once = mergeOutages(clipOutagesToWindow(outages, w.startSec, w.endSec), policy);
        const twice = mergeOutages(once, policy);
        expect(twice).toEqual(once);
        const shuffled = mergeOutages(
          clipOutagesToWindow([...outages].reverse(), w.startSec, w.endSec),
          policy,
        );
        const cover = (xs: Outage[]): number => xs.reduce((a, m) => a + (m.endSec - m.startSec), 0);
        expect(cover(shuffled)).toBe(cover(once));
      }),
      { numRuns: 400 },
    );
  });
});

describe('property: integer sums are exact and half-even is stable', () => {
  it('sumRials associativity on integers; divRoundHalfEven ≈ exact within 0.5', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e12 }),
        fc.integer({ min: 0, max: 1e12 }),
        fc.integer({ min: 0, max: 1e12 }),
        fc.integer({ min: 1, max: 10_000 }),
        (a, b, c, d) => {
          expect(sumRials(sumRials(a, b), c)).toBe(sumRials(a, sumRials(b, c)));
          const num = a + b; // keep exact
          const q = divRoundHalfEven(num, d);
          const exact = num / d;
          expect(Math.abs(q - exact)).toBeLessThanOrEqual(0.5 + 1e-9);
          // half-even stability: re-dividing the rounded value is idempotent
          expect(divRoundHalfEven(q * d, d)).toBe(q);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('property: computeLoss final ≤ gross (all knobs ≤ 100 %)', () => {
  it('final money never exceeds gross lost value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 3_600 }),
        (attr, rec, margin, tps, sec) => {
          const model = defaultMoneyModel({
            failureAttributionPct: attr / 100,
            recoveryFactorPct: rec / 100,
            grossMarginOrFeePct: margin / 100,
            avgTicketRials: 2_500_000,
          });
          const r = computeLoss(model, { tps, seconds: sec });
          expect(r.finalRials).toBeLessThanOrEqual(r.grossLostRials);
          expect(r.netRials).toBeLessThanOrEqual(r.attributedRials);
          expect(r.finalRials).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 500 },
    );
  });
});

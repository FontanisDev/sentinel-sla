// Unit tests for the contract template library (wrong-money
// prevention: common Iranian PSP/bank SLA shapes).
//
// Two layers of defence:
//   1. Structural: every template's terms are valid inputs to the SAME
//      zod shapes the wizard/API enforce (createServiceSchema), money is
//      safe-integer Tomans (no float money), bilingual strings complete,
//      list ordered strictest → most lenient.
//   2. Golden fingerprints: each template's EXACT penalty for canonical
//      outages (45 s → 1-minute minimum rule; 15 min; warning 15 min at
//      the engine's 30 % weight), hand-computed against
//      domain/contract.ts penaltyFixedPerMinute — the real function the
//      engine calls.

import { describe, expect, it } from 'vitest';
import {
  CONTRACT_TEMPLATES,
  findContractTemplate,
} from '@/lib/contract-templates';
import { createServiceSchema } from '@/server/validation';
import { penaltyFixedPerMinute } from '@/domain/contract';

const T = CONTRACT_TEMPLATES;

describe('contract template library — structural invariants', () => {
  it('ships the six Iranian fintech archetypes with unique slug keys', () => {
    expect(T.map((x) => x.key)).toEqual([
      'psp-switching',
      'core-banking',
      'mobile-wallet',
      'ipg-merchant',
      'kyc-onboarding',
      'notify-panel',
    ]);
    expect(new Set(T.map((x) => x.key)).size).toBe(T.length);
    for (const tpl of T) {
      expect(tpl.key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('terms are accepted by the wizard/API zod shapes (one validation truth)', () => {
    for (const tpl of T) {
      expect(createServiceSchema.shape.slaTarget.safeParse(tpl.terms.slaTarget).success).toBe(true);
      expect(createServiceSchema.shape.penaltyBase.safeParse(tpl.terms.penaltyBase).success).toBe(true);
      expect(createServiceSchema.shape.penaltyPerMinute.safeParse(tpl.terms.penaltyPerMinute).success).toBe(true);
    }
  });

  it('money is safe-integer Tomans — never floats', () => {
    for (const tpl of T) {
      expect(Number.isSafeInteger(tpl.terms.penaltyBase)).toBe(true);
      expect(Number.isSafeInteger(tpl.terms.penaltyPerMinute)).toBe(true);
      expect(tpl.terms.penaltyBase).toBeGreaterThan(0);
      expect(tpl.terms.penaltyPerMinute).toBeGreaterThan(0);
    }
  });

  it('bilingual strings are complete and formal (both languages present)', () => {
    for (const tpl of T) {
      expect(tpl.name.length).toBeGreaterThan(3);
      expect(tpl.nameFa.length).toBeGreaterThan(3);
      expect(tpl.desc.length).toBeGreaterThan(30);
      expect(tpl.descFa.length).toBeGreaterThan(30);
      expect(/[\u0600-\u06FF]/.test(tpl.nameFa)).toBe(true);
      expect(/[\u0600-\u06FF]/.test(tpl.descFa)).toBe(true);
    }
  });

  it('list is ordered strictest → most lenient by availability', () => {
    for (let i = 1; i < T.length; i += 1) {
      expect(T[i - 1].terms.slaTarget).toBeGreaterThanOrEqual(T[i].terms.slaTarget);
    }
  });

  it('findContractTemplate resolves by key and misses cleanly', () => {
    expect(findContractTemplate('psp-switching')?.nameFa).toContain('شاپرک');
    expect(findContractTemplate('no-such-shape')).toBeUndefined();
  });
});

describe('contract template library — golden penalty fingerprints', () => {
  // Hand-computed: penaltyFixedPerMinute(base, perMinute, seconds, weight)
  // = applyPct(base + perMinute × ceil(seconds/60) [min 1 minute], weight).
  // All values below are exact integers (no rounding ambiguity).

  const cases: Array<{
    key: string;
    slaTarget: number;
    base: number;
    perMinute: number;
    oneMin: number;
    fifteenMin: number;
    warnFifteenMin: number;
  }> = [
    { key: 'psp-switching', slaTarget: 0.9995, base: 100_000_000, perMinute: 15_000_000, oneMin: 115_000_000, fifteenMin: 325_000_000, warnFifteenMin: 97_500_000 },
    { key: 'core-banking', slaTarget: 0.999, base: 80_000_000, perMinute: 12_000_000, oneMin: 92_000_000, fifteenMin: 260_000_000, warnFifteenMin: 78_000_000 },
    { key: 'mobile-wallet', slaTarget: 0.9975, base: 30_000_000, perMinute: 4_000_000, oneMin: 34_000_000, fifteenMin: 90_000_000, warnFifteenMin: 27_000_000 },
    { key: 'ipg-merchant', slaTarget: 0.995, base: 20_000_000, perMinute: 2_500_000, oneMin: 22_500_000, fifteenMin: 57_500_000, warnFifteenMin: 17_250_000 },
    { key: 'kyc-onboarding', slaTarget: 0.995, base: 15_000_000, perMinute: 1_500_000, oneMin: 16_500_000, fifteenMin: 37_500_000, warnFifteenMin: 11_250_000 },
    { key: 'notify-panel', slaTarget: 0.99, base: 5_000_000, perMinute: 500_000, oneMin: 5_500_000, fifteenMin: 12_500_000, warnFifteenMin: 3_750_000 },
  ];

  for (const c of cases) {
    describe(c.key, () => {
      const tpl = findContractTemplate(c.key);
      it('template carries exactly the pinned terms', () => {
        expect(tpl).toBeDefined();
        expect(tpl?.terms).toEqual({ slaTarget: c.slaTarget, penaltyBase: c.base, penaltyPerMinute: c.perMinute });
      });

      it('45-second outage → 1-minute minimum rule', () => {
        expect(penaltyFixedPerMinute(c.base, c.perMinute, 45, 100)).toBe(c.oneMin);
      });

      it('15-minute critical outage → base + 15 × per-minute', () => {
        expect(penaltyFixedPerMinute(c.base, c.perMinute, 900, 100)).toBe(c.fifteenMin);
      });

      it('15-minute warning outage → 30 % weight (engine rule)', () => {
        expect(penaltyFixedPerMinute(c.base, c.perMinute, 900, 30)).toBe(c.warnFifteenMin);
      });
    });
  }
});

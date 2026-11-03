// Golden test runner — reads every scenario in tests/golden/*.json and asserts
// the domain layer reproduces the hand-computed expectations exactly.
// The `human` field of each scenario is mirrored in docs/DOMAIN.md so a
// non-programmer can verify every number; a guard below keeps them in sync.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateContract, type Contract, type MoneyModel, type Outage } from '@/domain';
import { computeLoss } from '@/domain/money-model';
import { penaltyFixedPerMinute } from '@/domain/contract';

const GOLDEN_DIR = join(__dirname, '..', 'golden');

interface EvaluateScenario {
  id: string;
  kind: 'evaluate';
  title: string;
  human: string;
  contract: Contract;
  moneyModel: MoneyModel | null;
  outages: Outage[];
  window: { startSec: number; endSec: number };
  expect: {
    chargeableSec: number;
    plannedSec: number;
    externalSec: number;
    chargeableAfterGraceSec: number;
    naiveAvailabilityPct: number;
    contractualAvailabilityPct: number;
    differencePct: number;
    tierPenaltyPct: number | null;
    penaltyBeforeCapRials: number;
    penaltyRials: number;
    targetMet: boolean;
    moneyFinalRials: number | null;
  };
}

interface PenaltyScenario {
  id: string;
  kind: 'penaltyFixedPerMinute';
  title: string;
  human: string;
  baseRials: number;
  perMinuteRials: number;
  seconds: number;
  weightPct: number;
  expect: number;
}

interface ComputeLossScenario {
  id: string;
  kind: 'computeLoss';
  title: string;
  human: string;
  model: MoneyModel;
  input: { tps: number; seconds: number; lossBps?: number };
  expect: { grossLostRials: number; attributedRials: number; recoveryCreditRials: number; netRials: number; finalRials: number };
}

type Scenario = EvaluateScenario | PenaltyScenario | ComputeLossScenario;

const files = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).sort();
const scenarios: Scenario[] = files.map((f) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8')) as Scenario);

describe(`golden scenarios (${scenarios.length} files)`, () => {
  it('has at least 12 scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(12);
  });

  for (const s of scenarios) {
    describe(`${s.id}: ${s.title}`, () => {
      if (s.kind === 'evaluate') {
        it('reproduces the hand-computed evaluation', () => {
          const r = evaluateContract({
            contract: s.contract,
            outages: s.outages,
            window: s.window,
            ...(s.moneyModel ? { moneyModel: s.moneyModel } : {}),
          });
          const e = s.expect;
          expect(r.availability.chargeableSec).toBe(e.chargeableSec);
          expect(r.availability.plannedSec).toBe(e.plannedSec);
          expect(r.availability.externalSec).toBe(e.externalSec);
          expect(r.availability.chargeableAfterGraceSec).toBe(e.chargeableAfterGraceSec);
          expect(Math.round(r.availability.naiveAvailability * 1e6) / 1e4).toBeCloseTo(e.naiveAvailabilityPct, 4);
          expect(Math.round(r.availability.contractualAvailability * 1e6) / 1e4).toBeCloseTo(e.contractualAvailabilityPct, 4);
          expect(Math.round(r.availability.difference * 1e6) / 1e4).toBeCloseTo(e.differencePct, 4);
          expect(r.contractualAvailabilityPct).toBe(e.contractualAvailabilityPct);
          expect(r.tier?.penaltyPct ?? null).toBe(e.tierPenaltyPct);
          expect(r.penaltyBeforeCapRials).toBe(e.penaltyBeforeCapRials);
          expect(r.penaltyRials).toBe(e.penaltyRials);
          expect(r.targetMet).toBe(e.targetMet);
          expect(r.money?.finalRials ?? null).toBe(e.moneyFinalRials);
        });
      } else if (s.kind === 'penaltyFixedPerMinute') {
        it('reproduces the hand-computed penalty', () => {
          expect(penaltyFixedPerMinute(s.baseRials, s.perMinuteRials, s.seconds, s.weightPct)).toBe(s.expect);
        });
      } else {
        it('reproduces the hand-computed money breakdown', () => {
          const r = computeLoss(s.model, s.input);
          expect(r.grossLostRials).toBe(s.expect.grossLostRials);
          expect(r.attributedRials).toBe(s.expect.attributedRials);
          expect(r.recoveryCreditRials).toBe(s.expect.recoveryCreditRials);
          expect(r.netRials).toBe(s.expect.netRials);
          expect(r.finalRials).toBe(s.expect.finalRials);
        });
      }
    });
  }

  it('every scenario carries a plain-language description', () => {
    for (const s of scenarios) {
      expect(s.human.length, `${s.id} needs a human description`).toBeGreaterThan(40);
    }
  });

  it('every scenario is documented in docs/DOMAIN.md (reviewer reproducibility)', () => {
    const md = readFileSync(join(__dirname, '..', '..', 'docs', 'DOMAIN.md'), 'utf8');
    for (const s of scenarios) {
      expect(md.includes(s.id), `docs/DOMAIN.md must contain scenario ${s.id}`).toBe(true);
    }
  });
});

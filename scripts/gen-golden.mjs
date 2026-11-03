// Generates tests/golden/*.json — hand-computed golden scenarios for the
// domain layer. Every expected number in this file was computed BY HAND with
// the formulas of docs/DOMAIN.md; the script only serialises them.
// Run: node scripts/gen-golden.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('../tests/golden/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const MONTH = 2_592_000; // 30-day window in seconds
const HOUR = 3600;

const contractBase = {
  version: 1,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  tenantId: 'tenant-demo',
  serviceKey: null,
  targetAvailabilityPct: 99.9,
  windowKind: 'gregorian-month',
  minChargeableOutageSec: 0,
  penalty: {
    mode: 'tiers',
    tiers: [
      { belowPct: 99.9, penaltyPct: 5 },
      { belowPct: 99.5, penaltyPct: 15 },
      { belowPct: 99.0, penaltyPct: 30 },
    ],
  },
  monthlyFeeRials: 1_000_000_000,
  penaltyCapRials: null,
  graceMinutes: 0,
  excludePlanned: true,
  excludeExternal: true,
};

const modelBase = {
  version: 1,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  currency: 'IRR',
  avgTicketRials: 2_500_000,
  txPerSecond: { kind: 'static', tps: 40 },
  failureAttributionPct: 100,
  recoveryFactorPct: 0,
  basis: 'revenue',
  grossMarginOrFeePct: 100,
};

const scenarios = [
  {
    id: 'g01-tier-basic',
    title: 'One chargeable hour breaches 99.9 % → 5 % tier of the monthly fee',
    human:
      'A service promised 99.9 % uptime is down for exactly 1 hour inside a 30-day month. ' +
      'Availability = 1 − 3600/2 592 000 = 99.8611 %, below the 99.9 % promise, so the 5 % tier applies: ' +
      '5 % of the 1 000 000 000 IRR monthly fee = 50 000 000 IRR. No exclusions or grace apply.',
    kind: 'evaluate',
    contract: contractBase,
    moneyModel: modelBase,
    outages: [{ id: 'i1', startSec: 0, endSec: HOUR, category: 'chargeable' }],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 3600, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 3600,
      naiveAvailabilityPct: 99.8611, contractualAvailabilityPct: 99.8611, differencePct: 0,
      tierPenaltyPct: 5, penaltyBeforeCapRials: 50_000_000, penaltyRials: 50_000_000,
      targetMet: false, moneyFinalRials: 360_000_000_000,
    },
  },
  {
    id: 'g02-fixed-per-minute',
    title: 'Fixed + per-minute penalty: 10 minutes bills base + 10 × per-minute',
    human:
      'A contract without tiers charges 50 000 000 IRR base plus 7 500 000 IRR per charged minute. ' +
      'A 10-minute outage bills 50 000 000 + 10 × 7 500 000 = 125 000 000 IRR.',
    kind: 'evaluate',
    contract: {
      ...contractBase,
      penalty: { mode: 'fixedPerMinute', baseRials: 50_000_000, perMinuteRials: 7_500_000 },
    },
    moneyModel: null,
    outages: [{ id: 'i1', startSec: 0, endSec: 600, category: 'chargeable' }],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 600, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 600,
      naiveAvailabilityPct: 99.9769, contractualAvailabilityPct: 99.9769, differencePct: 0,
      tierPenaltyPct: null, penaltyBeforeCapRials: 125_000_000, penaltyRials: 125_000_000,
      targetMet: false, moneyFinalRials: null,
    },
  },
  {
    id: 'g03-grace',
    title: 'Grace minutes: 20 minutes down with 15 minutes grace bills 5 minutes',
    human:
      'The contract forgives the first 15 minutes of downtime per month. A 20-minute outage is charged ' +
      'only for the remaining 5 minutes: 10 000 000 base + 5 × 1 000 000 = 15 000 000 IRR. ' +
      'Grace is subtracted once per window, never per outage.',
    kind: 'evaluate',
    contract: {
      ...contractBase,
      graceMinutes: 15,
      penalty: { mode: 'fixedPerMinute', baseRials: 10_000_000, perMinuteRials: 1_000_000 },
    },
    moneyModel: null,
    outages: [{ id: 'i1', startSec: 0, endSec: 1200, category: 'chargeable' }],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 1200, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 300,
      naiveAvailabilityPct: 99.9537, contractualAvailabilityPct: 99.9884, differencePct: 0.0347,
      tierPenaltyPct: null, penaltyBeforeCapRials: 15_000_000, penaltyRials: 15_000_000,
      targetMet: false, moneyFinalRials: null,
    },
  },
  {
    id: 'g04-min-duration',
    title: 'Minimum outage duration: a 30-second blip never counts',
    human:
      'The contract ignores outages shorter than 60 seconds. Three outages (2400 s, 30 s, 6000 s) count ' +
      'as 2400 + 6000 = 8400 chargeable seconds; availability 99.6759 % breaches 99.9 % but not 99.5 % ' +
      '→ the 5 % tier applies = 50 000 000 IRR. The NAIVE metric still counts the 30-second blip ' +
      '(99.6748 %) — the 0.0012 % difference is exactly what the minimum-duration rule bought the provider.',
    kind: 'evaluate',
    contract: { ...contractBase, minChargeableOutageSec: 60 },
    moneyModel: null,
    outages: [
      { id: 'a', startSec: 0, endSec: 2400, category: 'chargeable' },
      { id: 'b', startSec: 5000, endSec: 5030, category: 'chargeable' },
      { id: 'c', startSec: 9000, endSec: 15000, category: 'chargeable' },
    ],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 8400, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 8400,
      naiveAvailabilityPct: 99.6748, contractualAvailabilityPct: 99.6759, differencePct: 0.0012,
      tierPenaltyPct: 5, penaltyBeforeCapRials: 50_000_000, penaltyRials: 50_000_000,
      targetMet: false, moneyFinalRials: null,
    },
  },
  {
    id: 'g05-merge-winner',
    title: 'Maintenance overlapping an outage: the chargeable category wins the overlap',
    human:
      'A planned maintenance window (10:30–12:00) overlaps a real outage (10:00–11:00). The provider may ' +
      'not launder a genuine outage behind maintenance: the overlap 10:30–11:00 stays chargeable. ' +
      'Chargeable = 3600 s, planned = 3600 s. Contractual availability 99.8611 % (naive 99.7222 %, ' +
      'difference 0.1389 %) → 5 % tier = 50 000 000 IRR.',
    kind: 'evaluate',
    contract: contractBase,
    moneyModel: null,
    outages: [
      { id: 'i1', startSec: 0, endSec: HOUR, category: 'chargeable' },
      { id: 'm1', startSec: 1800, endSec: 2 * HOUR, category: 'planned' },
    ],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 3600, plannedSec: 3600, externalSec: 0, chargeableAfterGraceSec: 3600,
      naiveAvailabilityPct: 99.7222, contractualAvailabilityPct: 99.8611, differencePct: 0.1389,
      tierPenaltyPct: 5, penaltyBeforeCapRials: 50_000_000, penaltyRials: 50_000_000,
      targetMet: false, moneyFinalRials: null,
    },
  },
  {
    id: 'g06-external-not-excluded',
    title: 'External-cause exclusion OFF: the upstream failure is chargeable',
    human:
      'The contract does not exclude external causes, so a 2-hour upstream failure counts like any ' +
      'other outage: availability 99.7222 % → 5 % tier = 50 000 000 IRR.',
    kind: 'evaluate',
    contract: { ...contractBase, excludeExternal: false },
    moneyModel: null,
    outages: [{ id: 'e1', startSec: 0, endSec: 7200, category: 'external' }],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 7200, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 7200,
      naiveAvailabilityPct: 99.7222, contractualAvailabilityPct: 99.7222, differencePct: 0,
      tierPenaltyPct: 5, penaltyBeforeCapRials: 50_000_000, penaltyRials: 50_000_000,
      targetMet: false, moneyFinalRials: null,
    },
  },
  {
    id: 'g07-external-excluded',
    title: 'External-cause exclusion ON: the same failure is excluded',
    human:
      'Same 30-minute upstream failure, but this contract excludes external causes. Nothing is chargeable: ' +
      'contractual availability 100 %, no tier hit, penalty 0. The naive metric still shows 99.9306 %.',
    kind: 'evaluate',
    contract: contractBase,
    moneyModel: null,
    outages: [{ id: 'e1', startSec: 0, endSec: 1800, category: 'external' }],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 0, plannedSec: 0, externalSec: 1800, chargeableAfterGraceSec: 0,
      naiveAvailabilityPct: 99.9306, contractualAvailabilityPct: 100, differencePct: 0.0694,
      tierPenaltyPct: null, penaltyBeforeCapRials: 0, penaltyRials: 0,
      targetMet: true, moneyFinalRials: null,
    },
  },
  {
    id: 'g08-recovery',
    title: 'Recovery factor: 20 % of failed transactions retry successfully',
    human:
      '1 hour down at 40 tx/s with a 2 500 000 IRR ticket loses 144 000 transactions worth ' +
      '360 000 000 000 IRR gross. The model credits 20 % successful retries (72 000 000 000 IRR), ' +
      'so the net lost money shown to the executive is 288 000 000 000 IRR.',
    kind: 'evaluate',
    contract: contractBase,
    moneyModel: { ...modelBase, recoveryFactorPct: 20 },
    outages: [{ id: 'i1', startSec: 0, endSec: HOUR, category: 'chargeable' }],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 3600, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 3600,
      naiveAvailabilityPct: 99.8611, contractualAvailabilityPct: 99.8611, differencePct: 0,
      tierPenaltyPct: 5, penaltyBeforeCapRials: 50_000_000, penaltyRials: 50_000_000,
      targetMet: false, moneyFinalRials: 288_000_000_000,
    },
  },
  {
    id: 'g09-attribution',
    title: 'Failure attribution: only 60 % of the outage truly loses transactions',
    human:
      'The money model says 60 % of outage minutes actually lose transactions (the rest is read-only ' +
      'traffic). Gross 360 000 000 000 IRR × 60 % = 216 000 000 000 IRR attributed, net and final the same.',
    kind: 'evaluate',
    contract: contractBase,
    moneyModel: { ...modelBase, failureAttributionPct: 60 },
    outages: [{ id: 'i1', startSec: 0, endSec: HOUR, category: 'chargeable' }],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 3600, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 3600,
      naiveAvailabilityPct: 99.8611, contractualAvailabilityPct: 99.8611, differencePct: 0,
      tierPenaltyPct: 5, penaltyBeforeCapRials: 50_000_000, penaltyRials: 50_000_000,
      targetMet: false, moneyFinalRials: 216_000_000_000,
    },
  },
  {
    id: 'g10-margin-fee-basis',
    title: 'Fee/commission basis: the loss is 25 % of the transaction value',
    human:
      'The tenant earns a commission, not the full transaction value: gross 360 000 000 000 IRR × 25 % ' +
      'margin = 90 000 000 000 IRR final loss, labelled "fee basis" in the UI and PDF.',
    kind: 'evaluate',
    contract: contractBase,
    moneyModel: { ...modelBase, basis: 'fee', grossMarginOrFeePct: 25 },
    outages: [{ id: 'i1', startSec: 0, endSec: HOUR, category: 'chargeable' }],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 3600, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 3600,
      naiveAvailabilityPct: 99.8611, contractualAvailabilityPct: 99.8611, differencePct: 0,
      tierPenaltyPct: 5, penaltyBeforeCapRials: 50_000_000, penaltyRials: 50_000_000,
      targetMet: false, moneyFinalRials: 90_000_000_000,
    },
  },
  {
    id: 'g11-cap',
    title: 'Penalty cap: a 100 000 000 IRR tier penalty is capped at 50 000 000',
    human:
      'A 2 000 000 000 IRR fee with the 5 % tier would cost 100 000 000 IRR, but the contract caps the ' +
      'penalty at 50 000 000 IRR — the payable number is the cap.',
    kind: 'evaluate',
    contract: { ...contractBase, monthlyFeeRials: 2_000_000_000, penaltyCapRials: 50_000_000 },
    moneyModel: null,
    outages: [{ id: 'i1', startSec: 0, endSec: HOUR, category: 'chargeable' }],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 3600, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 3600,
      naiveAvailabilityPct: 99.8611, contractualAvailabilityPct: 99.8611, differencePct: 0,
      tierPenaltyPct: 5, penaltyBeforeCapRials: 100_000_000, penaltyRials: 50_000_000,
      targetMet: false, moneyFinalRials: null,
    },
  },
  {
    id: 'g12-hour-of-week',
    title: 'Hour-of-week profile: the outage starts in a 40 tx/s bucket',
    human:
      'The money model follows a weekly traffic profile in Tehran time. The outage starts Saturday ' +
      '22:30 UTC = Sunday 02:00 Tehran, which sits in the 40 tx/s bucket. The resolver takes the tps at ' +
      'the segment start, so the whole 2-hour outage is valued at 40 tx/s: 7200 s × 40 × 2 500 000 IRR ' +
      '= 720 000 000 000 IRR gross; availability 99.7222 % → 5 % tier = 50 000 000 IRR.',
    kind: 'evaluate',
    contract: contractBase,
    moneyModel: {
      ...modelBase,
      txPerSecond: {
        kind: 'hourOfWeekProfile',
        tzOffsetMinutes: 210,
        profile: Array.from({ length: 168 }, (_, i) => (i === 2 ? 40 : 100)),
      },
    },
    outages: [{ id: 'i1', startSec: 1767479400, endSec: 1767479400 + 7200, category: 'chargeable' }],
    window: { startSec: 1767225600, endSec: 1767225600 + MONTH },
    expect: {
      chargeableSec: 7200, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 7200,
      naiveAvailabilityPct: 99.7222, contractualAvailabilityPct: 99.7222, differencePct: 0,
      tierPenaltyPct: 5, penaltyBeforeCapRials: 50_000_000, penaltyRials: 50_000_000,
      targetMet: false, moneyFinalRials: 720_000_000_000,
    },
  },
  {
    id: 'g13-warning-weight',
    title: 'Warning severity bills 30 % of the fixed + per-minute penalty',
    human:
      'A degraded (warning-severity) incident of 10 minutes under a base 0 + 1 000 000 IRR/min scheme ' +
      'would be 10 000 000 IRR when critical; warnings bill 30 %: 3 000 000 IRR. (The engine passes the ' +
      '30 % weight per incident; the domain function applies one half-even rounding.)',
    kind: 'penaltyFixedPerMinute',
    baseRials: 0,
    perMinuteRials: 1_000_000,
    seconds: 600,
    weightPct: 30,
    expect: 3_000_000,
  },
  {
    id: 'g14-degraded-money',
    title: 'Degraded outage: money follows the 32.5 % loss depth, availability counts full seconds',
    human:
      'A degraded hour keeps 67.5 % of throughput, so the transaction loss depth is 32.5 %. Money: ' +
      '360 000 000 000 × 32.5 % = 117 000 000 000 IRR. Availability still counts the full hour: ' +
      '99.8611 % → 5 % tier = 50 000 000 IRR penalty.',
    kind: 'evaluate',
    contract: contractBase,
    moneyModel: modelBase,
    outages: [{ id: 'd1', startSec: 0, endSec: HOUR, category: 'chargeable', lossBps: 3250 }],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 3600, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 3600,
      naiveAvailabilityPct: 99.8611, contractualAvailabilityPct: 99.8611, differencePct: 0,
      tierPenaltyPct: 5, penaltyBeforeCapRials: 50_000_000, penaltyRials: 50_000_000,
      targetMet: false, moneyFinalRials: 117_000_000_000,
    },
  },
  {
    id: 'g15-touching-merge',
    title: 'Touching outages merge: 60 s + 60 s becomes one 120 s segment',
    human:
      'Two consecutive one-minute outages (10:00:00–10:01:00 and 10:01:00–10:02:00) are one 120-second ' +
      'outage for availability: 99.9954 % — still above the 99.9 % promise, so no penalty.',
    kind: 'evaluate',
    contract: contractBase,
    moneyModel: null,
    outages: [
      { id: 'a', startSec: 0, endSec: 60, category: 'chargeable' },
      { id: 'b', startSec: 60, endSec: 120, category: 'chargeable' },
    ],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 120, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 120,
      naiveAvailabilityPct: 99.9954, contractualAvailabilityPct: 99.9954, differencePct: 0,
      tierPenaltyPct: null, penaltyBeforeCapRials: 0, penaltyRials: 0,
      targetMet: true, moneyFinalRials: null,
    },
  },
  {
    id: 'g16-half-even-down',
    title: 'Banker-neutral rounding: 2.5 rounds DOWN to 2 (even)',
    human:
      'A tiny 1-second outage at 1 tx/s with a 5 IRR ticket loses 5 IRR. Attribution 50 % gives 2.5 IRR; ' +
      'half-to-even rounds to 2 (2 is even). One rounding, at the final step.',
    kind: 'computeLoss',
    model: { ...modelBase, avgTicketRials: 5, failureAttributionPct: 50 },
    input: { tps: 1, seconds: 1 },
    expect: { grossLostRials: 5, attributedRials: 2, recoveryCreditRials: 0, netRials: 2, finalRials: 2 },
  },
  {
    id: 'g17-half-even-up',
    title: 'Banker-neutral rounding: 7.5 rounds UP to 8 (even)',
    human:
      'Same tiny outage with a 15 IRR ticket: 50 % attribution gives 7.5 IRR; half-to-even rounds to 8 ' +
      '(8 is even). The even rule keeps long sums unbiased.',
    kind: 'computeLoss',
    model: { ...modelBase, avgTicketRials: 15, failureAttributionPct: 50 },
    input: { tps: 1, seconds: 1 },
    expect: { grossLostRials: 15, attributedRials: 8, recoveryCreditRials: 0, netRials: 8, finalRials: 8 },
  },
  {
    id: 'g18-full-chain',
    title: 'Full chain: attribution 60 %, recovery 20 %, margin 25 %',
    human:
      'Gross 360 000 000 000 → attribution 60 % = 216 000 000 000 → recovery credit 20 % = 43 200 000 000 ' +
      '→ net 172 800 000 000 → margin 25 % = 43 200 000 000 IRR final (fee basis). Every step is a ' +
      'separate evidence line; each line rounds at most once.',
    kind: 'evaluate',
    contract: contractBase,
    moneyModel: {
      ...modelBase,
      failureAttributionPct: 60,
      recoveryFactorPct: 20,
      basis: 'fee',
      grossMarginOrFeePct: 25,
    },
    outages: [{ id: 'i1', startSec: 0, endSec: HOUR, category: 'chargeable' }],
    window: { startSec: 0, endSec: MONTH },
    expect: {
      chargeableSec: 3600, plannedSec: 0, externalSec: 0, chargeableAfterGraceSec: 3600,
      naiveAvailabilityPct: 99.8611, contractualAvailabilityPct: 99.8611, differencePct: 0,
      tierPenaltyPct: 5, penaltyBeforeCapRials: 50_000_000, penaltyRials: 50_000_000,
      targetMet: false, moneyFinalRials: 43_200_000_000,
    },
  },
];

for (const s of scenarios) {
  writeFileSync(join(OUT, `${s.id}.json`), JSON.stringify(s, null, 2) + '\n');
}
console.log(`wrote ${scenarios.length} golden scenarios to ${OUT}`);

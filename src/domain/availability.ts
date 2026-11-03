// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA domain — availability & contract evaluation (pure)
//
// Produces, for one measurement window:
//   • naive availability        — every outage second counts, no exclusions
//   • contractual availability  — only effective-chargeable seconds (after
//     minimum-duration filtering and the once-per-window grace allowance)
//   • the penalty (tiers of the monthly fee, or fixed + per-minute), capped
//   • an auditable evidence trail: versions, window, formula lines
//
// Everything here is a pure function of its inputs — no db, no clock, no HTTP.
// The engine/analytics layer resolves the tps (possibly via PromQL) and hands
// it in per outage via `tpsByOutageId` or the single `tpsAt` hook.
// ═══════════════════════════════════════════════════════════════════════════

import { capPenalty, exclusionPolicyOf, tierForAvailability, penaltyFixedPerMinute, type Contract, type PenaltyTier } from './contract';
import { DomainError, applyPct, formatRials, sumRials, type Rials } from './money';
import { computeLoss, resolveTpsAt, type MoneyBreakdown, type MoneyModel } from './money-model';
import { clipOutagesToWindow, mergeOutages, type Outage } from './outage';

/** Measurement window, half-open epoch seconds. */
export interface Window {
  startSec: number;
  endSec: number;
}

export interface AvailabilityResult {
  /** Window length in seconds. */
  windowSec: number;
  /** Effective-chargeable seconds after merge + min-duration filter. */
  chargeableSec: number;
  /** Excluded planned seconds (post-merge winner-labelled). */
  plannedSec: number;
  /** Excluded external seconds (post-merge winner-labelled). */
  externalSec: number;
  /** Chargeable seconds after the grace allowance is subtracted. */
  chargeableAfterGraceSec: number;
  /** 0..1 — every outage second counts (no exclusions, no grace). */
  naiveAvailability: number;
  /** 0..1 — the contractual metric. */
  contractualAvailability: number;
  /** contractual − naive (≥ 0): what the exclusions+grace bought the provider. */
  difference: number;
}

export interface ContractEvaluation {
  availability: AvailabilityResult;
  /** Target from the contract (percent). */
  targetPct: number;
  /** Contractual availability in percent (rounded half-even to 4 decimals for reporting). */
  contractualAvailabilityPct: number;
  /** Matching tier (tiers mode), else null. */
  tier: PenaltyTier | null;
  /** Penalty before the cap. */
  penaltyBeforeCapRials: Rials;
  /** Penalty after the cap — the payable number. */
  penaltyRials: Rials;
  /** Money-model breakdown for the lost-transaction value (null when no model supplied). */
  money: MoneyBreakdown | null;
  /** Whether the contract met its target (no tier hit / zero penalty). */
  targetMet: boolean;
  /** Auditable evidence trail (FormulaPopover + PDF print this verbatim). */
  evidence: Evidence;
}

/** Auditable evidence: every number traces to a formula line. */
export interface Evidence {
  contractVersion: number;
  moneyModelVersion: number | null;
  window: Window;
  lines: string[];
}

export interface EvaluateInput {
  contract: Contract;
  /** Outages within or overlapping the window (clipped internally). */
  outages: Outage[];
  window: Window;
  /** Money model (optional — penalty math works without it). */
  moneyModel?: MoneyModel;
  /**
   * tps resolution: either one resolver invoked per outage start instant, or a
   * per-outage map keyed by outage `id`. Without either, a static default of
   * `defaultTps` is used; promql sources without resolution throw.
   */
  tpsAt?: (atMs: number) => number;
  tpsByOutageId?: Record<string, number>;
  defaultTps?: number;
}

function pct4(x: number): number {
  // reporting-only rounding of a 0..1 ratio to 4 decimal percent digits
  return Math.round(x * 1_000_000) / 10_000;
}

/** Availability math only (no penalty): merge → filter → grace → ratios. */
export function evaluateAvailability(
  contract: Contract,
  outages: Outage[],
  window: Window,
): AvailabilityResult {
  const { startSec, endSec } = window;
  if (!Number.isSafeInteger(startSec) || !Number.isSafeInteger(endSec) || endSec <= startSec) {
    throw new DomainError(`evaluateAvailability: window must be a non-empty half-open range, got [${startSec}, ${endSec})`);
  }
  const windowSec = endSec - startSec;
  const clipped = clipOutagesToWindow(outages, startSec, endSec);
  const policy = exclusionPolicyOf(contract);
  const merged = mergeOutages(clipped, policy);

  const minSec = contract.minChargeableOutageSec;
  let chargeableSec = 0;
  let plannedSec = 0;
  let externalSec = 0;
  for (const m of merged) {
    const dur = m.endSec - m.startSec;
    if (m.category === 'chargeable') {
      // minimum-duration rule: a chargeable outage shorter than the minimum
      // never counts (evaluated per merged segment — evidence shows the filter)
      if (dur >= minSec) chargeableSec += dur;
    } else if (m.category === 'planned') {
      plannedSec += dur;
    } else {
      externalSec += dur;
    }
  }

  // Naive view: EVERY clipped outage second counts against the provider.
  const naiveDownSec = merged.reduce((acc, m) => acc + (m.endSec - m.startSec), 0);
  const naiveAvailability = 1 - naiveDownSec / windowSec;

  // Grace is subtracted once per window, never below zero.
  const graceSec = Math.min(contract.graceMinutes * 60, chargeableSec);
  const chargeableAfterGraceSec = chargeableSec - graceSec;

  const contractualAvailability = 1 - chargeableAfterGraceSec / windowSec;
  return {
    windowSec,
    chargeableSec,
    plannedSec,
    externalSec,
    chargeableAfterGraceSec,
    naiveAvailability,
    contractualAvailability,
    difference: contractualAvailability - naiveAvailability,
  };
}

/** Full evaluation: availability + penalty + money breakdown + evidence. */
export function evaluateContract(input: EvaluateInput): ContractEvaluation {
  const { contract, window, moneyModel } = input;
  const avail = evaluateAvailability(contract, input.outages, window);
  const lines: string[] = [];
  lines.push(`window = [${window.startSec}, ${window.endSec}) = ${avail.windowSec.toLocaleString('en-US')} s`);
  lines.push(
    `chargeable = ${avail.chargeableSec.toLocaleString('en-US')} s` +
      (contract.graceMinutes > 0 ? ` − grace(${contract.graceMinutes} min = ${(contract.graceMinutes * 60).toLocaleString('en-US')} s) = ${avail.chargeableAfterGraceSec.toLocaleString('en-US')} s` : '') +
      `; planned(excluded) = ${avail.plannedSec.toLocaleString('en-US')} s; external(excluded) = ${avail.externalSec.toLocaleString('en-US')} s`,
  );
  lines.push(
    `contractual availability = 1 − ${avail.chargeableAfterGraceSec.toLocaleString('en-US')}/${avail.windowSec.toLocaleString('en-US')} = ${pct4(avail.contractualAvailability)} % (naive ${pct4(avail.naiveAvailability)} %, difference ${pct4(avail.difference)} %)`,
  );

  const availabilityPct = pct4(avail.contractualAvailability);
  let tier: PenaltyTier | null = null;
  let penaltyBeforeCap: Rials;

  if (contract.penalty.mode === 'tiers') {
    tier = tierForAvailability(contract, availabilityPct);
    if (tier === null) {
      penaltyBeforeCap = 0;
      lines.push(`penalty = availability ${availabilityPct} % ≥ target ${contract.targetAvailabilityPct} % → 0 IRR`);
    } else {
      penaltyBeforeCap = applyPct(contract.monthlyFeeRials, tier.penaltyPct);
      lines.push(
        `penalty = tier(availability ${availabilityPct} % < ${tier.belowPct} %) → ${tier.penaltyPct} % × fee(${formatRials(contract.monthlyFeeRials)}) = ${formatRials(penaltyBeforeCap)}`,
      );
    }
  } else {
    penaltyBeforeCap = penaltyFixedPerMinute(contract.penalty.baseRials, contract.penalty.perMinuteRials, avail.chargeableAfterGraceSec);
    lines.push(
      `penalty = base(${formatRials(contract.penalty.baseRials)}) + ${formatRials(contract.penalty.perMinuteRials)}/min × ceil(${avail.chargeableAfterGraceSec.toLocaleString('en-US')} s / 60) = ${formatRials(penaltyBeforeCap)}`,
    );
  }
  const penalty = capPenalty(penaltyBeforeCap, contract.penaltyCapRials);
  if (contract.penaltyCapRials !== null && penaltyBeforeCap > penalty) {
    lines.push(`cap applied: ${formatRials(penaltyBeforeCap)} → ${formatRials(penalty)} (cap ${formatRials(contract.penaltyCapRials)})`);
  }

  let money: MoneyBreakdown | null = null;
  if (moneyModel) {
    money = computeWindowMoney(moneyModel, input, avail);
    lines.push(...money.lines);
  }

  return {
    availability: avail,
    targetPct: contract.targetAvailabilityPct,
    contractualAvailabilityPct: availabilityPct,
    tier,
    penaltyBeforeCapRials: penaltyBeforeCap,
    penaltyRials: penalty,
    money,
    targetMet: penalty === 0,
    evidence: {
      contractVersion: contract.version,
      moneyModelVersion: moneyModel?.version ?? null,
      window,
      lines,
    },
  };
}

/**
 * Lost-transaction money for the whole window: per merged chargeable segment,
 * resolved tps at the segment start, summed once (sum of integers is exact).
 */
function computeWindowMoney(
  model: MoneyModel,
  input: EvaluateInput,
  avail: AvailabilityResult,
): MoneyBreakdown {
  const contract = input.contract;
  const merged = mergeOutages(
    clipOutagesToWindow(input.outages, input.window.startSec, input.window.endSec),
    exclusionPolicyOf(contract),
  );
  const parts: MoneyBreakdown[] = [];
  for (const m of merged) {
    if (m.category !== 'chargeable') continue;
    const dur = m.endSec - m.startSec;
    if (dur < contract.minChargeableOutageSec) continue;
    let tps: number;
    if (m.id && input.tpsByOutageId && m.id in input.tpsByOutageId) {
      tps = input.tpsByOutageId[m.id]!;
    } else if (input.tpsAt) {
      tps = input.tpsAt(m.startSec * 1000);
    } else if (model.txPerSecond.kind === 'static') {
      tps = model.txPerSecond.tps;
    } else if (model.txPerSecond.kind === 'hourOfWeekProfile') {
      tps = resolveTpsAt(model.txPerSecond, new Date(m.startSec * 1000));
    } else if (model.txPerSecond.kind === 'promql' && model.txPerSecond.fallbackTps !== undefined) {
      tps = model.txPerSecond.fallbackTps;
    } else {
      throw new DomainError(
        `computeWindowMoney: outage ${m.id ?? '(anon)'} needs tps — supply tpsAt/tpsByOutageId for ${model.txPerSecond.kind} sources`,
      );
    }
    parts.push(computeLoss(model, { tps, seconds: dur, lossBps: m.lossBps }));
  }
  if (parts.length === 0) {
    return {
      grossLostRials: 0,
      attributedRials: 0,
      recoveryCreditRials: 0,
      netRials: 0,
      finalRials: 0,
      lines: ['no chargeable outage in window → lost-transaction value 0 IRR'],
    };
  }
  const sumOf = (pick: (b: MoneyBreakdown) => Rials): Rials => sumRials(...parts.map(pick));
  const gross = sumOf((b) => b.grossLostRials);
  const attributed = sumOf((b) => b.attributedRials);
  const credit = sumOf((b) => b.recoveryCreditRials);
  const net = sumOf((b) => b.netRials);
  const final = sumOf((b) => b.finalRials);
  const lines = parts.map(
    (p, i) =>
      `outage #${i + 1}: ${p.lines.join(' | ')}`,
  );
  lines.push(`window totals = gross ${formatRials(gross)}; attributed ${formatRials(attributed)}; recovery credit ${formatRials(credit)}; net ${formatRials(net)}; final ${formatRials(final)}`);
  return { grossLostRials: gross, attributedRials: attributed, recoveryCreditRials: credit, netRials: net, finalRials: final, lines };
}

// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA domain — versioned per-service money model (pure)
//
// A MoneyModel answers: "one second of lost transactions on this service is
// worth how many Rials, under which basis?" It is VERSIONED: an amendment
// creates a new version with `effectiveFrom`; incidents computed under an old
// version keep that version's numbers forever (audit requirement).
//
// Sources of transactions-per-second (txPerSecond):
//   • static              — one number
//   • hourOfWeekProfile   — 168 buckets, indexed by hour-of-week in the
//                           timezone given by `tzOffsetMinutes` (Tehran +210)
//   • promql              — resolved at evaluation time through an injected
//                           resolver (domain stays pure/offline-safe)
// ═══════════════════════════════════════════════════════════════════════════

import { DomainError, applyBps, lostValueRials, pctToBps, type Rials } from './money';

export { DomainError };

/** Static transactions-per-second. */
export interface TpsStatic {
  kind: 'static';
  tps: number;
}

/** 168 hourly buckets. Bucket 0 = Sunday 00:00 in `tzOffsetMinutes` time. */
export interface TpsHourOfWeekProfile {
  kind: 'hourOfWeekProfile';
  /** 168 entries, each a non-negative finite tps. */
  profile: number[];
  /** UTC offset of the profile's calendar, minutes. Tehran = +210. */
  tzOffsetMinutes: number;
}

/** PromQL source — resolved via an injected async/sync resolver by the caller. */
export interface TpsPromql {
  kind: 'promql';
  query: string;
  /** Used when no resolver is available (offline evaluation, golden tests). */
  fallbackTps?: number;
}

export type TxPerSecondSource = TpsStatic | TpsHourOfWeekProfile | TpsPromql;

/** What the lost money represents — the UI labels this honestly. */
export type MoneyBasis = 'revenue' | 'fee';

/** Versioned money model for one service. Amounts are integer Rials. */
export interface MoneyModel {
  /** Monotonic version; incidents pin the version they were computed with. */
  version: number;
  /** ISO instant from which this version applies (inclusive). */
  effectiveFrom: string;
  currency: 'IRR';
  /** Average ticket value per transaction, integer Rials. */
  avgTicketRials: Rials;
  txPerSecond: TxPerSecondSource;
  /** Share of outage minutes that truly lose transactions. Default 100 %. */
  failureAttributionPct: number;
  /** Share of failed transactions customers retry successfully later. Default 0 %. */
  recoveryFactorPct: number;
  /** Revenue vs lost fee/commission view. */
  basis: MoneyBasis;
  /** Multiplier applied after attribution+recovery (margin view). Default 100 %. */
  grossMarginOrFeePct: number;
}

/** Validated/normalised inputs for loss computation. */
export interface LossInput {
  /** Transactions-per-second in effect during the outage (pre-resolved). */
  tps: number;
  /** Outage length in seconds (integer). */
  seconds: number;
  /** Optional per-outage loss depth for partial/degraded outages: 10_000 = full loss. */
  lossBps?: number;
}

/** Step-by-step money breakdown with print-ready formula strings. */
export interface MoneyBreakdown {
  /** Gross lost-transaction value before any percentage adjustment. */
  grossLostRials: Rials;
  /** After failure attribution. */
  attributedRials: Rials;
  /** Credit for successful retries (recovery factor). */
  recoveryCreditRials: Rials;
  /** After recovery credit. */
  netRials: Rials;
  /** After margin/fee view — the number shown to executives. */
  finalRials: Rials;
  /** Human-auditable formula lines (FormulaPopover + PDF print these). */
  lines: string[];
}

const HOUR_OF_WEEK = 168;

/** Normalize minutes-into-week with wrap-around (always non-negative). */
function hourBucket(minutesIntoWeek: number, tzOffsetMinutes: number): number {
  const shifted = ((minutesIntoWeek + tzOffsetMinutes) % (HOUR_OF_WEEK * 60) + HOUR_OF_WEEK * 60) % (HOUR_OF_WEEK * 60);
  return Math.floor(shifted / 60);
}

/**
 * Resolve the tps in effect at instant `at` (ms epoch) for the given source.
 * Pure: promql without an injected resolver (or without a fallback) throws a
 * named DomainError instead of silently guessing.
 */
export function resolveTpsAt(
  source: TxPerSecondSource,
  at: Date,
  resolvePromql?: (query: string, at: Date) => number,
): number {
  if (source.kind === 'static') {
    if (!Number.isFinite(source.tps) || source.tps < 0) {
      throw new DomainError(`resolveTpsAt: static tps must be a finite non-negative number, got ${String(source.tps)}`);
    }
    return source.tps;
  }
  if (source.kind === 'hourOfWeekProfile') {
    if (!Array.isArray(source.profile) || source.profile.length !== HOUR_OF_WEEK) {
      throw new DomainError('resolveTpsAt: hourOfWeekProfile.profile must have exactly 168 entries');
    }
    const bucket = hourBucket(
      at.getUTCDay() * 1440 + at.getUTCHours() * 60 + at.getUTCMinutes(),
      source.tzOffsetMinutes,
    );
    const tps = source.profile[bucket]!;
    if (!Number.isFinite(tps) || tps < 0) {
      throw new DomainError(`resolveTpsAt: profile bucket ${bucket} holds an invalid tps (${String(tps)})`);
    }
    return tps;
  }
  // promql
  if (resolvePromql) return resolvePromql(source.query, at);
  if (source.fallbackTps !== undefined) return source.fallbackTps;
  throw new DomainError('resolveTpsAt: promql source requires an injected resolver or a fallbackTps');
}

/**
 * Full money breakdown for one outage under a money model.
 * Formula (single rounding per line, half-even at each stated final step):
 *   gross      = tps × seconds × avgTicket (exact via BigInt fixed-point)
 *   attributed = gross × attribution%
 *   net        = attributed × (1 − recovery%)
 *   final      = net × grossMarginOrFee%
 */
export function computeLoss(model: MoneyModel, input: LossInput): MoneyBreakdown {
  if (!Number.isSafeInteger(input.seconds) || input.seconds < 0) {
    throw new DomainError(`computeLoss: seconds must be a safe non-negative integer, got ${String(input.seconds)}`);
  }
  const lossBps = input.lossBps ?? 10_000;
  if (!Number.isSafeInteger(lossBps) || lossBps < 0 || lossBps > 10_000) {
    throw new DomainError(`computeLoss: lossBps must be an integer in [0, 10000], got ${String(lossBps)}`);
  }
  if (!Number.isFinite(input.tps) || input.tps < 0) {
    throw new DomainError(`computeLoss: tps must be finite and ≥ 0, got ${String(input.tps)}`);
  }
  if (!Number.isSafeInteger(model.avgTicketRials) || model.avgTicketRials < 0) {
    throw new DomainError(`computeLoss: avgTicketRials must be a safe non-negative integer, got ${String(model.avgTicketRials)}`);
  }

  const gross = lostValueRials(input.tps, input.seconds, model.avgTicketRials, lossBps);
  const attributionBps = pctToBps(model.failureAttributionPct);
  const recoveryBps = pctToBps(model.recoveryFactorPct);
  const marginBps = pctToBps(model.grossMarginOrFeePct);

  const attributed = applyBps(gross, attributionBps);
  const recoveryCredit = applyBps(attributed, recoveryBps);
  const net = attributed - recoveryCredit;
  const final = applyBps(net, marginBps);

  const pct = (bps: number): string => `${bps / 100}%`;
  const lines = [
    `gross lost value = tps(${input.tps}) × seconds(${input.seconds}) × avgTicket(${model.avgTicketRials} IRR) = ${gross.toLocaleString('en-US')} IRR`,
    `attribution = ${gross.toLocaleString('en-US')} × ${pct(attributionBps)} = ${attributed.toLocaleString('en-US')} IRR`,
    `recovery credit = ${attributed.toLocaleString('en-US')} × ${pct(recoveryBps)} = ${recoveryCredit.toLocaleString('en-US')} IRR`,
    `net = ${attributed.toLocaleString('en-US')} − ${recoveryCredit.toLocaleString('en-US')} = ${net.toLocaleString('en-US')} IRR`,
    `final (${model.basis} basis, margin ${pct(marginBps)}) = ${final.toLocaleString('en-US')} IRR`,
  ];

  return { grossLostRials: gross, attributedRials: attributed, recoveryCreditRials: recoveryCredit, netRials: net, finalRials: final, lines };
}

/** Validate a MoneyModel read from an untrusted boundary (API/db/UI). */
export function validateMoneyModel(m: MoneyModel): void {
  if (!Number.isSafeInteger(m.version) || m.version < 1) {
    throw new DomainError(`moneyModel.version must be a positive integer, got ${String(m.version)}`);
  }
  if (Number.isNaN(Date.parse(m.effectiveFrom))) {
    throw new DomainError(`moneyModel.effectiveFrom must be an ISO instant, got ${String(m.effectiveFrom)}`);
  }
  if (m.currency !== 'IRR') {
    throw new DomainError(`moneyModel.currency must be 'IRR', got ${String(m.currency)}`);
  }
  if (!Number.isSafeInteger(m.avgTicketRials) || m.avgTicketRials < 0) {
    throw new DomainError(`moneyModel.avgTicketRials must be a safe non-negative integer, got ${String(m.avgTicketRials)}`);
  }
  pctToBps(m.failureAttributionPct);
  pctToBps(m.recoveryFactorPct);
  pctToBps(m.grossMarginOrFeePct);
  if (m.basis !== 'revenue' && m.basis !== 'fee') {
    throw new DomainError(`moneyModel.basis must be 'revenue' or 'fee', got ${String(m.basis)}`);
  }
  // tps source shape
  if (m.txPerSecond.kind === 'hourOfWeekProfile') {
    if (m.txPerSecond.profile.length !== HOUR_OF_WEEK) {
      throw new DomainError('moneyModel.txPerSecond: hourOfWeekProfile must have exactly 168 entries');
    }
  } else if (m.txPerSecond.kind === 'static') {
    if (!Number.isFinite(m.txPerSecond.tps) || m.txPerSecond.tps < 0) {
      throw new DomainError('moneyModel.txPerSecond: static tps must be finite and ≥ 0');
    }
  } else if (m.txPerSecond.kind === 'promql') {
    if (typeof m.txPerSecond.query !== 'string' || m.txPerSecond.query.length === 0) {
      throw new DomainError('moneyModel.txPerSecond: promql query must be a non-empty string');
    }
  } else {
    throw new DomainError('moneyModel.txPerSecond: unknown source kind');
  }
}

/** Convenience: a sane default model for tests/demo seeding. */
export function defaultMoneyModel(overrides: Partial<MoneyModel> = {}): MoneyModel {
  return {
    version: 1,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    currency: 'IRR',
    avgTicketRials: 2_500_000, // 250,000 Tomans
    txPerSecond: { kind: 'static', tps: 40 },
    failureAttributionPct: 100,
    recoveryFactorPct: 0,
    basis: 'revenue',
    grossMarginOrFeePct: 100,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA domain — SLA contract model (pure)
//
// A Contract binds one tenant (optionally one service) to:
//   • a target availability,
//   • a measurement window kind (calendar chosen by the caller — Jalali or
//     Gregorian; the domain receives concrete [startSec, endSec) bounds),
//   • a minimum outage duration that counts,
//   • a penalty scheme: percentage-of-fee TIERS or FIXED + PER-MINUTE,
//   • a monthly fee, an optional penalty cap, grace minutes and the two
//     exclusion switches (planned / external).
//
// Contracts are VERSIONED like money models; evaluations always record the
// contract version they used.
// ═══════════════════════════════════════════════════════════════════════════

import { DomainError, applyPct, pctToBps, sumRials, type Rials } from './money';
import type { ExclusionPolicy, Outage } from './outage';

/** Percentage-of-monthly-fee tier: availability strictly below `belowPct` → `penaltyPct` of the fee. */
export interface PenaltyTier {
  belowPct: number; // e.g. 99.9
  penaltyPct: number; // e.g. 5 → 5 % of the monthly fee
}

export type PenaltyScheme =
  | { mode: 'tiers'; tiers: PenaltyTier[] }
  | { mode: 'fixedPerMinute'; baseRials: Rials; perMinuteRials: Rials };

export type WindowKind = 'gregorian-month' | 'jalali-month';

/** Versioned SLA contract for one tenant (optionally scoped to one service). */
export interface Contract {
  version: number;
  effectiveFrom: string;
  tenantId: string;
  /** null = applies to every service of the tenant. */
  serviceKey: string | null;
  targetAvailabilityPct: number; // e.g. 99.9
  windowKind: WindowKind;
  /** Outages shorter than this (seconds) never count. Default 0. */
  minChargeableOutageSec: number;
  penalty: PenaltyScheme;
  monthlyFeeRials: Rials;
  /** Hard ceiling on the computed penalty for the window. null = uncapped. */
  penaltyCapRials: Rials | null;
  /** Downtime forgiven per window, minutes (subtracted once, after merging). */
  graceMinutes: number;
  excludePlanned: boolean;
  excludeExternal: boolean;
}

/** ExclusionPolicy view of a contract (for the outage module). */
export function exclusionPolicyOf(c: Contract): ExclusionPolicy {
  return { excludePlanned: c.excludePlanned, excludeExternal: c.excludeExternal };
}

/** Highest matching tier for an availability, or null when the target is met. */
export function tierForAvailability(c: Contract, availabilityPct: number): PenaltyTier | null {
  if (c.penalty.mode !== 'tiers') {
    throw new DomainError('tierForAvailability: contract penalty mode is not "tiers"');
  }
  if (!Number.isFinite(availabilityPct) || availabilityPct < 0 || availabilityPct > 100) {
    throw new DomainError(`tierForAvailability: availability must be in [0, 100], got ${String(availabilityPct)}`);
  }
  let match: PenaltyTier | null = null;
  // ascending threshold scan — the FIRST matching threshold (the lowest
  // belowPct still above the availability) is the deepest tier (99.4 % hits
  // "below 99.9 → 5 %" AND "below 99.5 → 15 %"; the 15 % tier wins).
  const ascending = [...c.penalty.tiers].sort((a, b) => a.belowPct - b.belowPct);
  for (const t of ascending) {
    if (availabilityPct < t.belowPct) {
      match = t;
      break;
    }
  }
  return match;
}

/**
 * Fixed + per-minute penalty for a number of chargeable SECONDS.
 * `weightPct` scales the per-minute part for partial-severity incidents
 * (the engine's warning = 30 %). Minutes are ceil'd with a 1-minute minimum —
 * the exact rule the v1.5 engine used (characterisation-locked).
 * Rounding: half-even once, on the final amount.
 */
export function penaltyFixedPerMinute(
  baseRials: Rials,
  perMinuteRials: Rials,
  seconds: number,
  weightPct = 100,
): Rials {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new DomainError(`penaltyFixedPerMinute: seconds must be a safe non-negative integer, got ${String(seconds)}`);
  }
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const perMinuteTotal = perMinuteRials * minutes;
  if (!Number.isSafeInteger(perMinuteTotal)) {
    throw new DomainError(`penaltyFixedPerMinute: perMinute(${perMinuteRials}) × minutes(${minutes}) exceeded the safe-integer envelope`);
  }
  const full = sumRials(baseRials, perMinuteTotal);
  return applyPct(full, weightPct);
}

/** Cap helper — cap applies at the very end of every penalty formula. */
export function capPenalty(penalty: Rials, capRials: Rials | null): Rials {
  if (capRials === null) return penalty;
  if (!Number.isSafeInteger(capRials) || capRials < 0) {
    throw new DomainError(`capPenalty: cap must be a safe non-negative integer or null, got ${String(capRials)}`);
  }
  return Math.min(penalty, capRials);
}

/** Validate a Contract from an untrusted boundary. */
export function validateContract(c: Contract): void {
  if (!Number.isSafeInteger(c.version) || c.version < 1) {
    throw new DomainError(`contract.version must be a positive integer, got ${String(c.version)}`);
  }
  if (Number.isNaN(Date.parse(c.effectiveFrom))) {
    throw new DomainError(`contract.effectiveFrom must be an ISO instant, got ${String(c.effectiveFrom)}`);
  }
  if (typeof c.tenantId !== 'string' || c.tenantId.length === 0) {
    throw new DomainError('contract.tenantId must be a non-empty string');
  }
  if (c.serviceKey !== null && (typeof c.serviceKey !== 'string' || c.serviceKey.length === 0)) {
    throw new DomainError('contract.serviceKey must be null or a non-empty string');
  }
  if (!Number.isFinite(c.targetAvailabilityPct) || c.targetAvailabilityPct < 0 || c.targetAvailabilityPct > 100) {
    throw new DomainError(`contract.targetAvailabilityPct must be in [0, 100], got ${String(c.targetAvailabilityPct)}`);
  }
  if (c.windowKind !== 'gregorian-month' && c.windowKind !== 'jalali-month') {
    throw new DomainError(`contract.windowKind must be 'gregorian-month' | 'jalali-month', got ${String(c.windowKind)}`);
  }
  if (!Number.isSafeInteger(c.minChargeableOutageSec) || c.minChargeableOutageSec < 0) {
    throw new DomainError('contract.minChargeableOutageSec must be a safe non-negative integer');
  }
  if (!Number.isSafeInteger(c.monthlyFeeRials) || c.monthlyFeeRials < 0) {
    throw new DomainError('contract.monthlyFeeRials must be a safe non-negative integer');
  }
  if (c.penaltyCapRials !== null && (!Number.isSafeInteger(c.penaltyCapRials) || c.penaltyCapRials < 0)) {
    throw new DomainError('contract.penaltyCapRials must be a safe non-negative integer or null');
  }
  if (!Number.isSafeInteger(c.graceMinutes) || c.graceMinutes < 0) {
    throw new DomainError('contract.graceMinutes must be a safe non-negative integer');
  }
  pctToBps(c.targetAvailabilityPct); // ≤ 2 decimal places
  if (c.penalty.mode === 'tiers') {
    if (!Array.isArray(c.penalty.tiers) || c.penalty.tiers.length === 0) {
      throw new DomainError('contract.penalty: tiers mode requires at least one tier');
    }
    for (const t of c.penalty.tiers) {
      if (!Number.isFinite(t.belowPct) || t.belowPct <= 0 || t.belowPct > 100) {
        throw new DomainError(`contract.penalty: tier belowPct must be in (0, 100], got ${String(t.belowPct)}`);
      }
      if (!Number.isFinite(t.penaltyPct) || t.penaltyPct < 0 || t.penaltyPct > 100) {
        throw new DomainError(`contract.penalty: tier penaltyPct must be in [0, 100], got ${String(t.penaltyPct)}`);
      }
    }
  } else if (c.penalty.mode === 'fixedPerMinute') {
    if (!Number.isSafeInteger(c.penalty.baseRials) || c.penalty.baseRials < 0) {
      throw new DomainError('contract.penalty: baseRials must be a safe non-negative integer');
    }
    if (!Number.isSafeInteger(c.penalty.perMinuteRials) || c.penalty.perMinuteRials < 0) {
      throw new DomainError('contract.penalty: perMinuteRials must be a safe non-negative integer');
    }
  } else {
    throw new DomainError('contract.penalty: unknown mode');
  }
}

/** Convenience: default contract fixture for tests/demo seeding. */
export function defaultContract(overrides: Partial<Contract> = {}): Contract {
  return {
    version: 1,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    tenantId: 'tenant-demo',
    serviceKey: null,
    targetAvailabilityPct: 99.9,
    windowKind: 'jalali-month',
    minChargeableOutageSec: 0,
    penalty: { mode: 'tiers', tiers: [
      { belowPct: 99.9, penaltyPct: 5 },
      { belowPct: 99.5, penaltyPct: 15 },
      { belowPct: 99.0, penaltyPct: 30 },
    ] },
    monthlyFeeRials: 1_000_000_000, // 100,000,000 Tomans
    penaltyCapRials: null,
    graceMinutes: 0,
    excludePlanned: true,
    excludeExternal: true,
    ...overrides,
  };
}

/** Re-export so callers need only the contract module for tier math. */
export { applyPct };

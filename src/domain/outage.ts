// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA domain — outage classification & overlap merging (pure)
//
// Categories:
//   • chargeable — counts against the provider
//   • planned    — maintenance window (counts only when the contract does not
//                  exclude planned downtime)
//   • external   — force-majeure / upstream cause (same conditional)
//
// Overlap rule (normative, docs/DOMAIN.md): for overlapping outages the
// category that COUNTS AGAINST THE PROVIDER wins the overlap. Precedence:
//   chargeable > external > planned.
// Rationale: a provider may not launder a genuine outage by parking a
// maintenance window or an "external cause" claim on top of it. When both
// non-chargeable categories overlap, `external` wins the label (more specific
// cause) — money-wise they are equivalent once exclusions apply.
//
// Intervals are half-open [startSec, endSec) in EPOCH SECONDS; touching
// intervals (a.end == b.start) of the same winning category merge.
// ═══════════════════════════════════════════════════════════════════════════

import { DomainError } from './money';

export type OutageCategory = 'chargeable' | 'planned' | 'external';

/** An outage interval. Epoch seconds, half-open. */
export interface Outage {
  /** Stable identifier (incident id) carried through merging for evidence. */
  id?: string;
  startSec: number;
  endSec: number;
  category: OutageCategory;
  /**
   * Loss depth for partial (degraded) outages: 10_000 = full transaction
   * loss. Applies to the MONEY math only; availability counts the seconds.
   */
  lossBps?: number;
}

/** Contract switches that decide whether exclusions actually exclude. */
export interface ExclusionPolicy {
  excludePlanned: boolean;
  excludeExternal: boolean;
}

const PRECEDENCE: Record<OutageCategory, number> = { chargeable: 2, external: 1, planned: 0 };

/** Effective loss depth (undefined = full loss). */
function lossDepth(o: Outage): number {
  return o.lossBps ?? 10_000;
}

/** Apply the contract's exclusion flags: an unexcluded cause becomes chargeable. */
export function effectiveCategory(o: Outage, policy: ExclusionPolicy): OutageCategory {
  switch (o.category) {
    case 'chargeable':
      return 'chargeable';
    case 'planned':
      return policy.excludePlanned ? 'planned' : 'chargeable';
    case 'external':
      return policy.excludeExternal ? 'external' : 'chargeable';
    default: {
      const never: never = o.category;
      throw new DomainError(`effectiveCategory: unknown category ${String(never)}`);
    }
  }
}

function validateOutage(o: Outage, label: string): void {
  for (const [field, v] of [
    ['startSec', o.startSec],
    ['endSec', o.endSec],
  ] as const) {
    if (!Number.isSafeInteger(v)) {
      throw new DomainError(`${label}: ${field} must be a safe integer (epoch seconds), got ${String(v)}`);
    }
  }
  if (o.endSec < o.startSec) {
    throw new DomainError(`${label}: endSec (${o.endSec}) < startSec (${o.startSec})`);
  }
  if (!(o.category in PRECEDENCE)) {
    throw new DomainError(`${label}: unknown category ${String(o.category)}`);
  }
  if (o.lossBps !== undefined && (!Number.isSafeInteger(o.lossBps) || o.lossBps < 0 || o.lossBps > 10_000)) {
    throw new DomainError(`${label}: lossBps must be an integer in [0, 10000], got ${String(o.lossBps)}`);
  }
}

/**
 * Sweep-line merge. Produces a minimal list of half-open intervals tagged with
 * the winning effective category. Zero-length outages are dropped. Adjacent
 * segments with the same winner merge. Worst case O(n log n + n·k).
 */
export function mergeOutages(outages: Outage[], policy: ExclusionPolicy): Outage[] {
  const valid = outages.map((o, i) => {
    validateOutage(o, `outages[${i}]`);
    return { ...o, category: effectiveCategory(o, policy) };
  });

  // Boundary points where coverage can change.
  const points = new Set<number>();
  for (const o of valid) {
    if (o.endSec > o.startSec) {
      points.add(o.startSec);
      points.add(o.endSec);
    }
  }
  const sorted = [...points].sort((a, b) => a - b);
  const merged: Outage[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    // Outages covering [a, b).
    const covering = valid.filter((o) => o.startSec <= a && o.endSec >= b);
    if (covering.length === 0) continue;
    let winner = covering[0]!;
    for (const c of covering) {
      // Deeper category precedence wins; on a tie, the deeper transaction
      // loss wins (counts against the provider the most); otherwise the
      // earliest input wins (deterministic).
      if (
        PRECEDENCE[c.category] > PRECEDENCE[winner.category] ||
        (PRECEDENCE[c.category] === PRECEDENCE[winner.category] && lossDepth(c) > lossDepth(winner))
      ) {
        winner = c;
      }
    }
    const last = merged[merged.length - 1];
    if (
      last &&
      last.endSec === a &&
      last.category === winner.category &&
      lossDepth(last) === lossDepth(winner)
    ) {
      // extend (also merges touching intervals of equal category & depth)
      last.endSec = b;
    } else {
      merged.push({
        id: winner.id,
        startSec: a,
        endSec: b,
        category: winner.category,
        ...(winner.lossBps !== undefined ? { lossBps: winner.lossBps } : {}),
      });
    }
  }
  return merged;
}

/** Clip outages to a window (half-open). Non-overlapping remainder dropped. */
export function clipOutagesToWindow(outages: Outage[], windowStartSec: number, windowEndSec: number): Outage[] {
  if (!Number.isSafeInteger(windowStartSec) || !Number.isSafeInteger(windowEndSec)) {
    throw new DomainError('clipOutagesToWindow: window bounds must be safe integers');
  }
  if (windowEndSec <= windowStartSec) return [];
  return outages
    .map((o) => {
      validateOutage(o, 'clipOutagesToWindow input');
      return {
        ...o,
        startSec: Math.max(o.startSec, windowStartSec),
        endSec: Math.min(o.endSec, windowEndSec),
      };
    })
    .filter((o) => o.endSec > o.startSec);
}

/** Total covered seconds of a (possibly overlapping) list — via exact merge. */
export function totalSeconds(outages: Outage[], policy: ExclusionPolicy = { excludePlanned: false, excludeExternal: false }): number {
  return mergeOutages(outages, policy).reduce((acc, o) => acc + (o.endSec - o.startSec), 0);
}

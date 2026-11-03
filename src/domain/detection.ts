// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA domain — live-mode detection state machine (pure)
//
// the ingestion worker feeds probe samples through this state
// machine. Rules(docs/ARCHITECTURE.md):
//   • open an incident after N consecutive failed samples (default 3)
//   • resolve after M consecutive successful samples (default 2)
//   • Prometheus unreachable / empty result = STALE: the state is frozen and
//     the caller must raise a "monitoring blind" alert — missing data is
//     NEVER treated as healthy and NEVER as an outage.
// ═══════════════════════════════════════════════════════════════════════════

import { DomainError } from './money';

/** One resolved probe sample. `ok` is computed by the fetcher per source kind. */
export interface LiveSample {
  ok: boolean;
  /** Raw value observed (probe_success 0/1, or good/total ratio). */
  value: number;
  atMs: number;
}

export interface DetectionConfig {
  /** Consecutive failed samples before an incident opens. Default 3. */
  failureThreshold: number;
  /** Consecutive successful samples before an incident resolves. Default 2. */
  successThreshold: number;
}

export type DetectionTransition = 'none' | 'open' | 'resolve';

export interface DetectionState {
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Whether the caller should currently have an incident open. */
  incidentOpen: boolean;
  /** What the caller must do after this sample. */
  transition: DetectionTransition;
}

export const DEFAULT_DETECTION: DetectionConfig = { failureThreshold: 3, successThreshold: 2 };

export function validateDetectionConfig(c: DetectionConfig): void {
  for (const [k, v] of [
    ['failureThreshold', c.failureThreshold],
    ['successThreshold', c.successThreshold],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 1 || v > 1000) {
      throw new DomainError(`detection.${k} must be an integer in [1, 1000], got ${String(v)}`);
    }
  }
}

/** State after a SUCCESSFUL probe sample (the fetcher resolved a value). */
export function applySample(
  prev: DetectionState,
  sample: LiveSample,
  config: DetectionConfig = DEFAULT_DETECTION,
): DetectionState {
  validateDetectionConfig(config);
  const next: DetectionState = {
    consecutiveFailures: prev.consecutiveFailures,
    consecutiveSuccesses: prev.consecutiveSuccesses,
    incidentOpen: prev.incidentOpen,
    transition: 'none',
  };
  if (sample.ok) {
    next.consecutiveSuccesses = prev.consecutiveSuccesses + 1;
    next.consecutiveFailures = 0;
    if (prev.incidentOpen && next.consecutiveSuccesses >= config.successThreshold) {
      next.incidentOpen = false;
      next.transition = 'resolve';
    }
  } else {
    next.consecutiveFailures = prev.consecutiveFailures + 1;
    next.consecutiveSuccesses = 0;
    if (!prev.incidentOpen && next.consecutiveFailures >= config.failureThreshold) {
      next.incidentOpen = true;
      next.transition = 'open';
    }
  }
  return next;
}

/**
 * State after a FAILED FETCH (Prometheus unreachable / empty / non-series
 * response): everything freezes — streaks, open-incident flag — and the
 * transition is always 'none'. The caller marks the service stale and raises
 * the "monitoring blind" alert; it must not decide up or down.
 */
export function applyStale(prev: DetectionState): DetectionState {
  return { ...prev, transition: 'none' };
}

/** Decide `ok` for a blackbox probe_success value (1 = up, 0 = down). */
export function blackboxOk(value: number): boolean {
  return value >= 1;
}

/** Decide `ok` for an availability SLI ratio against the SLO target. */
export function sliRatioOk(good: number, total: number, sloTarget: number): boolean {
  if (!Number.isFinite(good) || !Number.isFinite(total) || total <= 0) {
    throw new DomainError(`sliRatioOk: total must be a positive finite number, got ${String(total)}`);
  }
  if (!Number.isFinite(sloTarget) || sloTarget <= 0 || sloTarget > 1) {
    throw new DomainError(`sliRatioOk: sloTarget must be in (0, 1], got ${String(sloTarget)}`);
  }
  return good / total >= sloTarget;
}

// Sentinel-SLA — pure core behind the §6.4 StatCard delta and the §6.8
// TimeRange picker. No React here: the components in
// src/components/sentinel/{stat-card,time-range}.tsx render it, unit tests
// pin the math (truthful-numbers rule — the sign and window semantics are
// part of the product contract, not a styling detail).

export type TimeRangePreset = '1h' | '24h' | '7d' | '30d' | 'custom'

export interface TimeRangeValue {
  preset: TimeRangePreset
  /** Inclusive lower bound; null = unbounded (never for presets). */
  from: Date | null
  /** Inclusive upper bound; null = open-ended (presets mean "up to now"). */
  to: Date | null
}

export interface StatDelta {
  /** Signed delta in the same unit as the figure (caller-formatted). */
  value: number
  /** Format the numeric part, e.g. (n) => `${n.toFixed(1)} %`. */
  format?: (n: number) => string
  /** Semantic direction of GOOD news: uptime up is good, penalty up is bad. */
  goodWhen?: 'up' | 'down'
  /** Accessible description when the visual arrow alone is not enough. */
  ariaLabel?: string
}

/** Milliseconds each preset reaches back. */
export const PRESET_MS: Record<Exclude<TimeRangePreset, 'custom'>, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

export const TIME_RANGE_PRESETS = Object.keys(PRESET_MS) as Array<Exclude<TimeRangePreset, 'custom'>>

/**
 * Pure helper: the concrete window a preset selects at `now`. Custom ranges
 * pass their own bounds and are returned untouched.
 */
export function resolveRange(
  value: TimeRangeValue,
  now: Date = new Date(),
): { from: Date | null; to: Date | null } {
  if (value.preset === 'custom') return { from: value.from, to: value.to }
  return { from: new Date(now.getTime() - PRESET_MS[value.preset]), to: null }
}

/** Widen a picked local midnight to the end of that day (inclusive To). */
export function endOfDay(d: Date): Date {
  const e = new Date(d)
  e.setHours(23, 59, 59, 999)
  return e
}

/**
 * The signed label behind the delta arrow: "+" or "−" is ALWAYS explicit
 * (§6.4 "delta with arrow AND sign"). ASCII "-" keeps bidi handling
 * predictable in the FA table context; a U+2212 from a caller formatter is
 * normalised so sorting/copying stays consistent.
 */
export function deltaLabel(delta: StatDelta): string {
  const raw = delta.format
    ? delta.format(delta.value)
    : Math.round(delta.value).toLocaleString('en-US')
  if (delta.value > 0) return `+${raw}`
  if (delta.value < 0) return raw.startsWith('-') ? raw : `-${raw.replace(/^\u2212/, '')}`
  return raw === '-' ? raw : `±${raw}`
}

/** Semantic colour of the delta: good news, bad news or flat. */
export function deltaTone(delta: StatDelta): 'good' | 'bad' | 'flat' {
  if (delta.value === 0) return 'flat'
  const up = delta.value > 0
  const good = delta.goodWhen === 'down' ? !up : up
  return good ? 'good' : 'bad'
}

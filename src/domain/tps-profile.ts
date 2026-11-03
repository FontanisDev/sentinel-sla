// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA domain — hour-of-week transaction profile (pure)
//
// A service's money figure is `tps × seconds × avgTicket`. A flat tps
// overstates weekend nights and understates the 20:00–23:00 Iranian peak,
// so a service may carry a 168-bucket profile derived from a PSP/Shaparak
// transaction-count report ("Shaparak/PSP-style transaction-count
// sources"). Buckets are indexed by WALL-CLOCK hour-of-week in the profile's
// own tz offset (Tehran +210) — the same convention resolveTpsAt() uses for
// MoneyModel.hourOfWeekProfile, so both paths agree bucket-for-bucket.
//
// Everything here is pure: no db, no clock, no HTTP.
// ═══════════════════════════════════════════════════════════════════════════

import { DomainError } from './money';

export const HOUR_OF_WEEK = 168;

/** Tehran is UTC+03:30 (Iran abolished DST in 2022). */
export const TEHRAN_TZ_OFFSET_MINUTES = 210;

/** The persisted profile shape (stored as JSON on the service row). */
export interface TpsProfile {
  /** 168 entries, each a finite tps ≥ 0. Bucket 0 = Sunday 00:00 wall clock. */
  buckets: number[];
  /** UTC offset of the profile's calendar, minutes. Tehran = +210. */
  tzOffsetMinutes: number;
}

/** Where one sample lands: a wall-clock hour-of-week bucket. */
export interface BucketSample {
  /** 0..167 — wall-clock hour-of-week bucket in the profile's tz. */
  bucket: number;
  /** Transaction count observed during that hour (≥ 0, finite). */
  txCount: number;
}

/** Aggregation summary the UI reports honestly. */
export interface ProfileSummary {
  /** Per-bucket mean tps = mean count / 3600. */
  buckets: number[];
  tzOffsetMinutes: number;
  /** Buckets with at least one sample, of 168. */
  coveredBuckets: number;
  /** Samples that survived parsing. */
  rowsUsed: number;
  /** Samples rejected by the parser (each reported with its reason). */
  rowsRejected: number;
  /** Arithmetic mean tps across COVERED buckets (null when nothing parsed). */
  meanTps: number | null;
  /** Highest bucket: index + tps (null when nothing parsed). */
  peak: { bucket: number; tps: number } | null;
  /** Lowest covered bucket: index + tps (null when nothing parsed). */
  trough: { bucket: number; tps: number } | null;
}

/** Normalize minutes-into-week with wrap-around (always non-negative). */
function shiftIntoWeek(minutesIntoWeekUtc: number, tzOffsetMinutes: number): number {
  const week = HOUR_OF_WEEK * 60;
  return (((minutesIntoWeekUtc + tzOffsetMinutes) % week) + week) % week;
}

/**
 * Bucket for an instant: the wall-clock hour-of-week bucket that instant
 * falls into, in `tzOffsetMinutes` time. Mirrors resolveTpsAt() exactly.
 */
export function bucketForInstant(at: Date, tzOffsetMinutes: number): number {
  const minutes = shiftIntoWeek(
    at.getUTCDay() * 1440 + at.getUTCHours() * 60 + at.getUTCMinutes(),
    tzOffsetMinutes,
  );
  return Math.floor(minutes / 60);
}

/** Bucket for a known wall-clock day/hour (e.g. a report row "Saturday 21:00"). */
export function bucketForWallClock(dayOfWeek: number, hour: number): number {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    throw new DomainError(`bucketForWallClock: dayOfWeek must be 0..6, got ${String(dayOfWeek)}`);
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new DomainError(`bucketForWallClock: hour must be 0..23, got ${String(hour)}`);
  }
  return dayOfWeek * 24 + hour;
}

/** Validate a profile read from an untrusted boundary (API/db/UI). */
export function validateTpsProfile(p: unknown): TpsProfile {
  if (typeof p !== 'object' || p === null) {
    throw new DomainError('tpsProfile must be a JSON object');
  }
  const profile = p as Partial<TpsProfile>;
  if (!Array.isArray(profile.buckets) || profile.buckets.length !== HOUR_OF_WEEK) {
    throw new DomainError(`tpsProfile.buckets must have exactly ${HOUR_OF_WEEK} entries`);
  }
  for (let i = 0; i < HOUR_OF_WEEK; i++) {
    const tps = profile.buckets[i];
    if (typeof tps !== 'number' || !Number.isFinite(tps) || tps < 0) {
      throw new DomainError(`tpsProfile.buckets[${i}] must be a finite tps ≥ 0, got ${String(tps)}`);
    }
  }
  if (typeof profile.tzOffsetMinutes !== 'number' || !Number.isInteger(profile.tzOffsetMinutes) || Math.abs(profile.tzOffsetMinutes) > 840) {
    throw new DomainError('tpsProfile.tzOffsetMinutes must be an integer within ±840');
  }
  return { buckets: profile.buckets as number[], tzOffsetMinutes: profile.tzOffsetMinutes };
}

/**
 * Aggregate bucket samples into a profile: each bucket holds the MEAN count
 * of the samples that landed there, divided by 3600 → tps. Buckets with no
 * samples stay 0 — the summary's `coveredBuckets` says so honestly (the UI
 * warns when coverage is thin; it never fills gaps by guessing).
 */
export function aggregateProfile(samples: BucketSample[], tzOffsetMinutes: number): ProfileSummary {
  if (!Number.isInteger(tzOffsetMinutes) || Math.abs(tzOffsetMinutes) > 840) {
    throw new DomainError(`aggregateProfile: tzOffsetMinutes must be an integer within ±840, got ${String(tzOffsetMinutes)}`);
  }
  const sums = new Array<number>(HOUR_OF_WEEK).fill(0);
  const counts = new Array<number>(HOUR_OF_WEEK).fill(0);

  for (const s of samples) {
    if (!Number.isInteger(s.bucket) || s.bucket < 0 || s.bucket >= HOUR_OF_WEEK) {
      throw new DomainError(`aggregateProfile: sample bucket must be 0..${HOUR_OF_WEEK - 1}, got ${String(s.bucket)}`);
    }
    if (typeof s.txCount !== 'number' || !Number.isFinite(s.txCount) || s.txCount < 0) {
      throw new DomainError(`aggregateProfile: sample txCount must be a finite number ≥ 0, got ${String(s.txCount)}`);
    }
    sums[s.bucket]! += s.txCount;
    counts[s.bucket]! += 1;
  }

  const buckets = new Array<number>(HOUR_OF_WEEK).fill(0);
  let covered = 0;
  let total = 0;
  let peak: ProfileSummary['peak'] = null;
  let trough: ProfileSummary['trough'] = null;
  for (let b = 0; b < HOUR_OF_WEEK; b++) {
    if (counts[b]! > 0) {
      covered += 1;
      buckets[b] = sums[b]! / counts[b]! / 3600;
      total += buckets[b]!;
      if (peak === null || buckets[b]! > peak.tps) peak = { bucket: b, tps: buckets[b]! };
      if (trough === null || buckets[b]! < trough.tps) trough = { bucket: b, tps: buckets[b]! };
    }
  }

  return {
    buckets,
    tzOffsetMinutes,
    coveredBuckets: covered,
    rowsUsed: samples.length,
    rowsRejected: 0, // the parser layer overwrites this with its real count
    meanTps: covered > 0 ? total / covered : null,
    peak,
    trough,
  };
}

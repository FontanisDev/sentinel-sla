// Sentinel-SLA — Shaparak/PSP transaction-count CSV import (
// "Shaparak/PSP-style transaction-count sources").
//
// PSP panels and Shaparak settlement reports export hourly transaction
// counts as CSV. This parser turns such a sheet into the 168-bucket
// hour-of-week tps profile the money model resolves outages with — so a
// one-second outage at Thursday 21:00 costs what Thursday 21:00 actually
// does, not a flat weekly average (docs/DOMAIN.md §"transaction profile").
//
// Two accepted shapes (headers in English or Persian, matched loosely):
//   • timestamped — `timestamp|time|datetime|زمان|تاریخ و ساعت` + a count
//     column. Naive timestamps (no Z / ±hh:mm) are read as TEHRAN WALL
//     CLOCK — that is the calendar every Shaparak/PSP export uses and the
//     product's default tz; offset-aware timestamps use their own instant.
//   • calendar    — `date|day|تاریخ` + `hour|ساعت` + a count column.
//     Dates may be Gregorian (2026-10-01) or Jalali (1404/07/01 — the
//     native calendar of every domestic report); hours 0–23 or HH:MM.
//
// Counts accept Latin, Persian (۰-۹) and Arabic-Indic (٠-٩) digits plus
// thousands separators (`,` or `٬`). Everything here is PURE (same rule as
// csv-import/grafana-import/zabbix-import): the route composes these
// helpers with authz, tenant scoping and the write — a dry-run is the same
// pipeline with the write removed.

import { jalaliToGregorian } from '@/lib/jalali';
import { parseCsv } from './csv-import';
import {
  aggregateProfile,
  bucketForInstant,
  bucketForWallClock,
  HOUR_OF_WEEK,
  TEHRAN_TZ_OFFSET_MINUTES,
  type BucketSample,
  type ProfileSummary,
} from '@/domain/tps-profile';

/** Import caps (DoS guard; 2016 = 12 weeks of hourly rows). */
export const SHAPARAK_MAX_BYTES = 512 * 1024;
export const SHAPARAK_MAX_ROWS = 2016;

// ── cell normalization ───────────────────────────────────────────────────

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Persian/Arabic-Indic digits → Latin; strip ZWNJ and thousands marks. */
export function normalizeDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) {
      out += String(p);
      continue;
    }
    const a = ARABIC_DIGITS.indexOf(ch);
    if (a >= 0) {
      out += String(a);
      continue;
    }
    if (ch === '\u200c') continue; // ZWNJ — joining marker, not content
    out += ch;
  }
  return out;
}

/** Parse "1,234" / "۱٬۲۳۴" / "1234" → number, or null when not a count. */
export function parseCount(raw: string): number | null {
  const cleaned = normalizeDigits(raw).replace(/[,\s_٬]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Header normalization: case/space/-/_ insensitive, ZWNJ stripped. */
function normHeader(h: string): string {
  return normalizeDigits(h).trim().toLowerCase().replace(/[\s_\-\u200c]+/g, '');
}

const TIMESTAMP_HEADERS = new Set(['timestamp', 'time', 'datetime', 'زمان', 'تاریخوساعت']);
const CALENDAR_DATE_HEADERS = new Set(['date', 'day', 'تاریخ', 'روز']);
const HOUR_HEADERS = new Set(['hour', 'hr', 'ساعت']);
const COUNT_HEADERS = new Set([
  'txcount', 'transactions', 'transactioncount', 'count', 'tx', 'txn', 'transactionsperhour',
  'تعدادتراکنش', 'تعداد', 'تراکنش', 'تعدادتراکنشات',
]);

interface HeaderIndex {
  shape: 'timestamped' | 'calendar';
  timestampCol?: number;
  dateCol?: number;
  hourCol?: number;
  countCol: number;
}

/** Map the header row; shape follows whichever columns the sheet carries. */
export function mapShaparakHeaders(
  headerRow: string[],
): { ok: true; index: HeaderIndex } | { ok: false; error: string } {
  const countCandidates: number[] = [];
  let timestampCol: number | undefined;
  let dateCol: number | undefined;
  let hourCol: number | undefined;
  headerRow.forEach((raw, i) => {
    const norm = normHeader(raw);
    if (!norm) return;
    if (COUNT_HEADERS.has(norm)) countCandidates.push(i);
    else if (TIMESTAMP_HEADERS.has(norm) && timestampCol === undefined) timestampCol = i;
    else if (CALENDAR_DATE_HEADERS.has(norm) && dateCol === undefined) dateCol = i;
    else if (HOUR_HEADERS.has(norm) && hourCol === undefined) hourCol = i;
  });
  if (countCandidates.length === 0) {
    return {
      ok: false,
      error:
        "CSV header needs a transaction-count column ('tx_count' / 'تعداد تراکنش') plus a 'timestamp' (or 'date'+'hour') column",
    };
  }
  // A dedicated hour column makes it the calendar shape even if a generic
  // 'date' header could double as a timestamp (Persian reports use تاریخ+ساعت).
  if (hourCol !== undefined && dateCol !== undefined) {
    return { ok: true, index: { shape: 'calendar', dateCol, hourCol, countCol: countCandidates[0]! } };
  }
  if (timestampCol !== undefined) {
    return { ok: true, index: { shape: 'timestamped', timestampCol, countCol: countCandidates[0]! } };
  }
  return {
    ok: false,
    error: "CSV header must carry either a 'timestamp' column or 'date' + 'hour' columns (got: " +
      headerRow.map((h) => h.trim()).filter(Boolean).join(', ') +
      ')',
  };
}

// ── temporal cells ───────────────────────────────────────────────────────

/** "21" / "۲۱" / "21:00" / "21:00:00" → hour, or null. */
export function parseHourCell(raw: string): number | null {
  const norm = normalizeDigits(raw).trim();
  const m = norm.match(/^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?$/);
  if (!m) return null;
  const hour = Number(m[1]);
  if (hour < 0 || hour > 23) return null;
  const minute = m[2] !== undefined ? Number(m[2]) : 0;
  if (minute !== 0) return null; // hourly reports only — a :30 row lies about its window
  return hour;
}

/** Gregorian (year ≥ 1900) or Jalali (1200–1600) date cell → UTC-anchored midnight. */
function parseDateCell(raw: string): { utc: Date; calendar: 'gregorian' | 'jalali' } | null {
  const norm = normalizeDigits(raw).trim();
  const m = norm.match(/^(\d{2,4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y >= 1900) {
    const utc = new Date(Date.UTC(y, mo - 1, d));
    if (utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null; // rolled over
    return { utc, calendar: 'gregorian' };
  }
  if (y >= 1200 && y <= 1600) {
    // Jalali — reuse the domain calendar (deterministic carrier via local
    // Date, which only transports y/m/d; no tz math involved).
    const g = jalaliToGregorian(y, mo, d);
    const utc = new Date(Date.UTC(g.getFullYear(), g.getMonth(), g.getDate()));
    return { utc, calendar: 'jalali' };
  }
  return null;
}

/**
 * ISO timestamp cell → the wall-clock day/hour it denotes in Tehran time.
 * Naive strings ("2026-10-01 20:00") ARE Tehran wall clock by definition of
 * the import; offset-aware strings ("…Z", "…+03:30") are converted from
 * their true instant. Returns null for anything unparseable.
 */
export function parseTimestampCell(raw: string): { dayOfWeek: number; hour: number } | null {
  const norm = normalizeDigits(raw).trim();
  const hasZone = /(z|[+\-]\d{2}:?\d{2})$/i.test(norm);
  if (!hasZone) {
    const m = norm.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})[T\s]?(\d{1,2})?(:\d{1,2})?(?::\d{1,2})?/);
    if (!m) return null;
    const utc = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (utc.getUTCMonth() !== Number(m[2]) - 1 || utc.getUTCDate() !== Number(m[3])) return null;
    const hour = m[4] !== undefined ? Number(m[4]) : 0;
    if (hour > 23) return null;
    return { dayOfWeek: utc.getUTCDay(), hour };
  }
  const t = Date.parse(norm);
  if (Number.isNaN(t)) return null;
  return wallClockInTehran(new Date(t));
}

/** True instant → Tehran wall-clock day/hour (+210, no DST since 2022). */
function wallClockInTehran(at: Date): { dayOfWeek: number; hour: number } {
  const shifted = new Date(at.getTime() + TEHRAN_TZ_OFFSET_MINUTES * 60_000);
  return { dayOfWeek: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

// ── full-sheet parse ─────────────────────────────────────────────────────

export interface ShaparakRow {
  line: number;
  sample: BucketSample;
  /** First day seen for this row (for the report's coverage window). */
  dateUtc: Date;
}

export type ShaparakParseResult =
  | {
      ok: true;
      shape: 'timestamped' | 'calendar';
      rows: ShaparakRow[];
      rejected: { line: number; reason: string }[];
      window: { from: string; to: string } | null;
    }
  | { ok: false; error: string };

/**
 * Parse a whole Shaparak/PSP sheet into bucket samples. Per-row failures
 * are REPORTED (physical line + reason) and skipped — a dry-run shows every
 * problem at once; the commit path refuses when rejections exist so money
 * inputs are never silently partial (same all-or-nothing spirit as the
 * services/contracts import).
 */
export function parseShaparakSheet(text: string): ShaparakParseResult {
  if (text.length > SHAPARAK_MAX_BYTES) {
    return { ok: false, error: `CSV exceeds ${SHAPARAK_MAX_BYTES} bytes` };
  }
  const all = parseCsv(text);
  if (all.length === 0) return { ok: false, error: 'CSV is empty' };
  const header = all[0]!;
  header[0] = header[0].replace(/^\ufeff/, '').trim();
  if (header.every((h) => h.trim() === '')) {
    return { ok: false, error: 'CSV header row is missing' };
  }
  const mapped = mapShaparakHeaders(header);
  if (!mapped.ok) return mapped;
  const index = mapped.index;

  const rows: ShaparakRow[] = [];
  const rejected: { line: number; reason: string }[] = [];
  let line = 1;
  let minDay = Number.POSITIVE_INFINITY;
  let maxDay = Number.NEGATIVE_INFINITY;

  for (let r = 1; r < all.length; r += 1) {
    const fields = all[r]!;
    const newlines = fields.reduce((acc, f) => acc + (f.match(/\r\n|\n|\r/g)?.length ?? 0), 0);
    line += 1;
    const thisLine = line;
    line += newlines;
    if (fields.every((f) => f.trim() === '')) continue; // blank line

    const reject = (reason: string) => rejected.push({ line: thisLine, reason });
    if (rows.length + rejected.length >= SHAPARAK_MAX_ROWS) {
      reject(`sheet exceeds ${SHAPARAK_MAX_ROWS} data rows`);
      continue;
    }

    const countRaw = fields[index.countCol] ?? '';
    const count = parseCount(countRaw);
    if (count === null) {
      reject(`transaction count '${countRaw.trim()}' is not a non-negative number`);
      continue;
    }

    let dayOfWeek: number;
    let hour: number;
    let dayUtc: Date;
    if (index.shape === 'timestamped') {
      const cellTs = fields[index.timestampCol!] ?? '';
      const wall = parseTimestampCell(cellTs);
      if (wall === null) {
        reject(`timestamp '${cellTs.trim()}' is not a readable date/time`);
        continue;
      }
      dayOfWeek = wall.dayOfWeek;
      hour = wall.hour;
      // dayUtc for the coverage window: anchor the wall-clock day itself.
      dayUtc = new Date(Date.UTC(2000, 0, 1) + (dayOfWeek * 24 + hour) * 3_600_000);
    } else {
      const dateRaw = fields[index.dateCol!] ?? '';
      const parsedDate = parseDateCell(dateRaw);
      if (parsedDate === null) {
        reject(`date '${dateRaw.trim()}' is not a readable Gregorian (1900+) or Jalali (1200-1600) date`);
        continue;
      }
      const hourRaw = fields[index.hourCol!] ?? '';
      const parsedHour = parseHourCell(hourRaw);
      if (parsedHour === null) {
        reject(`hour '${hourRaw.trim()}' is not 0-23 (minutes, when present, must be :00)`);
        continue;
      }
      dayOfWeek = parsedDate.utc.getUTCDay();
      hour = parsedHour;
      dayUtc = parsedDate.utc;
    }

    const bucket = bucketForWallClock(dayOfWeek, hour);
    if (bucket < 0 || bucket >= HOUR_OF_WEEK) {
      reject(`row resolves outside the 168-bucket week (bucket ${bucket})`);
      continue;
    }
    rows.push({ line: thisLine, sample: { bucket, txCount: count }, dateUtc: dayUtc });
    minDay = Math.min(minDay, dayUtc.getTime());
    maxDay = Math.max(maxDay, dayUtc.getTime());
  }

  if (rows.length === 0 && rejected.length === 0) {
    return { ok: false, error: 'CSV has a header but no data rows' };
  }
  if (rows.length === 0) {
    return { ok: false, error: `no usable rows (first rejection: line ${rejected[0]!.line}: ${rejected[0]!.reason})` };
  }

  return {
    ok: true,
    shape: index.shape,
    rows,
    rejected,
    window:
      Number.isFinite(minDay) && Number.isFinite(maxDay)
        ? { from: new Date(minDay).toISOString(), to: new Date(maxDay).toISOString() }
        : null,
  };
}

// ── aggregation + service resolution ─────────────────────────────────────

/**
 * Samples → profile summary. `rowsRejected` is folded in here so the
 * summary the UI prints is complete in one object.
 */
export function summarizeProfile(parse: Extract<ShaparakParseResult, { ok: true }>): ProfileSummary {
  const summary = aggregateProfile(
    parse.rows.map((r) => r.sample),
    TEHRAN_TZ_OFFSET_MINUTES,
  );
  return { ...summary, rowsRejected: parse.rejected.length };
}

export interface TpsResolution {
  tps: number;
  /** flat = the service's own number; profile = bucket-resolved. */
  source: 'flat' | 'profile';
  /** Wall-clock bucket label pieces when profile-resolved. */
  bucket?: number;
  /** Set when a stored profile failed validation (money fell back — visible). */
  profileError?: string;
}

/**
 * The tps in effect for a service at instant `at` — flat when no profile is
 * stored, otherwise the profile's wall-clock bucket. A CORRUPT profile never
 * crashes money computation: it falls back to flat and reports why (the
 * caller records `profileError` in the incident evidence — truthful numbers,
 * visible fallbacks, no silent guessing).
 */
export function resolveServiceTps(
  service: { tps: number; tpsProfile: string | null },
  at: Date,
): TpsResolution {
  if (!service.tpsProfile) {
    return { tps: service.tps, source: 'flat' };
  }
  try {
    const parsed = validateProfileJson(service.tpsProfile);
    const bucket = bucketForInstant(at, parsed.tzOffsetMinutes);
    return { tps: parsed.buckets[bucket]!, source: 'profile', bucket };
  } catch (err) {
    return {
      tps: service.tps,
      source: 'flat',
      profileError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Strict JSON shape check for the stored profile (throws on corruption). */
function validateProfileJson(raw: string): { buckets: number[]; tzOffsetMinutes: number } {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError('stored tpsProfile is not a JSON object');
  }
  const p = parsed as { buckets?: unknown; tzOffsetMinutes?: unknown };
  if (!Array.isArray(p.buckets) || p.buckets.length !== HOUR_OF_WEEK) {
    throw new TypeError(`stored tpsProfile.buckets must have exactly ${HOUR_OF_WEEK} entries`);
  }
  for (let i = 0; i < HOUR_OF_WEEK; i++) {
    const v = p.buckets[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new TypeError(`stored tpsProfile.buckets[${i}] must be a finite number ≥ 0`);
    }
  }
  if (typeof p.tzOffsetMinutes !== 'number' || !Number.isInteger(p.tzOffsetMinutes)) {
    throw new TypeError('stored tpsProfile.tzOffsetMinutes must be an integer');
  }
  return { buckets: p.buckets as number[], tzOffsetMinutes: p.tzOffsetMinutes };
}

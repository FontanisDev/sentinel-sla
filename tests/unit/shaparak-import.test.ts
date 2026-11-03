// Shaparak/PSP transaction-count import — unit tests for the
// pure parser (src/server/shaparak-import.ts) and the domain aggregation
// (src/domain/tps-profile.ts). Golden fingerprints for both sheet shapes,
// the Persian realities (Jalali dates, Persian/Arabic digits, FA headers,
// ZWNJ), honest rejections, the service-tps resolution the live money path
// uses, and fast-check invariants against the real bucket math.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mapShaparakHeaders,
  normalizeDigits,
  parseCount,
  parseHourCell,
  parseShaparakSheet,
  parseTimestampCell,
  resolveServiceTps,
} from '@/server/shaparak-import';
import {
  aggregateProfile,
  bucketForInstant,
  bucketForWallClock,
  TEHRAN_TZ_OFFSET_MINUTES,
  validateTpsProfile,
} from '@/domain/tps-profile';

// ── cell normalization ───────────────────────────────────────────────────

describe('normalizeDigits / parseCount', () => {
  it('converts Persian and Arabic-Indic digits', () => {
    expect(normalizeDigits('۱۲۳')).toBe('123');
    expect(normalizeDigits('٠٤٥')).toBe('045');
    expect(normalizeDigits('12ا3')).toBe('12ا3'); // non-digit letters survive
  });

  it('strips ZWNJ but keeps content', () => {
    expect(normalizeDigits('تعداد\u200cتراکنش')).toBe('تعدادتراکنش');
  });

  it('parses counts with Latin/Persian digits and thousands separators', () => {
    expect(parseCount('1,234')).toBe(1234);
    expect(parseCount('۱٬۲۳۴')).toBe(1234); // Arabic thousands separator
    expect(parseCount('۲۹,۴۰۰')).toBe(29400); // Persian digits + Latin comma
    expect(parseCount('0')).toBe(0);
  });

  it('rejects negative, blank and non-numeric counts', () => {
    expect(parseCount('-5')).toBeNull();
    expect(parseCount('')).toBeNull();
    expect(parseCount('n/a')).toBeNull();
  });
});

// ── temporal cells ───────────────────────────────────────────────────────

describe('temporal cell parsing', () => {
  it('parseHourCell accepts 0-23, FA digits and HH:00, refuses nonzero minutes', () => {
    expect(parseHourCell('21')).toBe(21);
    expect(parseHourCell('۰۵:00')).toBe(5);
    expect(parseHourCell('23:59')).toBeNull();
    expect(parseHourCell('24')).toBeNull();
  });

  it('naive timestamps ARE Tehran wall clock (domestic report calendar)', () => {
    // 2026-10-03 is a Saturday; naive 21:00 → Saturday 21:00 → bucket 6*24+21
    expect(parseTimestampCell('2026-10-03 21:00')).toEqual({ dayOfWeek: 6, hour: 21 });
    expect(parseTimestampCell('2026/10/03T21:00:00')).toEqual({ dayOfWeek: 6, hour: 21 });
  });

  it('offset-aware timestamps convert from their true instant', () => {
    // 18:30Z on a Saturday = Tehran 22:00 (+3:30) same wall-clock day.
    expect(parseTimestampCell('2026-10-03T18:30:00Z')).toEqual({ dayOfWeek: 6, hour: 22 });
    // 20:00+03:30 on a Sunday = Tehran 20:00 Sunday.
    expect(parseTimestampCell('2026-10-04T20:00:00+03:30')).toEqual({ dayOfWeek: 0, hour: 20 });
  });

  it('bucket math agrees with the instant resolver at the Tehran offset', () => {
    const at = new Date('2026-10-05T16:30:00Z'); // Tehran Monday 20:00
    expect(bucketForInstant(at, TEHRAN_TZ_OFFSET_MINUTES)).toBe(bucketForWallClock(1, 20));
  });
});

// ── header mapping ───────────────────────────────────────────────────────

describe('mapShaparakHeaders', () => {
  it('maps the Persian calendar shape (تاریخ + ساعت + تعداد تراکنش)', () => {
    const r = mapShaparakHeaders(['تاریخ', 'ساعت', 'تعداد تراکنش']);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.index).toMatchObject({ shape: 'calendar', dateCol: 0, hourCol: 1, countCol: 2 });
  });

  it('maps the English timestamped shape, tolerating case/spaces', () => {
    const r = mapShaparakHeaders(['Timestamp', ' TX Count ']);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.index).toMatchObject({ shape: 'timestamped', timestampCol: 0, countCol: 1 });
  });

  it('refuses sheets without a count column, naming what it needs', () => {
    const r = mapShaparakHeaders(['date', 'hour']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('transaction-count');
  });
});

// ── full-sheet parse ─────────────────────────────────────────────────────

describe('parseShaparakSheet', () => {
  it('parses the shipped Jalali/Persian sample: 168 rows, every hour covered', () => {
    const csv = readFileSync(join(__dirname, '../../public/templates/shaparak-tx-counts-sample.csv'), 'utf8');
    const r = parseShaparakSheet(csv);
    expect(r).toMatchObject({ ok: true, shape: 'calendar' });
    if (r.ok) {
      expect(r.rows).toHaveLength(168);
      expect(r.rejected).toHaveLength(0);
      const buckets = new Set(r.rows.map((row) => row.sample.bucket));
      expect(buckets.size).toBe(168); // a full week covers every bucket
    }
  });

  it('parses an English timestamped sheet (BOM + CRLF)', () => {
    const rows = ['2026-10-03 21:00,1200', '2026-10-03 22:00,900'];
    const r = parseShaparakSheet('\ufeff' + 'timestamp,tx_count\r\n' + rows.join('\r\n') + '\r\n');
    expect(r).toMatchObject({ ok: true, shape: 'timestamped' });
    if (r.ok) {
      expect(r.rows).toHaveLength(2);
      expect(r.rows[0]!.sample).toEqual({ bucket: bucketForWallClock(6, 21), txCount: 1200 });
    }
  });

  it('reports rejected rows by physical line (quoted fields shift lines)', () => {
    const csv = [
      'date,hour,tx_count',
      '1404/07/07,00:00,100', // line 2 OK
      '1404/07/07,25:00,100', // line 3: impossible hour
      '1404/07/07,02:00,"1,500"', // line 4 OK — RFC 4180 quoted thousands separator
      '1404/07/07,03:00,-7', // line 5: negative count
    ].join('\n');
    const r = parseShaparakSheet(csv);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.rows.map((row) => row.line)).toEqual([2, 4]);
      expect(r.rows[1]!.sample).toEqual({ bucket: bucketForWallClock(1, 2), txCount: 1500 }); // 1404/07/07 = Monday (repo Jalali calendar)
      expect(r.rejected.map((x) => x.line)).toEqual([3, 5]);
    }
  });

  it('refuses sheets where every row is bad, naming the first rejection', () => {
    const bad = parseShaparakSheet('date,hour,tx_count\n999/01/01,10,5\n999/01/02,10,5');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('no usable rows');
  });

  it('enforces the row and byte caps', () => {
    const many = Array.from({ length: 2017 }, (_, i) => `1404/07/07,${i % 24},${i}`).join('\n');
    const r = parseShaparakSheet('date,hour,tx_count\n' + many);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows.length).toBe(2016); // 2016 accepted
      expect(r.rejected.length).toBe(1); // the 2017th honestly refused
    }
    expect(parseShaparakSheet('x'.repeat(513 * 1024)).ok).toBe(false);
  });
});

// ── aggregation + resolution ─────────────────────────────────────────────

describe('aggregateProfile', () => {
  it('means the counts per bucket and divides by 3600 (hand-computed golden)', () => {
    // bucket 21 (Sunday 21:00) sees 3600 and 7200 tx → mean 5400 → 1.5 tps
    const s = aggregateProfile(
      [
        { bucket: bucketForWallClock(0, 21), txCount: 3600 },
        { bucket: bucketForWallClock(0, 21), txCount: 7200 },
        { bucket: bucketForWallClock(5, 3), txCount: 3600 },
      ],
      TEHRAN_TZ_OFFSET_MINUTES,
    );
    expect(s.buckets[bucketForWallClock(0, 21)]).toBeCloseTo(1.5, 10);
    expect(s.buckets[bucketForWallClock(5, 3)]).toBeCloseTo(1.0, 10);
    expect(s.coveredBuckets).toBe(2);
    expect(s.meanTps).toBeCloseTo(1.25, 10);
    expect(s.peak).toEqual({ bucket: bucketForWallClock(0, 21), tps: 1.5 });
    expect(s.trough).toEqual({ bucket: bucketForWallClock(5, 3), tps: 1.0 });
  });

  it('uncovered buckets stay 0 and are honestly excluded from the mean', () => {
    const s = aggregateProfile([{ bucket: 10, txCount: 3600 }], TEHRAN_TZ_OFFSET_MINUTES);
    expect(s.coveredBuckets).toBe(1);
    expect(s.buckets[10]).toBeCloseTo(1, 10); // 3600 tx in one hour = exactly 1 tps
    expect(s.meanTps).toBeCloseTo(1, 10);
  });
});

describe('validateTpsProfile', () => {
  it('accepts a valid 168-bucket profile and rejects wrong shapes', () => {
    const good = { buckets: new Array(168).fill(1), tzOffsetMinutes: 210 };
    expect(validateTpsProfile(good)).toMatchObject({ tzOffsetMinutes: 210 });
    expect(() => validateTpsProfile({ buckets: new Array(167).fill(1), tzOffsetMinutes: 210 })).toThrow();
    expect(() => validateTpsProfile({ buckets: new Array(168).fill(-1), tzOffsetMinutes: 210 })).toThrow();
    expect(() => validateTpsProfile(null)).toThrow();
  });
});

describe('resolveServiceTps (the live money path)', () => {
  const flat = { tps: 40, tpsProfile: null };

  it('flat service → the flat rate, labeled flat', () => {
    expect(resolveServiceTps(flat, new Date())).toEqual({ tps: 40, source: 'flat' });
  });

  it('profile service → the incident hour\u2019s own bucket, labeled profile', () => {
    // Build a profile where Monday 20:00 Tehran = 55 tps, everything else 5.
    const buckets = new Array(168).fill(5);
    buckets[bucketForWallClock(1, 20)] = 55;
    const svc = { tps: 40, tpsProfile: JSON.stringify({ buckets, tzOffsetMinutes: 210 }) };
    const at = new Date('2026-10-05T16:30:00Z'); // Tehran Monday 20:00
    const r = resolveServiceTps(svc, at);
    expect(r.source).toBe('profile');
    expect(r.tps).toBe(55);
    expect(r.bucket).toBe(bucketForWallClock(1, 20));
    // Same wall-clock hour one week later resolves identically.
    const weekLater = new Date(at.getTime() + 7 * 86400 * 1000);
    expect(resolveServiceTps(svc, weekLater).tps).toBe(55);
  });

  it('a corrupt stored profile falls back to flat AND says why (never silent)', () => {
    const svc = { tps: 40, tpsProfile: '{"buckets":[1,2,3]}' };
    const r = resolveServiceTps(svc, new Date());
    expect(r.source).toBe('flat');
    expect(r.tps).toBe(40);
    expect(r.profileError).toContain('168');
  });
});

// ── fast-check invariants ────────────────────────────────────────────────

describe('fast-check invariants', () => {
  it('aggregated buckets are finite, ≥ 0, and re-resolve through the real resolver', () => {
    const countArb = fc.integer({ min: 0, max: 500_000 });
    const bucketArb = fc.integer({ min: 0, max: 167 });
    fc.assert(
      fc.property(
        fc.array(fc.record({ bucket: bucketArb, txCount: countArb }), { minLength: 1, maxLength: 500 }),
        fc.integer({ min: 0, max: 500_000 }),
        (samples, atMsInWeek) => {
          const summary = aggregateProfile(samples, TEHRAN_TZ_OFFSET_MINUTES);
          for (const tps of summary.buckets) {
            expect(Number.isFinite(tps)).toBe(true);
            expect(tps).toBeGreaterThanOrEqual(0);
          }
          const profile = validateTpsProfile({ buckets: summary.buckets, tzOffsetMinutes: TEHRAN_TZ_OFFSET_MINUTES });
          const at = new Date(Date.UTC(2026, 0, 4, 0, atMsInWeek % (7 * 1440)));
          expect(Number.isFinite(resolveServiceTps({ tps: 0, tpsProfile: JSON.stringify(profile) }, at).tps)).toBe(true);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('bucket clock advances exactly one slot per hour, wrapping at the week end', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7 * 1440 - 2 }), (minutesIntoUtcWeek) => {
        const epoch = Date.UTC(2026, 0, 4, 0, 0, 0);
        const at = new Date(epoch + minutesIntoUtcWeek * 60_000);
        const b = bucketForInstant(at, TEHRAN_TZ_OFFSET_MINUTES);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(167);
        // One hour later the bucket advanced by exactly one, wrapping at 168.
        const next = bucketForInstant(new Date(at.getTime() + 3_600_000), TEHRAN_TZ_OFFSET_MINUTES);
        expect(next).toBe((b + 1) % 168);
        return true;
      }),
      { numRuns: 300 },
    );
  });
});

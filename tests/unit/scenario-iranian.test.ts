// Synthetic Iranian-fintech scenario.
// The JSON in tests/scenarios/ is the single source of truth; this test
// validates (a) the synthetic marking and structural shape, (b) that the
// profile really encodes the declared rhythms (20:00-23:00 peak, Thu-Fri
// weekend, salary-day evenings), and (c) that every loss case reproduces the
// hand-computed expectation EXACTLY through the real domain money model
// (computeLoss — the same BigInt path production uses).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeLoss, type MoneyModel } from '@/domain/money-model';

const SCENARIO = JSON.parse(
  readFileSync(join(__dirname, '..', 'scenarios', 'iranian-fintech-synthetic.json'), 'utf8'),
) as {
  synthetic: boolean;
  syntheticNotice: string;
  moneyModel: MoneyModel;
  profileRules: {
    weekday: Array<{ fromHour: number; toHour: number; tps: number }>;
    thursday: Array<{ fromHour: number; toHour: number; tps: number }>;
    friday: Array<{ fromHour: number; toHour: number; tps: number }>;
  };
  calendarEvents: {
    yalda: { windowStartTehran: string; windowEndTehran: string; scale: number };
    nowruz: { windowStartTehran: string; windowEndTehran: string; scale: number };
    salaryDays: { daysTehran: string[]; dailyStartHourTehran: number; dailyEndHourTehran: number; scale: number };
  };
  lossCases: Array<{
    id: string;
    startUtc: string;
    seconds: number;
    eventScale: number | null;
    expectFinalRials: number;
  }>;
};

const profile = SCENARIO.moneyModel.txPerSecond.kind === 'hourOfWeekProfile'
  ? SCENARIO.moneyModel.txPerSecond.profile
  : null;

const TEHRAN_OFFSET_MIN = 210;

/** Tehran-local day (Sunday=0) and hour for a UTC instant — money-model bucket convention. */
function tehranBucket(epochMs: number): number {
  const shifted = new Date(epochMs + TEHRAN_OFFSET_MIN * 60_000);
  const day = shifted.getUTCDay(); // 0=Sunday … 6=Saturday
  return day * 24 + shifted.getUTCHours();
}

function ruleTps(rules: Array<{ fromHour: number; toHour: number; tps: number }>, hour: number): number {
  const hit = rules.find((r) => hour >= r.fromHour && hour < r.toHour);
  expect(hit, `profile rule must cover hour ${hour}`).toBeDefined();
  return hit!.tps;
}

describe('synthetic Iranian-fintech scenario (tests/scenarios)', () => {
  it('is clearly marked synthetic', () => {
    expect(SCENARIO.synthetic).toBe(true);
    expect(SCENARIO.syntheticNotice).toContain('SYNTHETIC');
    expect(SCENARIO.syntheticNotice).toContain('never be used as market data');
  });

  it('carries a 168-bucket hour-of-week profile in Tehran time', () => {
    expect(SCENARIO.moneyModel.txPerSecond.kind).toBe('hourOfWeekProfile');
    expect(profile).toHaveLength(168);
    expect(profile!.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });

  it('profile matches its declared rules for every bucket of the week', () => {
    for (let day = 0; day < 7; day++) {
      const rules = day === 4 ? SCENARIO.profileRules.thursday : day === 5 ? SCENARIO.profileRules.friday : SCENARIO.profileRules.weekday;
      for (let hour = 0; hour < 24; hour++) {
        expect(profile![day * 24 + hour], `bucket day=${day} hour=${hour}`).toBe(ruleTps(rules, hour));
      }
    }
  });

  it('encodes the declared rhythms: evening peak, Thu-Fri trough, salary evenings', () => {
    // 20:00-23:00 peak on ordinary days
    for (const day of [0, 1, 2, 3]) {
      for (const hour of [20, 21, 22]) expect(profile![day * 24 + hour]).toBe(420);
    }
    // Thursday-Friday weekend: no weekday-level peak, strictly below weekday evening
    for (const day of [4, 5]) {
      for (const hour of [20, 21, 22]) expect(profile![day * 24 + hour]).toBeLessThan(420);
    }
    expect(profile![5 * 24 + 14]).toBe(35); // Friday afternoon floor
    // Thursday evening below the weekday evening rate (weekend ramp-down)
    expect(profile![4 * 24 + 19]).toBeLessThan(SCENARIO.profileRules.weekday.find((r) => r.fromHour === 17)!.tps);
  });

  it('reproduces every loss-case expectation exactly through computeLoss', () => {
    expect(SCENARIO.lossCases.length).toBeGreaterThanOrEqual(5);
    for (const c of SCENARIO.lossCases) {
      const startMs = Date.parse(c.startUtc);
      expect(Number.isFinite(startMs), c.id).toBe(true);
      const base = profile![tehranBucket(startMs)];
      const tps = c.eventScale === null ? base : base * c.eventScale;
      const breakdown = computeLoss(SCENARIO.moneyModel, { tps, seconds: c.seconds });
      expect(breakdown.finalRials, `${c.id}: ${breakdown.lines.join(' | ')}`).toBe(c.expectFinalRials);
    }
  });

  it('loss cases actually sit inside their declared event windows', () => {
    const tehranLocal = (ms: number) => new Date(ms + TEHRAN_OFFSET_MIN * 60_000).toISOString();
    const yalda = SCENARIO.calendarEvents.yalda;
    const nowruz = SCENARIO.calendarEvents.nowruz;
    const salary = SCENARIO.calendarEvents.salaryDays;

    const yaldaCase = SCENARIO.lossCases.find((c) => c.id === 'yalda-night')!;
    expect(Date.parse(yaldaCase.startUtc) + TEHRAN_OFFSET_MIN * 60_000)
      .toBeGreaterThanOrEqual(Date.parse(yalda.windowStartTehran + '+03:30'));
    expect(Date.parse(yaldaCase.startUtc) + TEHRAN_OFFSET_MIN * 60_000)
      .toBeLessThan(Date.parse(yalda.windowEndTehran + '+03:30'));
    expect(yaldaCase.eventScale).toBe(yalda.scale);

    const nowruzCase = SCENARIO.lossCases.find((c) => c.id === 'nowruz-trough')!;
    expect(Date.parse(nowruzCase.startUtc) + TEHRAN_OFFSET_MIN * 60_000)
      .toBeGreaterThanOrEqual(Date.parse(nowruz.windowStartTehran + '+03:30'));
    expect(Date.parse(nowruzCase.startUtc) + TEHRAN_OFFSET_MIN * 60_000)
      .toBeLessThan(Date.parse(nowruz.windowEndTehran + '+03:30'));
    expect(nowruzCase.eventScale).toBe(nowruz.scale);

    const salaryCase = SCENARIO.lossCases.find((c) => c.id === 'salary-day-thursday')!;
    const localIso = tehranLocal(Date.parse(salaryCase.startUtc)); // e.g. 2026-03-19T19:30…Z-shifted
    const localDate = localIso.slice(0, 10);
    const localHour = Number(localIso.slice(11, 13));
    expect(salary.daysTehran).toContain(localDate);
    expect(localHour).toBeGreaterThanOrEqual(salary.dailyStartHourTehran);
    expect(localHour).toBeLessThan(salary.dailyEndHourTehran);
    expect(salaryCase.eventScale).toBe(salary.scale);
  });

  it('no ordinary-day case accidentally claims an event scale', () => {
    for (const c of SCENARIO.lossCases) {
      if (c.id === 'weekday-peak' || c.id === 'friday-weekend') {
        expect(c.eventScale).toBeNull();
      }
    }
  });
});

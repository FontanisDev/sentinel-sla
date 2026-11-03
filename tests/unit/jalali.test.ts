// Jalali calendar core — anchor + property tests.
//
// Anchors are externally known dates (Nowruz observances); the round-trip
// property over a 7-year daily sweep guarantees internal consistency of the
// conversion pair for every calendar day in the supported range we exercise.

import { describe, expect, it } from 'vitest'
import {
  gregorianToJalali,
  jalaliToGregorian,
  isJalaliLeap,
  jalaliMonthLength,
  formatJalaliDate,
  formatJalaliMonth,
  formatJalaliDateLong,
  formatDateText,
  jalaliMonthGrid,
  gregorianMonthGrid,
  monthGridWeeks,
} from '@/lib/jalali'

/** Local-midnight Date from Y/M/D (mirrors how callers construct dates). */
function d(gy: number, gm: number, gd: number): Date {
  return new Date(gy, gm - 1, gd)
}

describe('jalali anchors', () => {
  it('maps Nowruz dates to 1 Farvardin', () => {
    expect(gregorianToJalali(d(2024, 3, 20))).toEqual({ jy: 1403, jm: 1, jd: 1 })
    expect(gregorianToJalali(d(2025, 3, 21))).toEqual({ jy: 1404, jm: 1, jd: 1 })
    expect(gregorianToJalali(d(2026, 3, 21))).toEqual({ jy: 1405, jm: 1, jd: 1 })
  })

  it('maps a known mid-year date (2026-10-08 → 1405/07/16)', () => {
    expect(gregorianToJalali(d(2026, 10, 8))).toEqual({ jy: 1405, jm: 7, jd: 16 })
  })

  it('maps the last day of a leap Jalali year (Esfand 30, 1403)', () => {
    // 1403 is leap: 1403/12/30 = the day before 1404/01/01
    expect(gregorianToJalali(d(2025, 3, 20))).toEqual({ jy: 1403, jm: 12, jd: 30 })
  })

  it('converts back: 1 Farvardin 1404 = 2025-03-21', () => {
    const g = jalaliToGregorian(1404, 1, 1)
    expect(g.getFullYear()).toBe(2025)
    expect(g.getMonth()).toBe(2) // March (0-based)
    expect(g.getDate()).toBe(21)
  })
})

describe('jalali month lengths & leap years', () => {
  it('months 1..6 always have 31 days, 7..11 have 30', () => {
    for (const jy of [1399, 1403, 1404, 1405, 1408]) {
      for (let jm = 1; jm <= 6; jm++) expect(jalaliMonthLength(jy, jm)).toBe(31)
      for (let jm = 7; jm <= 11; jm++) expect(jalaliMonthLength(jy, jm)).toBe(30)
    }
  })

  it('Esfand is 30 in leap years, 29 otherwise', () => {
    expect(isJalaliLeap(1399)).toBe(true)
    expect(isJalaliLeap(1403)).toBe(true)
    expect(jalaliMonthLength(1403, 12)).toBe(30)
    expect(isJalaliLeap(1404)).toBe(false)
    expect(jalaliMonthLength(1404, 12)).toBe(29)
  })
})

describe('jalali round-trip property', () => {
  it('g→j→g is the identity for every day 2023-01-01 … 2029-12-31', () => {
    const start = d(2023, 1, 1).getTime()
    const end = d(2029, 12, 31).getTime()
    let checked = 0
    for (let t = start; t <= end; t += 86_400_000) {
      const date = new Date(t)
      const j = gregorianToJalali(date)
      const back = jalaliToGregorian(j.jy, j.jm, j.jd)
      expect(back.getFullYear()).toBe(date.getFullYear())
      expect(back.getMonth()).toBe(date.getMonth())
      expect(back.getDate()).toBe(date.getDate())
      checked += 1
    }
    expect(checked).toBe(2557) // 7 years incl. two leap Gregorian years
  })

  it('j→g→j is the identity across a full Jalali leap year 1403', () => {
    for (let jm = 1; jm <= 12; jm++) {
      const len = jalaliMonthLength(1403, jm)
      for (let jd = 1; jd <= len; jd++) {
        const g = jalaliToGregorian(1403, jm, jd)
        const j = gregorianToJalali(g)
        expect(j).toEqual({ jy: 1403, jm, jd })
      }
    }
  })
})

describe('jalali formatting', () => {
  const date = d(2026, 10, 8) // 1405/07/16, a Thursday

  it('formats FA with Persian digits and native month name', () => {
    expect(formatJalaliDate(date, 'fa')).toBe('۱۶ مهر ۱۴۰۵')
  })

  it('formats EN with transliterated month name', () => {
    expect(formatJalaliDate(date, 'en')).toBe('16 Mehr 1405')
  })

  it('formats the month header', () => {
    expect(formatJalaliMonth(1405, 7, 'fa')).toBe('مهر ۱۴۰۵')
    expect(formatJalaliMonth(1405, 7, 'en')).toBe('Mehr 1405')
  })

  it('formats the long date with weekday', () => {
    expect(formatJalaliDateLong(date, 'fa')).toBe('پنجشنبه ۱۶ مهر ۱۴۰۵')
    expect(formatJalaliDateLong(date, 'en')).toBe('Thursday 16 Mehr 1405')
  })

  it('DateText: FA uses Jalali, EN uses Gregorian', () => {
    expect(formatDateText(date, 'fa')).toBe('۱۶ مهر ۱۴۰۵')
    expect(formatDateText(date, 'en')).toBe('8 Oct 2026')
  })
})

describe('month grids (picker model)', () => {
  it('Jalali grid: title, length, weekday of the 1st, to_date', () => {
    const g = jalaliMonthGrid(1405, 7, 'fa')
    expect(g.title).toBe('مهر ۱۴۰۵')
    expect(g.length).toBe(30)
    // 1405/07/01 = 2026-09-23, a Wednesday (getDay 3)
    expect(g.firstWeekday).toBe(3)
    expect(g.to_date(16)).toEqual(d(2026, 10, 8))
    const en = jalaliMonthGrid(1405, 7, 'en')
    expect(en.title).toBe('Mehr 1405')
  })

  it('Gregorian grid matches Date math', () => {
    const g = gregorianMonthGrid(2026, 10, 'en')
    expect(g.title).toBe('October 2026')
    expect(g.length).toBe(31)
    // 2026-10-01 is a Thursday
    expect(g.firstWeekday).toBe(4)
    expect(g.to_date(8)).toEqual(d(2026, 10, 8))
  })

  it('weeks matrix: Saturday-first for FA, Sunday-first for EN, no ragged rows', () => {
    const g = jalaliMonthGrid(1405, 7, 'fa') // 1st → FA index (3+1)%7 = 4 leading blanks
    const weeksFa = monthGridWeeks(g, 'fa')
    expect(weeksFa[0]).toEqual([null, null, null, null, 1, 2, 3])
    expect(weeksFa.flat().filter((v) => v !== null)).toHaveLength(30)
    for (const w of weeksFa) expect(w).toHaveLength(7)
    // EN: 3 leading blanks
    const weeksEn = monthGridWeeks(g, 'en')
    expect(weeksEn[0]).toEqual([null, null, null, 1, 2, 3, 4])
  })
})

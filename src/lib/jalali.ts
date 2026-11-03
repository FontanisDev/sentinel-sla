// Sentinel-SLA — Jalali (Solar Hijri) calendar core
//
// Pure conversion + formatting used by DateText / JalaliDatePicker (design
// system §6.13) and the executive Persian views. The algorithm is the widely
// used Borkowski/Behrooz arithmetic (same as jalaali-js, public domain
// implementation re-derived here) — accurate for years 1178–3177 AP.
//
// Everything here is PURE: no locale APIs, no Date.now(), fully unit-tested
// against known anchors (Nowruz dates) and round-trip properties.

import type { Lang } from '@/lib/i18n'
import { toPersianDigits } from '@/lib/format'

export interface JalaliDate {
  /** Jalali year (AP), e.g. 1405 */
  jy: number
  /** Jalali month 1..12 (1 = Farvardin) */
  jm: number
  /** Jalali day 1..31 */
  jd: number
}

const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097,
  2192, 2262, 2324, 2394, 2456, 3178,
] as const

function div(a: number, b: number): number {
  return Math.trunc(a / b)
}

function mod(a: number, b: number): number {
  return a - Math.trunc(a / b) * b
}

/** Jalali year metadata: leap flag + Gregorian day-of-March for 1 Farvardin. */
function jalCal(jy: number): { leap: number; gy: number; march: number } {
  const bl = BREAKS.length
  const gy = jy + 621
  let leapJ = -14
  let jp: number = BREAKS[0]
  let jump = 0
  if (jy < jp || jy >= BREAKS[bl - 1]) {
    throw new RangeError(`Jalali year ${jy} out of supported range`)
  }
  for (let i = 1; i < bl; i += 1) {
    const jm = BREAKS[i]
    jump = jm - jp
    if (jy < jm) break
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4)
    jp = jm
  }
  let n = jy - jp
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4)
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150
  const march = 20 + leapJ - leapG
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33
  let leap = mod(mod(n + 1, 33) - 1, 4)
  if (leap === -1) leap = 4
  return { leap, gy, march }
}

/** Gregorian Y/M/D → JDN (Julian day number, integer noon-based). */
function g2d(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752
  return d
}

/** JDN → Gregorian Y/M/D. */
function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908
  const i = div(mod(j, 1461), 4) * 5 + 308
  const gd = div(mod(i, 153), 5) + 1
  const gm = mod(div(i, 153), 12) + 1
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6)
  return { gy, gm, gd }
}

/** JDN → Jalali Y/M/D. */
function d2j(jdn: number): JalaliDate {
  const gy = d2g(jdn).gy
  let jy = gy - 621
  const r = jalCal(jy)
  const jdn1f = g2d(gy, 3, r.march)
  let k = jdn - jdn1f
  if (k >= 0) {
    if (k <= 185) {
      return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 }
    }
    k -= 186
  } else {
    jy -= 1
    k += 179
    if (r.leap === 1) k += 1
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 }
}

/** JDN from a Jalali date. */
function j2d(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy)
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1
}

// ── public API ─────────────────────────────────────────────────────────────

/** Gregorian Date (LOCAL calendar day) → Jalali date. */
export function gregorianToJalali(date: Date): JalaliDate {
  return d2j(g2d(date.getFullYear(), date.getMonth() + 1, date.getDate()))
}

/** Jalali date → Gregorian Date at LOCAL midnight. */
export function jalaliToGregorian(jy: number, jm: number, jd: number): Date {
  const { gy, gm, gd } = d2g(j2d(jy, jm, jd))
  return new Date(gy, gm - 1, gd)
}

/** Is the Jalali year a leap year (Esfand has 30 days)? */
export function isJalaliLeap(jy: number): boolean {
  return jalCal(jy).leap === 0
}

/** Days in a Jalali month: 31 / 31 / … / 30 / 29-or-30. */
export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm < 1 || jm > 12) throw new RangeError(`Jalali month ${jm} out of range`)
  if (jm <= 6) return 31
  if (jm <= 11) return 30
  return isJalaliLeap(jy) ? 30 : 29
}

/** Persian month names (native). */
export const JALALI_MONTHS_FA: readonly string[] = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
]

/** Transliterated month names for English UI. */
export const JALALI_MONTHS_EN: readonly string[] = [
  'Farvardin', 'Ordibehesht', 'Khordad', 'Tir', 'Mordad', 'Shahrivar',
  'Mehr', 'Aban', 'Azar', 'Dey', 'Bahman', 'Esfand',
]

/** Persian weekday names, index = Date.getDay() (0 = Sunday). */
export const WEEKDAYS_FA: readonly string[] = [
  'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه',
]

/** English weekday names, index = Date.getDay(). */
export const WEEKDAYS_EN: readonly string[] = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]

/**
 * "۱۶ مهر ۱۴۰۵" (fa) / "16 Mehr 1405" (en). Persian mode uses Persian digits
 * only — never mixed Latin digits inside one figure (doc §3).
 */
export function formatJalaliDate(date: Date, lang: Lang): string {
  const { jy, jm, jd } = gregorianToJalali(date)
  if (lang === 'fa') {
    return `${toPersianDigits(String(jd))} ${JALALI_MONTHS_FA[jm - 1]} ${toPersianDigits(String(jy))}`
  }
  return `${jd} ${JALALI_MONTHS_EN[jm - 1]} ${jy}`
}

/** "مهر ۱۴۰۵" / "Mehr 1405" — month header for pickers and statement periods. */
export function formatJalaliMonth(jy: number, jm: number, lang: Lang): string {
  return lang === 'fa'
    ? `${JALALI_MONTHS_FA[jm - 1]} ${toPersianDigits(String(jy))}`
    : `${JALALI_MONTHS_EN[jm - 1]} ${jy}`
}

/** Weekday name for a date ("پنجشنبه" / "Thursday"). */
export function formatWeekday(date: Date, lang: Lang): string {
  const names = lang === 'fa' ? WEEKDAYS_FA : WEEKDAYS_EN
  return names[date.getDay()]
}

/**
 * "پنجشنبه ۱۶ مهر ۱۴۰۵" / "Thursday 16 Mehr 1405" — full human date used by
 * DateText and the report title blocks.
 */
export function formatJalaliDateLong(date: Date, lang: Lang): string {
  return `${formatWeekday(date, lang)} ${formatJalaliDate(date, lang)}`
}

/**
 * Calendar-agnostic display for DateText (§6.13): Persian UI shows the Jalali
 * date; English UI shows the Gregorian date. The picker adds the switch.
 */
export function formatDateText(date: Date, lang: Lang): string {
  if (lang === 'fa') return formatJalaliDate(date, 'fa')
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

// ── month-grid model (pickers §6.13) ───────────────────────────────────────

/**
 * One displayable month grid — calendar-agnostic so JalaliDatePicker can
 * render Jalali OR Gregorian months through the same UI ("calendar switch").
 */
export interface MonthGrid {
  /** Display title, already localized ("مهر ۱۴۰۵" / "Mehr 1405" / "October 2026"). */
  title: string
  /** Weekday (getDay() index, 0 = Sunday) of the grid's day 1. */
  firstWeekday: number
  /** Number of days in this month. */
  length: number
  /** Map a day of this grid back to a real Date (local midnight). */
  to_date: (day: number) => Date
}

const GREG_MONTHS_EN: readonly string[] = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
]

/** Jalali month grid for a (jy, jm). */
export function jalaliMonthGrid(jy: number, jm: number, lang: Lang): MonthGrid {
  const length = jalaliMonthLength(jy, jm)
  // Weekday of Jalali 1st: convert to a Gregorian Date and read getDay().
  const first = jalaliToGregorian(jy, jm, 1)
  return {
    title: formatJalaliMonth(jy, jm, lang),
    firstWeekday: first.getDay(),
    length,
    to_date: (day: number) => jalaliToGregorian(jy, jm, day),
  }
}

/** Gregorian month grid for a (gy, gm 1..12) — used by the calendar switch. */
export function gregorianMonthGrid(gy: number, gm: number, lang: Lang): MonthGrid {
  const length = new Date(gy, gm, 0).getDate()
  const first = new Date(gy, gm - 1, 1)
  const title =
    lang === 'fa'
      ? `${toPersianDigits(String(gm))} ماه ${toPersianDigits(String(gy))}`
      : `${GREG_MONTHS_EN[gm - 1]} ${gy}`
  return {
    title,
    firstWeekday: first.getDay(),
    length,
    to_date: (day: number) => new Date(gy, gm - 1, day),
  }
}

/**
 * Weeks matrix for a grid: rows of 7 entries, `null` for leading blanks
 * (before day 1). Week start: Saturday for FA (Persian week), Sunday for EN.
 */
export function monthGridWeeks(grid: MonthGrid, lang: Lang): Array<Array<number | null>> {
  const startOffset =
    lang === 'fa'
      ? (grid.firstWeekday + 1) % 7 // Saturday-first index of day 1
      : grid.firstWeekday
  const weeks: Array<Array<number | null>> = []
  let week: Array<number | null> = new Array(startOffset).fill(null)
  for (let day = 1; day <= grid.length; day += 1) {
    week.push(day)
    if (week.length === 7) {
      weeks.push(week)
      week = []
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null)
    weeks.push(week)
  }
  return weeks
}

/** Weekday header labels in grid order (Saturday-first for FA, Sunday-first for EN). */
export function weekdayHeaderLabels(lang: Lang): string[] {
  if (lang === 'fa') {
    // شنبه … جمعه, short single/duo-letter forms
    return ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج']
  }
  return ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
}

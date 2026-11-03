// Pure core behind StatCard deltas and the TimeRange
// picker. The sign on a delta and the bounds of a range are product
// contract, not styling — pin them here.

import { describe, expect, it } from 'vitest'
import {
  PRESET_MS,
  TIME_RANGE_PRESETS,
  deltaLabel,
  deltaTone,
  endOfDay,
  resolveRange,
  type StatDelta,
  type TimeRangeValue,
} from '@/lib/stat-range'

describe('deltaLabel — arrow pairs with an explicit sign ', () => {
  it('prefixes positives with +', () => {
    expect(deltaLabel({ value: 2.4, format: (n) => n.toFixed(1) })).toBe('+2.4')
    expect(deltaLabel({ value: 1200 })).toBe('+1,200')
  })

  it('keeps negatives negative (single sign, no double minus)', () => {
    expect(deltaLabel({ value: -3.1, format: (n) => n.toFixed(1) })).toBe('-3.1')
    expect(deltaLabel({ value: -500 })).toBe('-500')
  })

  it('marks zero as flat ±, never as +0 or -0', () => {
    expect(deltaLabel({ value: 0 })).toBe('±0')
    expect(deltaLabel({ value: 0, format: (n) => n.toFixed(2) })).toBe('±0.00')
  })

  it('normalises a U+2212 minus from a caller formatter to ASCII -', () => {
    expect(deltaLabel({ value: -1, format: (n) => n.toLocaleString('de-DE') })).toBe('-1')
    const unicodeMinus = deltaLabel({ value: -7, format: (n) => `\u2212${Math.abs(n)}` })
    expect(unicodeMinus).toBe('-7')
    expect(unicodeMinus.startsWith('-')).toBe(true)
    expect(unicodeMinus.includes('\u2212')).toBe(false)
  })
})

describe('deltaTone — good/bad follows semantics, not the arrow', () => {
  it('up is good by default', () => {
    expect(deltaTone({ value: 5 })).toBe('good')
    expect(deltaTone({ value: -5 })).toBe('bad')
  })

  it('goodWhen down flips it (penalty/MTTD style metrics)', () => {
    expect(deltaTone({ value: 5, goodWhen: 'down' })).toBe('bad')
    expect(deltaTone({ value: -5, goodWhen: 'down' })).toBe('good')
  })

  it('zero is always flat', () => {
    expect(deltaTone({ value: 0 })).toBe('flat')
    expect(deltaTone({ value: 0, goodWhen: 'down' })).toBe('flat')
  })
})

describe('resolveRange — preset windows and custom passthrough', () => {
  const now = new Date('2026-10-08T10:00:00+08:00')

  it('every preset reaches back exactly its millis and leaves the top open', () => {
    for (const preset of TIME_RANGE_PRESETS) {
      const value: TimeRangeValue = { preset, from: null, to: null }
      const { from, to } = resolveRange(value, now)
      expect(to).toBeNull()
      expect(from?.getTime()).toBe(now.getTime() - PRESET_MS[preset])
    }
  })

  it('1h is 60 minutes, 30d is 30 × 24 hours (no month approximation)', () => {
    expect(PRESET_MS['1h']).toBe(3_600_000)
    expect(PRESET_MS['24h']).toBe(86_400_000)
    expect(PRESET_MS['7d']).toBe(7 * 86_400_000)
    expect(PRESET_MS['30d']).toBe(30 * 86_400_000)
  })

  it('custom passes the caller bounds through untouched', () => {
    const from = new Date('2026-10-01T00:00:00+08:00')
    const to = new Date('2026-10-03T23:59:59.999+08:00')
    const value: TimeRangeValue = { preset: 'custom', from, to }
    expect(resolveRange(value, now)).toEqual({ from, to })
  })
})

describe('endOfDay — a picked To midnight includes the whole day', () => {
  it('widens local midnight to 23:59:59.999 of the same day', () => {
    const midnight = new Date(2026, 9, 8) // local 2026-10-08 00:00:00
    const e = endOfDay(midnight)
    expect(e.getFullYear()).toBe(2026)
    expect(e.getMonth()).toBe(9)
    expect(e.getDate()).toBe(8)
    expect(e.getHours()).toBe(23)
    expect(e.getMinutes()).toBe(59)
    expect(e.getSeconds()).toBe(59)
    expect(e.getMilliseconds()).toBe(999)
  })
})

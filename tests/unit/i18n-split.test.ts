// Tests for the per-language i18n bundle split (keeps the initial JS payload small).
//
// Contract under test:
//   - EN is always present (statically imported, fallback language)
//   - translate('fa', …) NEVER returns a raw key: FA → EN → key fallback
//   - loading the FA chunk registers the dictionary and flips translate()
//   - fa has EXACTLY the same keys as en (runtime mirror of the type guarantee)
//   - {var} interpolation is unchanged by the split
import { describe, it, expect, beforeAll } from 'vitest'
import {
  translate,
  pickName,
  loadFaDictionary,
  hasFaDictionary,
  registerFaDictionary,
  type TranslationKey,
} from '@/lib/i18n'
import { en } from '@/lib/i18n/en'
import { fa } from '@/lib/i18n/fa'

describe('i18n per-language split', () => {
  beforeAll(async () => {
    await loadFaDictionary()
  })

  it('EN works with no setup (static fallback language)', () => {
    expect(translate('en', 'kpi.fleetUptime')).toBe('Fleet Uptime')
    expect(translate('en', 'pill.allOperational')).toBe('All systems operational')
  })

  it('FA falls back to EN when the dictionary is not yet loaded (never a raw key)', () => {
    // simulate a fresh client: clear the registry
    registerFaDictionary(null as unknown as Record<TranslationKey, string>)
    expect(hasFaDictionary()).toBe(false)
    const out = translate('fa', 'kpi.fleetUptime')
    expect(out).toBe('Fleet Uptime') // EN fallback, not 'kpi.fleetUptime'
  })

  it('loadFaDictionary registers the chunk and translate() serves real FA', async () => {
    await loadFaDictionary() // re-load after the previous test unregistered it
    expect(hasFaDictionary()).toBe(true)
    expect(translate('fa', 'kpi.fleetUptime')).toBe('کارکرد ناوگان')
    expect(translate('fa', 'pill.allOperational')).toBe('همهٔ سامانه‌ها فعال')
  })

  it('loadFaDictionary is idempotent (single shared promise)', async () => {
    await Promise.all([loadFaDictionary(), loadFaDictionary(), loadFaDictionary()])
    expect(hasFaDictionary()).toBe(true)
    expect(translate('fa', 'stat.sparkAlt')).toBe('روند نمونه‌های اخیر')
  })

  it('fa has EXACTLY the same keys as en (runtime mirror of the type guarantee)', () => {
    const enKeys = Object.keys(en).sort()
    const faKeys = Object.keys(fa).sort()
    expect(faKeys).toEqual(enKeys)
    expect(enKeys.length).toBeGreaterThan(300)
  })

  it('every EN and FA value is a non-empty string', () => {
    for (const [k, v] of Object.entries(en)) {
      expect(typeof v).toBe('string')
      expect((v as string).length).toBeGreaterThan(0)
      expect(typeof fa[k as TranslationKey]).toBe('string')
      expect((fa[k as TranslationKey] as string).length).toBeGreaterThan(0)
    }
  })

  it('{var} interpolation is unchanged by the split', () => {
    expect(translate('en', 'kpi.target', { v: '99.9%' })).toBe('target 99.9%')
    expect(translate('en', 'pill.nDegraded', { n: 3, s: 's' })).toBe('3 services degraded')
    // missing vars keep the placeholder (documented behaviour)
    expect(translate('en', 'kpi.target')).toBe('target {v}')
  })

  it('pickName prefers nameFa only in FA mode', () => {
    expect(pickName('Payment Gateway', 'درگاه پرداخت', 'fa')).toBe('درگاه پرداخت')
    expect(pickName('Payment Gateway', 'درگاه پرداخت', 'en')).toBe('Payment Gateway')
    expect(pickName('Payment Gateway', null, 'fa')).toBe('Payment Gateway')
  })
})

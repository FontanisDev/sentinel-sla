'use client'

// Sentinel-SLA — language store hook (EN ⇆ FA with RTL).
//
// Mirrors the role-switcher pattern: localStorage as an external store via
// useSyncExternalStore (hydration-safe, zero effects, HMR-safe). Any component
// can call useLang() and re-render when the user switches language.
//
// Per-language bundle split: the FA dictionary is code-split. It starts
// loading at bundle-evaluation time when localStorage already says 'fa'
// (see src/lib/i18n.ts), and this hook triggers/awaits it on switch —
// re-rendering subscribers once the strings land. Until then translate()
// falls back to EN, never a raw key.

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import {
  translate,
  pickName,
  loadFaDictionary,
  hasFaDictionary,
  type Lang,
  type TranslationKey,
} from '@/lib/i18n'

const LANG_KEY = 'sentinel-lang'
const LANG_EVENT = 'sentinel:lang-change'

// Bumped when the on-demand FA dictionary lands, so the external-store
// snapshot changes and useSyncExternalStore re-renders subscribers (the lang
// value alone would be unchanged 'fa' → 'fa' and React would skip it).
let faEpoch = 0

function subscribeLang(callback: () => void) {
  window.addEventListener(LANG_EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(LANG_EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

function getLangSnapshot(): string {
  try {
    return `${window.localStorage.getItem(LANG_KEY) === 'fa' ? 'fa' : 'en'}#${faEpoch}`
  } catch {
    return `en#${faEpoch}`
  }
}

function getServerLangSnapshot(): string {
  return 'en#0'
}

function parseLang(snapshot: string): Lang {
  return snapshot.startsWith('fa') ? 'fa' : 'en'
}

/** Set + broadcast the UI language (persisted to localStorage). */
export function setLang(next: Lang) {
  if (next === 'fa' && !hasFaDictionary()) {
    void loadFaDictionary().then(() => {
      faEpoch += 1
      window.dispatchEvent(new Event(LANG_EVENT))
    })
  }
  try {
    window.localStorage.setItem(LANG_KEY, next)
  } catch {
    // storage unavailable — the event below still applies it for this tab
  }
  window.dispatchEvent(new Event(LANG_EVENT))
}

export interface LangApi {
  lang: Lang
  isFa: boolean
  dir: 'ltr' | 'rtl'
  /** Translate a dictionary key with optional {var} interpolation. */
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
  /** Localized service display name (FA prefers nameFa). */
  name: (name: string, nameFa: string | null) => string
}

/**
 * Reactive language access. Re-renders the caller when the language changes —
 * and once more when the on-demand FA dictionary finishes loading.
 *
 *     const { t, dir, isFa } = useLang()
 *     <h2>{t('chaos.title')}</h2>
 */
export function useLang(): LangApi {
  const snapshot = useSyncExternalStore(subscribeLang, getLangSnapshot, getServerLangSnapshot)
  const lang = parseLang(snapshot)
  const isFa = lang === 'fa'

  // FA is code-split: kick the load off when an FA render needs it, then bump
  // the epoch + broadcast so every subscriber re-renders with the real FA
  // strings. (The EN fallback during the fetch window is the same EN the
  // server snapshot rendered, so hydration stays deterministic.)
  useEffect(() => {
    if (lang === 'fa' && !hasFaDictionary()) {
      void loadFaDictionary().then(() => {
        faEpoch += 1
        window.dispatchEvent(new Event(LANG_EVENT))
      })
    }
  }, [lang])

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang]
  )
  const name = useCallback(
    (serviceName: string, nameFa: string | null) => pickName(serviceName, nameFa, lang),
    [lang]
  )
  return { lang, isFa, dir: isFa ? 'rtl' : 'ltr', t, name }
}

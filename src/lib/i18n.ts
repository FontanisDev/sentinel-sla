// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA — bilingual UI dictionary registry (EN / FA)
//
// The product's core identity is that it "speaks two languages": technical
// for engineers and financial for executives — and, being built for Iranian
// fintech, the interface itself is fully bilingual (English ⇆ فارسی) with RTL
// support.
//
// Per-language bundle split: EN is statically imported (fallback language +
// type source of record); FA is code-split and loaded on demand by
// loadFaDictionary(). Until FA lands, translate('fa', …) falls back to EN —
// the UI never shows a raw key. The public API (translate, pickName,
// TranslationKey) is unchanged for consumers.
// ═══════════════════════════════════════════════════════════════════════════

import { en, type TranslationKey } from './i18n/en'
import type { Lang } from './i18n/lang'

export type { Lang } from './i18n/lang'
export type { TranslationKey } from './i18n/en'

let faLoadPromise: Promise<void> | null = null

export let faDictionary: Record<TranslationKey, string> | null = null

/** Register the FA dictionary (used by loadFaDictionary; null = unregister for tests). */
export function registerFaDictionary(dict: Record<TranslationKey, string> | null) {
  faDictionary = dict
  if (!dict) faLoadPromise = null // a later loadFaDictionary() re-imports the chunk
}

/** Dynamically import the FA chunk (code-split point) — idempotent. */
export function loadFaDictionary(): Promise<void> {
  if (!faLoadPromise) {
    faLoadPromise = import('./i18n/fa')
      .then((m) => { registerFaDictionary(m.fa) })
      .catch(() => { faLoadPromise = null }) // offline chunk failure → EN fallback stays
  }
  return faLoadPromise
}

/** True once the FA dictionary is registered (exposed for tests/QA). */
export function hasFaDictionary(): boolean {
  return faDictionary !== null
}

/** Translate one key with optional {var} interpolation (FA → EN fallback). */
export function translate(
  lang: Lang,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  const template =
    (lang === 'fa' ? faDictionary?.[key] : undefined) ?? en[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : m
  )
}

/** Pick the localized service display name (FA prefers nameFa when present). */
export function pickName(name: string, nameFa: string | null, lang: Lang): string {
  return lang === 'fa' && nameFa ? nameFa : name
}

// A returning FA user's dictionary starts loading at bundle-evaluation time —
// BEFORE React hydration — so the post-hydration FA render usually finds the
// strings already registered (same flip moment the app has always had: the
// server snapshot is EN and the client switches after hydration).
if (typeof window !== 'undefined') {
  try {
    if (window.localStorage.getItem('sentinel-lang') === 'fa') void loadFaDictionary()
  } catch {
    // storage unavailable — the hook loads FA when the user lands on 'fa'
  }
}

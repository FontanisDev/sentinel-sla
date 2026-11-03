'use client'

// Sentinel-SLA — MoneyValue (design system §6.6).
//
// The single way any Toman/Rial figure appears in the UI: compact magnitude
// ("2.40B T" / "۲٫۴۰ میلیارد تومان") with the FULL exact value in the tooltip,
// tabular mono digits, never wraps. Persian mode renders Persian digits and
// Iranian magnitudes — never mixed Latin digits inside one figure (doc §3).

import { cn } from '@/lib/utils'
import {
  formatTomansFullLocale,
  formatTomansLocale,
  formatTomansUltra,
} from '@/lib/format'
import { useLang } from '@/hooks/use-language'

export function MoneyValue({
  tomans,
  tone = 'default',
  className,
  compact = true,
  ultra = false,
}: {
  /** Integer Tomans (presentation unit — 1 Toman = 10 Rials). */
  tomans: number
  /** Colour semantics: table money cells stay default (doc §2 rule 3). */
  tone?: 'default' | 'crit' | 'warn' | 'ok'
  className?: string
  /** false renders the full grouped value instead of the compact magnitude. */
  compact?: boolean
  /** ultra-compact magnitude WITHOUT the تومان word (tight card headers). */
  ultra?: boolean
}) {
  const { lang } = useLang()
  const display = ultra
    ? formatTomansUltra(tomans, lang)
    : compact
      ? formatTomansLocale(tomans, lang)
      : formatTomansFullLocale(tomans, lang)
  const full = formatTomansFullLocale(tomans, lang)

  return (
    <span
      dir={lang === 'fa' ? 'rtl' : 'ltr'}
      title={full}
      className={cn(
        'inline-block max-w-full whitespace-nowrap font-mono text-[13px] tabular-nums',
        tone === 'crit' && 'text-crit',
        tone === 'warn' && 'text-warn',
        tone === 'ok' && 'text-ok',
        className,
      )}
    >
      {display}
    </span>
  )
}

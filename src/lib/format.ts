// Shared formatting helpers — Sentinel-SLA
//
// Locale-aware money formatting (design system §6.6): every money figure is
// displayed through MoneyValue, which uses these helpers. English keeps Latin
// digits; Persian renders Persian digits (۰–۹) with Iranian magnitudes
// (هزار / میلیون / میلیارد). Never mixed digits within one figure (doc §3).

import type { Lang } from '@/lib/i18n'

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const

/** Convert Latin digits in a string to Persian digits (presentation only). */
export function toPersianDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)])
}

/** Persian digits + Persian thousands separator for a pre-formatted string. */
function fa(s: string): string {
  return toPersianDigits(s).replace(/,/g, '٬')
}

/** Compact money label per language: "2.40B T" / "۲٫۴۰ میلیارد تومان". */
export function formatTomansLocale(value: number, lang: Lang): string {
  const abs = Math.abs(value)
  if (lang === 'fa') {
    if (abs >= 1_000_000_000) return `${fa((value / 1_000_000_000).toFixed(2).replace('.', '٫'))} میلیارد تومان`
    if (abs >= 1_000_000) return `${fa((value / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2).replace('.', '٫'))} میلیون تومان`
    if (abs >= 1_000) return `${fa((value / 1_000).toFixed(0))} هزار تومان`
    return `${fa(String(Math.round(value)))} تومان`
  }
  return formatTomans(value)
}

/** Full (non-compact) money label per language: "12,500,000 T" / "۱۲٬۵۰۰٬۰۰۰ تومان". */
export function formatTomansFullLocale(value: number, lang: Lang): string {
  const grouped = Math.round(value).toLocaleString('en-US')
  return lang === 'fa' ? `${fa(grouped)} تومان` : `${grouped} T`
}

/** Locale percent: "99.950%" / "۹۹٫۹۵۰٪" (digits localized, value untouched). */
export function formatPercentLocale(ratio: number, lang: Lang, digits = 3): string {
  const s = `${(ratio * 100).toFixed(digits)}%`
  return lang === 'fa' ? `${fa(s.replace('.', '٫').replace('%', ''))}٪` : s
}

/** Locale integer: "1,234" / "۱٬۲۳۴". */
export function formatNumberLocale(value: number, lang: Lang): string {
  const s = Math.round(value).toLocaleString('en-US')
  return lang === 'fa' ? fa(s) : s
}

/** Format Tomans compactly: 12_500_000 -> "12.5M T" style display string. */
export function formatTomans(value: number, opts?: { compact?: boolean }): string {
  const abs = Math.abs(value);
  if (opts?.compact === false) {
    return `${Math.round(value).toLocaleString('en-US')} T`;
  }
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B T`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M T`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(0)}K T`;
  return `${Math.round(value)} T`;
}

export function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** Billed minutes per the engine rule: max(1, ceil(seconds / 60)). */
export function billedMinutes(durationSec: number | null | undefined): number | null {
  if (durationSec === null || durationSec === undefined) return null;
  return Math.max(1, Math.ceil(durationSec / 60));
}

/** Format seconds into a human duration, e.g. 75 -> "1m 15s". */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Locale duration: "1m 15s" / "۱د ۱۵ث" (Persian unit abbreviations). */
export function formatDurationLocale(
  sec: number | null | undefined,
  lang: Lang,
): string {
  const base = formatDuration(sec);
  if (lang !== 'fa' || base === '—') return base;
  return toPersianDigits(base)
    .replace(/h/g, 'س')
    .replace(/m/g, 'د')
    .replace(/s/g, 'ث');
}

/** Format an ISO timestamp to local HH:mm:ss. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB', { hour12: false })}`;
}

export function formatPercent(ratio: number, digits = 3): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Format an ISO timestamp as a compact relative offset ("in 3d 4h" / "45m ago"). */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '—';
  const future = ms > 0;
  const abs = Math.abs(ms) / 1000;
  let text: string;
  if (abs < 60) text = `${Math.round(abs)}s`;
  else if (abs < 3600) {
    const m = Math.floor(abs / 60);
    text = m > 0 && abs % 60 >= 10 ? `${m}m ${Math.round(abs % 60)}s` : `${m}m`;
  } else if (abs < 86400) text = `${Math.floor(abs / 3600)}h ${Math.floor((abs % 3600) / 60)}m`;
  else text = `${Math.floor(abs / 86400)}d ${Math.floor((abs % 86400) / 3600)}h`;
  return future ? `in ${text}` : `${text} ago`;
}

/**
 * Ultra-compact magnitude for tight KPI cards: "8.90B T" / "۸٫۹۰ میلیارد".
 * The full exact value (with تومان) always lives in the tooltip — doc §6.6.
 */
export function formatTomansUltra(value: number, lang: Lang): string {
  const abs = Math.abs(value)
  if (lang === 'fa') {
    if (abs >= 1_000_000_000)
      return `${fa((value / 1_000_000_000).toFixed(abs >= 100_000_000_000 ? 0 : 1).replace('.', '٫'))} میلیارد`
    if (abs >= 1_000_000)
      return `${fa((value / 1_000_000).toFixed(abs >= 100_000_000 ? 0 : 1).replace('.', '٫'))} میلیون`
    if (abs >= 1_000) return `${fa((value / 1_000).toFixed(0))} هزار`
    return `${fa(String(Math.round(value)))} تومان`
  }
  return formatTomans(value)
}

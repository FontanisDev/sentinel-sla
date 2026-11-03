'use client'

// Sentinel-SLA — DateText (design system §6.13).
//
// The single way a calendar date (optionally with time) appears in the UI.
// Persian UI shows the Jalali calendar with Persian digits; English shows
// Gregorian. The small switch button flips the calendar display regardless
// of UI language ("DateText with calendar switch") — e.g. an English-speaking
// engineer checking a Jalali contract date. Both representations stay in the
// tooltip so nothing is lost when compact.

import { useSyncExternalStore } from 'react'
import { CalendarCog } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLang } from '@/hooks/use-language'
import { cn } from '@/lib/utils'
import {
  formatDateText,
  formatJalaliDate,
  formatJalaliDateLong,
} from '@/lib/jalali'

// Calendar preference: per-user, persisted like language/theme. Kept here so
// every DateText on the page flips together (external store, HMR-safe).
const CAL_KEY = 'sentinel-calendar'
const CAL_EVENT = 'sentinel:calendar-change'

export type CalendarPref = 'auto' | 'jalali' | 'gregorian'

function subscribeCal(cb: () => void) {
  window.addEventListener(CAL_EVENT, cb)
  window.addEventListener('storage', cb)
  return () => {
    window.removeEventListener(CAL_EVENT, cb)
    window.removeEventListener('storage', cb)
  }
}

function getCalSnapshot(): CalendarPref {
  try {
    const v = window.localStorage.getItem(CAL_KEY)
    return v === 'jalali' || v === 'gregorian' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

function getCalServer(): CalendarPref {
  return 'auto'
}

export function setCalendarPref(next: CalendarPref) {
  try {
    window.localStorage.setItem(CAL_KEY, next)
  } catch {
    /* ignore — event below still applies for this tab */
  }
  window.dispatchEvent(new Event(CAL_EVENT))
}

/**
 * Resolve a preference to a concrete calendar ('auto' follows the UI
 * language). Shared by DateText, JalaliDatePicker and TimeRange so every
 * date surface flips together (§6.13 "per user setting").
 */
export function resolveCalendar(pref: CalendarPref, isFa: boolean): 'jalali' | 'gregorian' {
  if (pref === 'auto') return isFa ? 'jalali' : 'gregorian'
  return pref
}

/** Reactive calendar preference; re-renders the caller when it changes. */
export function useCalendarPref(): CalendarPref {
  return useSyncExternalStore(subscribeCal, getCalSnapshot, getCalServer)
}

/** "16 Mehr 1405" vs "16 مهر ۱۴۰۵" — the plain value in the chosen calendar. */
function renderValue(
  date: Date,
  shown: 'jalali' | 'gregorian',
  lang: 'en' | 'fa',
  withTime: boolean,
): string {
  if (shown === 'jalali') {
    const jalali = lang === 'fa' ? formatJalaliDate(date, 'fa') : formatJalaliDate(date, 'en')
    if (!withTime) return jalali
    const time = date.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' })
    return lang === 'fa' ? `${jalali}، ${time}` : `${jalali}, ${time}`
  }
  const gregorian = date.toLocaleDateString(lang === 'fa' ? 'fa-IR-u-ca-gregory' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  if (!withTime) return gregorian
  const time = date.toLocaleTimeString(lang === 'fa' ? 'en-GB' : 'en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  })
  return lang === 'fa' ? `${gregorian}، ${time}` : `${gregorian}, ${time}`
}

export function DateText({
  date,
  withTime = false,
  long = false,
  className,
  switchable = true,
}: {
  /** ISO string or Date. */
  date: string | Date | null | undefined
  /** Append HH:mm to the displayed value. */
  withTime?: boolean
  /** Include the weekday name (Jalali side only — Gregorian uses locale). */
  long?: boolean
  className?: string
  /** Show the calendar-switch button (default). */
  switchable?: boolean
}) {
  const { t, lang, isFa } = useLang()
  const pref = useSyncExternalStore(subscribeCal, getCalSnapshot, getCalServer)

  if (!date) return <span className={className}>—</span>
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return <span className={className}>—</span>

  // "auto": follow the UI language (FA→Jalali, EN→Gregorian); a persisted
  // override wins until the user flips back through auto.
  const shown: 'jalali' | 'gregorian' =
    pref === 'auto' ? (isFa ? 'jalali' : 'gregorian') : pref

  const value =
    shown === 'jalali' && long
      ? formatJalaliDateLong(d, lang)
      : renderValue(d, shown, lang, withTime)
  const other = renderValue(d, shown === 'jalali' ? 'gregorian' : 'jalali', lang, withTime)

  const ariaLabel = switchable ? `${value} — ${t('date.switchCalendar')}` : value

  return (
    <span
      className={cn('group/dt inline-flex items-center gap-0.5 whitespace-nowrap', className)}
      title={other}
    >
      <span className="tabular-nums">{value}</span>
      {switchable ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-5 shrink-0 text-t3 opacity-0 transition-opacity duration-150 group-hover/dt:opacity-100 focus-visible:opacity-100 hover:text-t1"
          aria-label={ariaLabel}
          onClick={(e) => {
            e.stopPropagation()
            setCalendarPref(shown === 'jalali' ? 'gregorian' : 'jalali')
          }}
        >
          <CalendarCog className="size-3" aria-hidden="true" />
        </Button>
      ) : null}
    </span>
  )
}

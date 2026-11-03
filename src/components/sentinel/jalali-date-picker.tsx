'use client'

// Sentinel-SLA — JalaliDatePicker (design system §6.13).
//
// A popover month-grid date picker on the pure jalali core. Primary grid is
// Jalali (Persian digits in FA, transliterated months in EN); the header
// switch flips to a Gregorian grid of the SAME value — both represent the
// identical instant, so selection round-trips through either calendar.
//
// Week start: Saturday in FA (Persian week), Sunday in EN. Keyboard: the
// grid is a labelled group of buttons (Tab-reachable), Escape closes, and
// the month navigation buttons carry bilingual aria-labels.

import { useMemo, useState } from 'react'
import { CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { resolveCalendar, useCalendarPref } from '@/components/sentinel/date-text'
import { useLang } from '@/hooks/use-language'
import { cn } from '@/lib/utils'
import {
  gregorianMonthGrid,
  gregorianToJalali,
  jalaliMonthGrid,
  monthGridWeeks,
  weekdayHeaderLabels,
  type MonthGrid,
} from '@/lib/jalali'

type Shown = 'jalali' | 'gregorian'

/** Neighbouring-month coordinates for the header arrows. */
function shiftMonth(shown: Shown, y: number, m: number, delta: number): { y: number; m: number } {
  if (shown === 'jalali') {
    let m2 = m - 1 + delta
    let y2 = y
    while (m2 < 0) {
      m2 += 12
      y2 -= 1
    }
    while (m2 > 11) {
      m2 -= 12
      y2 += 1
    }
    return { y: y2, m: m2 + 1 }
  }
  let m2 = m - 1 + delta
  let y2 = y
  while (m2 < 0) {
    m2 += 12
    y2 -= 1
  }
  while (m2 > 11) {
    m2 -= 12
    y2 += 1
  }
  return { y: y2, m: m2 + 1 }
}

function gridFor(shown: Shown, y: number, m: number, lang: 'en' | 'fa'): MonthGrid {
  return shown === 'jalali' ? jalaliMonthGrid(y, m, lang) : gregorianMonthGrid(y, m, lang)
}

export function JalaliDatePicker({
  value,
  onValueChange,
  placeholder,
  disabled,
  className,
  id,
}: {
  /** Selected instant (local midnight when picked from the grid). */
  value: Date | null
  onValueChange: (next: Date) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  id?: string
}) {
  const { t, lang, isFa } = useLang()
  // §6.13 "per user setting": the primary grid follows the persisted
  // calendar preference (DateText switch); 'auto' follows the UI language.
  const calPref = useCalendarPref()
  const preferred: Shown = resolveCalendar(calPref, isFa)
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<Shown>(preferred)

  // A pref flip outside the popover re-targets the primary grid — the React
  // "adjust state during render" pattern (setState in an effect is a cascade).
  const [lastPreferred, setLastPreferred] = useState(preferred)
  if (lastPreferred !== preferred) {
    setLastPreferred(preferred)
    if (!open) setShown(preferred)
  }

  // View coordinates: derived from the selected value when opening.
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const base = value ?? new Date()
    const j = gregorianToJalali(base)
    return shown === 'jalali'
      ? { y: j.jy, m: j.jm }
      : { y: base.getFullYear(), m: base.getMonth() + 1 }
  })

  const grid = useMemo(() => gridFor(shown, view.y, view.m, lang), [shown, view, lang])
  const weeks = useMemo(() => monthGridWeeks(grid, lang), [grid, lang])
  const headers = weekdayHeaderLabels(lang)

  const switchCalendar = (next: Shown) => {
    // Anchor the other calendar's view on the SELECTED day (or today) — its
    // own coordinates, not an offset guess (Esfand ↔ February straddles years).
    const anchor = value ?? grid.to_date(1)
    const j = gregorianToJalali(anchor)
    setShown(next)
    setView(
      next === 'jalali'
        ? { y: j.jy, m: j.jm }
        : { y: anchor.getFullYear(), m: anchor.getMonth() + 1 },
    )
  }

  const display = value
    ? value.toLocaleDateString(lang === 'fa' ? 'fa-IR' : 'en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : null

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          const base = value ?? new Date()
          const j = gregorianToJalali(base)
          setShown(preferred)
          setView(
            preferred === 'jalali'
              ? { y: j.jy, m: j.jm }
              : { y: base.getFullYear(), m: base.getMonth() + 1 },
          )
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={disabled}
          className={cn(
            'h-8 justify-between gap-2 border-line bg-inset px-3 text-[13px] font-normal text-t1 hover:bg-raised',
            !value && 'text-t3',
            className,
          )}
        >
          <span className="truncate tabular-nums">{display ?? placeholder ?? t('picker.pickDate')}</span>
          <CalendarIcon className="size-3.5 shrink-0 text-t3" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-72 border-line bg-surface p-3 shadow-lg"
        role="dialog"
        aria-label={t('picker.title')}
      >
        {/* header: month nav · calendar switch */}
        <div className="mb-2 flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-t2 hover:text-t1"
            aria-label={t('picker.prevMonth')}
            onClick={() => setView((v) => shiftMonth(shown, v.y, v.m, -1))}
          >
            <ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />
          </Button>
          <p className="text-[13px] font-semibold text-t1">{grid.title}</p>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-t2 hover:text-t1"
            aria-label={t('picker.nextMonth')}
            onClick={() => setView((v) => shiftMonth(shown, v.y, v.m, 1))}
          >
            <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
          </Button>
        </div>

        {/* calendar switch — Jalali ⇆ Gregorian of the same instant */}
        <div
          className="mb-2 flex items-center rounded-sm border border-line bg-inset p-0.5"
          role="group"
          aria-label={t('date.switchCalendar')}
        >
          {(['jalali', 'gregorian'] as const).map((cal) => (
            <Button
              key={cal}
              variant="ghost"
              size="sm"
              className={cn(
                'h-6 flex-1 rounded-none px-2 text-[11px]',
                shown === cal ? 'bg-raised text-t1' : 'text-t3',
              )}
              aria-pressed={shown === cal}
              onClick={() => switchCalendar(cal)}
            >
              {cal === 'jalali' ? t('date.jalaliCalendarShort') : t('date.gregorianCalendarShort')}
            </Button>
          ))}
        </div>

        {/* weekday headers */}
        <div className="mb-1 grid grid-cols-7 gap-0.5" aria-hidden="true">
          {headers.map((h) => (
            <span key={h} className="text-center text-[10px] font-medium uppercase text-t3">
              {h}
            </span>
          ))}
        </div>

        {/* day grid */}
        <div role="group" aria-label={grid.title} className="grid grid-cols-7 gap-0.5">
          {weeks.flat().map((day, i) => {
            if (day === null) return <span key={`b${i}`} aria-hidden="true" />
            const dayDate = grid.to_date(day)
            const selected =
              value !== null &&
              dayDate.getFullYear() === value.getFullYear() &&
              dayDate.getMonth() === value.getMonth() &&
              dayDate.getDate() === value.getDate()
            return (
              <Button
                key={day}
                variant="ghost"
                size="icon"
                onClick={() => {
                  onValueChange(dayDate)
                  setOpen(false)
                }}
                aria-label={dayDate.toLocaleDateString(lang === 'fa' ? 'fa-IR' : 'en-GB', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
                aria-pressed={selected}
                className={cn(
                  'size-8 rounded-[4px] font-mono text-[12px] tabular-nums',
                  selected
                    ? 'bg-brand text-brand-contrast hover:bg-brand'
                    : 'text-t1 hover:bg-raised',
                )}
              >
                {lang === 'fa' ? day.toLocaleString('fa-IR') : day}
              </Button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

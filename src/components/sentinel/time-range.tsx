'use client'

// Sentinel-SLA — TimeRange (design system §6.8).
//
// The binding range picker: Last 1h / 24h / 7d / 30d presets plus a custom
// range whose From/To bounds come from the shared JalaliDatePicker — so the
// custom calendar display (Jalali or Gregorian) follows the persisted user
// preference, exactly like DateText (§6.13 "per user setting").
//
// Semantics are honest and inclusive: `from` bounds the lower edge
// (inclusive), `to` the upper edge (inclusive). Presets set from = now − N
// and leave `to` open (data "up to the present"); custom keeps both bounds
// explicit so a paused or historical window is reproducible. The picker
// returns local midnight, so a picked To day is widened to 23:59:59.999 —
// the whole selected day is inside the window, matching what the user sees.

import { CalendarRange, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLang } from '@/hooks/use-language'
import { cn } from '@/lib/utils'
import { JalaliDatePicker } from './jalali-date-picker'
import {
  PRESET_MS,
  TIME_RANGE_PRESETS,
  endOfDay,
  resolveRange,
  type TimeRangePreset,
  type TimeRangeValue,
} from '@/lib/stat-range'

export type { TimeRangePreset, TimeRangeValue }

const PRESETS = TIME_RANGE_PRESETS

// resolveRange / endOfDay / PRESET_MS live in @/lib/stat-range (pure core,
// unit-pinned); re-exported so consumers keep one import site.
export { resolveRange, endOfDay, PRESET_MS }

export function TimeRange({
  value,
  onChange,
  className,
}: {
  value: TimeRangeValue
  onChange: (next: TimeRangeValue) => void
  className?: string
}) {
  const { t } = useLang()

  const pick = (preset: TimeRangePreset) => {
    if (preset === 'custom') {
      // Enter custom mode with sane defaults derived from the current view,
      // never from invented data: last 24 h as the starting bounds.
      const from = value.from ?? new Date(Date.now() - PRESET_MS['24h'])
      const to = value.to
      onChange({ preset: 'custom', from, to })
      return
    }
    onChange({ preset, from: new Date(Date.now() - PRESET_MS[preset]), to: null })
  }

  const clearCustom = () => onChange({ preset: '24h', from: new Date(Date.now() - PRESET_MS['24h']), to: null })

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        role="group"
        aria-label={t('timeRange.label')}
        className="inline-flex w-fit flex-wrap items-center gap-1 rounded-[6px] border border-line bg-inset p-0.5"
      >
        {PRESETS.map((p) => (
          <Button
            key={p}
            variant="ghost"
            size="sm"
            aria-pressed={value.preset === p}
            className={cn(
              'h-7 rounded-[4px] px-2.5 text-[11px] font-medium',
              value.preset === p
                ? 'bg-raised text-t1 shadow-none'
                : 'text-t3 hover:bg-raised hover:text-t1',
            )}
            onClick={() => pick(p)}
          >
            {t(`timeRange.${p}` as const)}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={value.preset === 'custom'}
          aria-label={t('timeRange.custom')}
          className={cn(
            'h-7 rounded-[4px] px-2.5 text-[11px] font-medium',
            value.preset === 'custom'
              ? 'bg-raised text-t1 shadow-none'
              : 'text-t3 hover:bg-raised hover:text-t1',
          )}
          onClick={() => pick('custom')}
        >
          <CalendarRange className="me-1 size-3.5" aria-hidden="true" />
          {t('timeRange.custom')}
        </Button>
      </div>
      {value.preset === 'custom' ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label htmlFor="tr-from" className="block text-[10px] font-medium tracking-wider text-t3">
              {t('timeRange.from')}
            </label>
            <JalaliDatePicker
              id="tr-from"
              value={value.from}
              onValueChange={(d) => onChange({ ...value, from: d })}
              className="w-[10.5rem]"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="tr-to" className="block text-[10px] font-medium tracking-wider text-t3">
              {t('timeRange.to')}
            </label>
            <JalaliDatePicker
              id="tr-to"
              value={value.to}
              onValueChange={(d) => onChange({ ...value, to: endOfDay(d) })}
              className="w-[10.5rem]"
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-t3 hover:text-crit"
            aria-label={t('timeRange.clear')}
            onClick={clearCustom}
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}

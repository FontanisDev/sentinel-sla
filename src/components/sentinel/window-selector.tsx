'use client'

// Sentinel-SLA — analytics display-window selector (v2.4).
//
// A compact segmented control (6h / 12h / 24h) that drives the shared
// analytics query window: error budgets, MTTD/MTTR trends and the status
// heatmap all re-fetch with the selected window (server adapts bucket
// sizes: 5/10/15 min). Persisted per browser via localStorage.

import { CalendarClock } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useLang } from '@/hooks/use-language'
import { useAnalyticsWindow } from '@/hooks/use-analytics-window'
import type { AnalyticsWindow } from '@/lib/types'

const OPTIONS: readonly AnalyticsWindow[] = [6, 12, 24]

export function WindowSelector({ className }: { className?: string }) {
  const { t } = useLang()
  const { windowHours, setWindow } = useAnalyticsWindow()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={String(windowHours)}
          onValueChange={(v) => {
            if (v) setWindow(Number(v) as AnalyticsWindow)
          }}
          aria-label={t('window.selector.label')}
          className={cn('h-8 shrink-0 bg-surface-2', className)}
        >
          {OPTIONS.map((h) => (
            <ToggleGroupItem
              key={h}
              value={String(h)}
              aria-label={t('window.option', { h })}
              className="gap-1 px-2.5 text-[11px] font-medium tabular-nums"
            >
              {h === 24 ? <CalendarClock className="size-3" aria-hidden="true" /> : null}
              {t('window.option', { h })}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t('window.selector.tooltip')}</TooltipContent>
    </Tooltip>
  )
}

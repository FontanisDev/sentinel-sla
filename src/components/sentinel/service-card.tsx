'use client'

import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatPercent } from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import type { ServiceDTO } from '@/lib/types'
import { serviceStatus } from './status'
import { useIsLightTheme } from './palette'
import { Sparkline } from './sparkline'

export function ServiceCard({ service }: { service: ServiceDTO }) {
  const { t, name } = useLang()
  const isLight = useIsLightTheme()
  const st = serviceStatus(service.status, !isLight)

  /** Baseline = average of the earliest probes in the window. */
  const baseLatency = useMemo(() => {
    const pts = service.series.latencyMs
    if (pts.length === 0) return service.latencyMs
    const n = Math.min(10, pts.length)
    let sum = 0
    for (let i = 0; i < n; i++) sum += pts[i]
    return sum / n
  }, [service])

  const delta = service.latencyMs - baseLatency
  const deltaPct = baseLatency > 0 ? (delta / baseLatency) * 100 : 0
  const deltaTone =
    deltaPct > 25 ? 'text-warn' : deltaPct < -5 ? 'text-ok' : 'text-muted-foreground'
  const meetsTarget = service.uptime >= service.slaTarget

  return (
    <Card
      className={cn(
        // border-s-* is the logical inset border → flips to the right in RTL
        'sentinel-card-highlight gap-3 rounded-[6px] border-s-4 bg-card p-4 shadow-none',
        service.status === 'down' && 'border-s-crit/80',
        service.status === 'degraded' && 'border-s-warn/80',
        service.status === 'up' && 'border-s-ok/70'
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative flex size-2.5 shrink-0">
            {service.status === 'down' ? (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-crit opacity-60" />
            ) : null}
            <span
              className={cn('relative inline-flex size-2.5 rounded-full', st.dot)}
              aria-hidden="true"
            />
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="truncate text-sm font-semibold text-foreground">{name(service.name, service.nameFa)}</span>
              {name(service.name, service.nameFa) !== service.name ? (
                <span className="shrink-0 text-[10px] text-muted-foreground" lang="en" dir="ltr">
                  {service.name}
                </span>
              ) : service.nameFa ? (
                <span className="shrink-0 text-[10px] text-muted-foreground" lang="fa" dir="rtl">
                  {service.nameFa}
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <Badge variant="outline" className="border-line bg-raised px-1.5 text-[9px] text-muted-foreground">
                {service.tier}
              </Badge>
              <Badge variant="outline" className="border-line bg-raised px-1.5 text-[9px] text-muted-foreground">
                {service.criticality}
              </Badge>
            </div>
          </div>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
            meetsTarget ? 'border-ok/20 bg-ok-subtle text-ok' : 'border-crit/25 border-crit/25 bg-crit-subtle text-crit'
          )}
        >
          {formatPercent(service.uptime, 2)}
        </span>
      </div>

      {/* Live metrics */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg bg-surface-2 px-2.5 py-2">
          <p className="text-[9px] font-medium tracking-wider text-muted-foreground">{t('scard.latency')}</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
            {Math.round(service.latencyMs)}
            <span className="ms-0.5 text-[10px] font-normal text-muted-foreground">ms</span>
          </p>
          <p className={cn('text-[10px] tabular-nums', deltaTone)} dir="ltr">
            {delta >= 0 ? '+' : ''}
            {t('scard.vsBase', { v: Math.round(Math.abs(delta)) })}
          </p>
        </div>
        <div className="rounded-lg bg-surface-2 px-2.5 py-2">
          <p className="text-[9px] font-medium tracking-wider text-muted-foreground">{t('scard.errorRate')}</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
            {(service.errorRate * 100).toFixed(2)}
            <span className="ms-0.5 text-[10px] font-normal text-muted-foreground">%</span>
          </p>
          <p className="text-[10px] text-muted-foreground">{t('scard.live')}</p>
        </div>
        <div className="rounded-lg bg-surface-2 px-2.5 py-2">
          <p className="text-[9px] font-medium tracking-wider text-muted-foreground">{t('scard.throughput')}</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">
            {Math.round(service.throughput)}
            <span className="ms-0.5 text-[10px] font-normal text-muted-foreground">tx/s</span>
          </p>
          <p className="text-[10px] text-muted-foreground">{t('scard.nominal', { v: service.tps })}</p>
        </div>
      </div>

      {/* Sparkline (time axis always LTR) */}
      <div dir="ltr">
        <Sparkline values={service.series.latencyMs} color={st.stroke} />
      </div>

      {/* Uptime vs target */}
      <div>
        <div className="flex items-baseline justify-between text-[10px]">
          <span className="text-muted-foreground">{t('scard.uptimeVs')}</span>
          <span className="tabular-nums text-muted-foreground" dir="ltr">
            <span className={meetsTarget ? 'font-medium text-ok' : 'font-medium text-crit'}>
              {formatPercent(service.uptime)}
            </span>{' '}
            / {formatPercent(service.slaTarget, 2)}
          </span>
        </div>
        <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.05]">
          <div
            className={cn('h-full rounded-full transition-all duration-500', st.bar)}
            style={{ width: `${Math.min(100, service.uptime * 100)}%` }}
          />
          <div
            className="absolute inset-y-0 w-px bg-white/40"
            style={{ insetInlineStart: `${Math.min(100, service.slaTarget * 100)}%` }}
            title={t('scard.slaTarget')}
            aria-hidden="true"
          />
        </div>
      </div>
    </Card>
  )
}

'use client'

// Sentinel-SLA — availability heatmap (v2 analytics, engineer view).
// Status-page style grid: one row per service, 5-minute buckets over the last
// 6h. ~450 cells render as plain memoized divs with title tooltips — NO radix
// Tooltip portals (they would freeze the page at this count).

import { memo, useMemo } from 'react'
import { Grid3x3 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatPercent } from '@/lib/format'
import { useLang, type LangApi } from '@/hooks/use-language'
import type { AnalyticsDTO, HeatmapBucketDTO, ServiceDTO } from '@/lib/types'
import { EmptyState } from './empty-state'
import { WindowSelector } from './window-selector'

/** Cell class from a bucket score: 1 = up, 0 = down, fractional = degraded. */
function cellClass(score: number | null | undefined): string {
  if (score === null || score === undefined) return 'bg-black/[0.06] dark:bg-white/[0.06]'
  if (score >= 0.999) return 'bg-ok bg-ok'
  if (score > 0.001) return 'bg-warn bg-warn'
  return 'bg-crit bg-crit'
}

/** Localized tooltip text for one cell (title attribute). */
function cellTitle(
  score: number | null | undefined,
  ts: number,
  t: LangApi['t']
): string {
  const time = new Date(ts).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' })
  if (score === null || score === undefined) return `${t('heatmap.noData')} · ${time}`
  if (score >= 0.999) return `${t('heatmap.up')} · ${time}`
  if (score <= 0.001) return `${t('heatmap.down')} · ${time}`
  return `${t('heatmap.degraded')} · ${formatPercent(score, 0)} · ${time}`
}

/** One service row of cells — memoized (dense, re-renders only on data change). */
const HeatmapRow = memo(function HeatmapRow({
  serviceKey,
  buckets,
  t,
}: {
  serviceKey: string
  buckets: HeatmapBucketDTO[]
  t: LangApi['t']
}) {
  return (
    <div className="flex gap-1">
      {buckets.map((bucket) => {
        const score = bucket.services[serviceKey] ?? null
        return (
          <div
            key={bucket.ts}
            className={cn('size-3.5 shrink-0 rounded-[3px] transition-colors', cellClass(score))}
            title={cellTitle(score, bucket.ts, t)}
          />
        )
      })}
    </div>
  )
})

/** The bucket grid (header time labels + one cell row per service), LTR. */
const HeatmapGrid = memo(function HeatmapGrid({
  serviceKeys,
  buckets,
  labelEvery,
  t,
}: {
  serviceKeys: string[]
  buckets: HeatmapBucketDTO[]
  labelEvery: number
  t: LangApi['t']
}) {
  return (
    <div className="w-max" dir="ltr">
      {/* Time axis — one label per ~30min; absolutely positioned so the narrow
          slots don't shift bucket alignment. */}
      <div className="mb-1.5 flex items-end gap-1" aria-hidden="true">
        {buckets.map((bucket, i) => (
          <div key={bucket.ts} className="relative h-3 w-3.5 shrink-0">
            {i % labelEvery === 0 ? (
              <span className="absolute bottom-0 left-0 whitespace-nowrap text-[9px] tabular-nums text-muted-foreground">
                {new Date(bucket.ts).toLocaleTimeString('en-GB', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            ) : null}
          </div>
        ))}
        <span className="ms-1.5 whitespace-nowrap text-[9px] font-medium text-ok">
          {t('heatmap.now')}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {serviceKeys.map((key) => (
          <HeatmapRow key={key} serviceKey={key} buckets={buckets} t={t} />
        ))}
      </div>
    </div>
  )
})

export function AvailabilityHeatmap({
  analytics,
  services,
  pending = false,
}: {
  analytics: AnalyticsDTO | undefined
  services: ServiceDTO[]
  pending?: boolean
}) {
  const { t, name } = useLang()
  const buckets = analytics?.heatmap.buckets ?? []
  const bucketSizeMin = analytics?.heatmap.bucketSizeMin ?? 5
  // v2.3: bucket size adapts server-side (5/10/15 min), so the full
  // requested window renders with a legible grid.
  const heatmapHours = analytics?.windowHours ?? 6

  // Rows follow the dashboard service order; heatmap keys carry the scores.
  const rows = useMemo(
    () =>
      services
        .map((service) => ({
          service,
          scores: buckets.map((b) => b.services[service.key] ?? null),
        }))
        .filter((r) => r.scores.some((s) => s !== null)),
    [services, buckets]
  )

  // Per-service average availability for an accessible row summary.
  const rowStats = useMemo(
    () =>
      rows.map((r) => {
        const known = r.scores.filter((s): s is number => s !== null)
        const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null
        return { key: r.service.key, avg }
      }),
    [rows]
  )
  const avgByKey = new Map(rowStats.map((s) => [s.key, s.avg]))

  const legend = [
    { dot: 'bg-ok bg-ok', label: t('heatmap.up') },
    { dot: 'bg-warn bg-warn', label: t('heatmap.degraded') },
    { dot: 'bg-crit bg-crit', label: t('heatmap.down') },
    { dot: 'bg-black/[0.06] dark:bg-white/[0.06]', label: t('heatmap.noData') },
  ]

  return (
    <section aria-label={t('heatmap.title')} className="space-y-3">
      <Card className="sentinel-card-highlight gap-4 rounded-[6px] shadow-none">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {t('heatmap.title')}
            <span className="ms-auto hidden sm:inline-flex">
              <WindowSelector />
            </span>
          </CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-2">
            <span>
              {t('heatmap.desc', { min: bucketSizeMin, h: heatmapHours })}
              {rows.length ? (
                <span className="ms-1.5 rounded-full border border-black/[0.08] dark:border-white/[0.08] bg-surface-2 px-1.5 py-px align-middle text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('eng.services', { n: rows.length })}
                </span>
              ) : null}
            </span>
            {/* v2.5: mobile affordance — the window switcher lives right on the
                heatmap header below sm (was only reachable via the trends
                header, hurting discoverability on phones). */}
            <span className="sm:hidden">
              <WindowSelector />
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending && rows.length === 0 ? (
            <div className="sentinel-shimmer h-28 w-full rounded-[6px]" aria-busy="true" aria-hidden="true" />
          ) : rows.length === 0 || buckets.length === 0 ? (
            <EmptyState
              icon={Grid3x3}
              title={t('heatmap.empty.title')}
              description={t('heatmap.empty.desc')}
              className="py-8"
            />
          ) : (
            <div className="flex gap-3">
              {/* Service label column — stays outside the LTR grid so Persian
                  names keep their own direction; hugs the grid on both LTR/RTL. */}
              <div className="flex w-28 shrink-0 flex-col gap-1" aria-hidden="true">
                <div className="mb-1.5 h-3 shrink-0" />
                {rows.map(({ service }) => (
                  <div key={service.id} className="flex h-3.5 items-center justify-end">
                    <span className="truncate text-end text-[10px] text-muted-foreground">
                      {name(service.name, service.nameFa)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="sentinel-scroll-native min-w-0 flex-1 self-start overflow-x-auto pb-1" tabIndex={0} aria-label={t('heatmap.scroll')}>
                <HeatmapGrid
                  serviceKeys={rows.map((r) => r.service.key)}
                  buckets={buckets}
                  labelEvery={Math.max(1, Math.round(30 / bucketSizeMin))}
                  t={t}
                />
              </div>
              {/* Screen-reader summary per service (visual grid is decorative) */}
              <div className="sr-only">
                {rows.map(({ service }) => {
                  const avg = avgByKey.get(service.key)
                  return (
                    <p key={service.id}>
                      {t('heatmap.rowAria', {
                        name: name(service.name, service.nameFa),
                        pct: formatPercent(avg ?? 0, 0),
                      })}
                    </p>
                  )
                })}
              </div>
            </div>
          )}
          {/* Legend */}
          <div className="mt-4 flex flex-wrap items-center justify-end gap-x-4 gap-y-1.5">
            {legend.map((item) => (
              <span key={item.label} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className={cn('inline-block size-2 rounded-[3px]', item.dot)} aria-hidden="true" />
                {item.label}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>
    </section>
  )
}

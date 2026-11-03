'use client'

// Sentinel-SLA — MTTD / MTTA / MTTR & incident trend chart (v2 analytics, engineer view).
// Hourly buckets over the 24h analytics window: incident count as amber bars
// (right axis) + MTTD/MTTA/MTTR seconds as teal/violet/rose lines (left axis).
// §6.10 wrapper: 1 px grid at 8 %, mono ticks, crosshair, legend toggles,
// view-as-table fallback (§8).

import { useMemo } from 'react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from 'recharts'
import { LineChart as LineChartIcon } from 'lucide-react'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatClock } from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import type { AnalyticsDTO } from '@/lib/types'
import { useChartPalette } from './palette'
import { EmptyState } from './empty-state'
import {
  ChartDataTable,
  ChartLegend,
  ViewAsTableToggle,
  chartCursor,
  chartGridProps,
  chartTickClass,
  useHiddenSeries,
  useViewAsTable,
  type ChartTableColumn,
} from './chart-parts'

const AXIS_PROPS = {
  tickLine: false,
  axisLine: false,
  tickMargin: 6,
} as const

interface TrendRow {
  t: string
  incidents: number
  mttd: number | null
  mtta: number | null
  mttr: number | null
}

/** A tiny tooltip formatter row — dot + series label + value with unit. */
function tooltipRow(value: unknown, name: unknown, item: { color?: string }, unit: string, label: string) {
  const num = typeof value === 'number' ? value : null
  return (
    <div className="flex w-full items-center justify-between gap-4 leading-none">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span
          className="inline-block size-2 shrink-0 rounded-[2px]"
          style={{ backgroundColor: item.color }}
          aria-hidden="true"
        />
        {label}
      </span>
      <span className="font-mono font-medium tabular-nums text-foreground">
        {num === null ? '—' : `${num.toLocaleString('en-US')}${unit}`}
      </span>
      <span className="sr-only">{String(name)}</span>
    </div>
  )
}

export function TrendsChart({
  analytics,
  pending = false,
  actions,
}: {
  analytics: AnalyticsDTO | undefined
  pending?: boolean
  /** optional right-aligned action cluster (e.g. export buttons) */
  actions?: React.ReactNode
}) {
  const { t } = useLang()
  const palette = useChartPalette()
  const { asTable, toggle: toggleTable } = useViewAsTable()

  const config: ChartConfig = useMemo(
    () => ({
      incidents: { label: t('trends.incidents'), color: palette.amber },
      mttd: { label: t('trends.mttd'), color: palette.teal },
      mtta: { label: t('trends.mtta'), color: palette.violet },
      mttr: { label: t('trends.mttr'), color: palette.rose },
    }),
    [t, palette]
  )

  const rows: TrendRow[] = useMemo(() => {
    if (!analytics) return []
    return analytics.trends.map((p) => ({
      t: formatClock(p.ts),
      incidents: p.incidents,
      mttd: p.mttdSec,
      mtta: p.mttaSec,
      mttr: p.mttrSec,
    }))
  }, [analytics])

  const { hidden, toggle } = useHiddenSeries(['incidents', 'mttd', 'mtta', 'mttr'])

  const legend = [
    { key: 'incidents' as const, color: palette.amber },
    { key: 'mttd' as const, color: palette.teal },
    { key: 'mtta' as const, color: palette.violet },
    { key: 'mttr' as const, color: palette.rose },
  ]

  const tableColumns: ChartTableColumn[] = useMemo(
    () => [
      { key: 't', label: t('charts.col.time') },
      { key: 'incidents', label: t('trends.incidents'), numeric: true, format: (v) => Number(v).toLocaleString('en-US') },
      { key: 'mttd', label: t('trends.mttd'), numeric: true, format: (v) => `${Number(v).toLocaleString('en-US')} s` },
      { key: 'mtta', label: t('trends.mtta'), numeric: true, format: (v) => `${Number(v).toLocaleString('en-US')} s` },
      { key: 'mttr', label: t('trends.mttr'), numeric: true, format: (v) => `${Number(v).toLocaleString('en-US')} s` },
    ],
    [t]
  )

  return (
    <Card className="sentinel-card-highlight gap-4 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t('trends.title')}
          <span className="ms-auto flex items-center gap-1.5">
            {actions}
            <ViewAsTableToggle asTable={asTable} onToggle={toggleTable} />
          </span>
        </CardTitle>
        <CardDescription>{t('trends.desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {pending && rows.length === 0 ? (
          <div className="sentinel-shimmer h-[260px] w-full rounded-[6px]" aria-busy="true" aria-hidden="true" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={LineChartIcon}
            title={t('trends.empty.title')}
            description={t('trends.empty.desc')}
            className="py-10"
          />
        ) : asTable ? (
          <ChartDataTable rows={rows as unknown as Record<string, unknown>[]} columns={tableColumns} />
        ) : (
          <div className="space-y-2">
            <ChartLegend
              items={legend.map((item) => ({ key: item.key, label: config[item.key].label as string, color: item.color }))}
              hidden={hidden}
              onToggle={toggle}
            />
            {/* Charts stay LTR even in RTL mode (financial-chart convention) */}
            <div dir="ltr">
              <ChartContainer config={config} className={`aspect-auto h-[260px] w-full ${chartTickClass}`}>
                <ComposedChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 8 }}>
                  <CartesianGrid {...chartGridProps(palette.grid)} />
                  <XAxis dataKey="t" minTickGap={48} {...AXIS_PROPS} />
                  <YAxis yAxisId="sec" width={44} {...AXIS_PROPS} tickFormatter={(v: number) => `${v}s`} />
                  <YAxis yAxisId="count" orientation="right" width={32} allowDecimals={false} {...AXIS_PROPS} />
                  <ChartTooltip
                    cursor={chartCursor(palette.grid)}
                    content={
                      <ChartTooltipContent
                        indicator="line"
                        formatter={(value, name, item) => {
                          const key = String(item.dataKey ?? name)
                          if (key === 'incidents') {
                            return tooltipRow(value, name, item, '', t('trends.incidents'))
                          }
                          if (key === 'mttd') {
                            return tooltipRow(value, name, item, 's', t('trends.mttd'))
                          }
                          if (key === 'mtta') {
                            return tooltipRow(value, name, item, 's', t('trends.mtta'))
                          }
                          return tooltipRow(value, name, item, 's', t('trends.mttr'))
                        }}
                      />
                    }
                  />
                  {!hidden.has('incidents') ? (
                    <Bar
                      yAxisId="count"
                      dataKey="incidents"
                      fill="var(--color-incidents)"
                      fillOpacity={0.3}
                      stroke={palette.amber}
                      strokeWidth={1}
                      radius={[3, 3, 0, 0]}
                      isAnimationActive={false}
                    />
                  ) : null}
                  {!hidden.has('mttd') ? (
                    <Line
                      yAxisId="sec"
                      dataKey="mttd"
                      type="monotone"
                      stroke="var(--color-mttd)"
                      strokeWidth={1.6}
                      dot={false}
                      activeDot={{ r: 3 }}
                      isAnimationActive={false}
                    />
                  ) : null}
                  {!hidden.has('mtta') ? (
                    <Line
                      yAxisId="sec"
                      dataKey="mtta"
                      type="monotone"
                      stroke="var(--color-mtta)"
                      strokeWidth={1.6}
                      strokeDasharray="5 3"
                      dot={false}
                      activeDot={{ r: 3 }}
                      isAnimationActive={false}
                    />
                  ) : null}
                  {!hidden.has('mttr') ? (
                    <Line
                      yAxisId="sec"
                      dataKey="mttr"
                      type="monotone"
                      stroke="var(--color-mttr)"
                      strokeWidth={1.6}
                      dot={false}
                      activeDot={{ r: 3 }}
                      isAnimationActive={false}
                    />
                  ) : null}
                </ComposedChart>
              </ChartContainer>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

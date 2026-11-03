'use client'

import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts'
import { Activity, Gauge } from 'lucide-react'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { formatClock } from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import type { ServiceDTO } from '@/lib/types'
import { serviceStroke } from './status'
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

const POINTS = 120

const AXIS_PROPS = {
  tickLine: false,
  axisLine: false,
  tickMargin: 6,
} as const

/** Tooltip row: dot + series label + value with unit (replaces default row). */
function tooltipRow(
  value: unknown,
  label: unknown,
  color: string | undefined,
  unit: string
) {
  const num = typeof value === 'number' ? value : null
  return (
    <div className="flex w-full items-center justify-between gap-6 leading-none">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <span
          className="inline-block size-2 shrink-0 rounded-[2px]"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        {String(label)}
      </span>
      <span className="font-mono font-medium tabular-nums text-foreground">
        {num === null ? '—' : `${num.toLocaleString('en-US')}${unit}`}
      </span>
    </div>
  )
}

/** Fleet latency — one area per service, colored by health. */
export function LatencyChartCard({ services }: { services: ServiceDTO[] }) {
  const { t, name } = useLang()
  const palette = useChartPalette()
  const { asTable, toggle: toggleTable } = useViewAsTable()
  // Foundry: theme via next-themes (dark default); the stroke palette already
  // mirrors the tokens, so detect light through the hook's module sibling.
  const isLight = palette.up === '#1e8a58'
  const { rows, config, usable } = useMemo(() => {
    const usable = services.filter((s) => s.series.ts.length > 0)
    const count = usable.length ? Math.min(POINTS, Math.min(...usable.map((s) => s.series.ts.length))) : 0
    const rows: Record<string, number | string>[] = []
    const base = usable[0]
    if (base) {
      for (let i = 0; i < count; i++) {
        const row: Record<string, number | string> = {
          t: formatClock(new Date(base.series.ts[i]).toISOString()),
        }
        for (const s of usable) row[s.key] = s.series.latencyMs[i]
        rows.push(row)
      }
    }
    const config: ChartConfig = {}
    usable.forEach((s, idx) => {
      config[s.key] = { label: name(s.name, s.nameFa), color: serviceStroke(s.status, idx, !isLight) }
    })
    return { rows, config, usable }
  }, [services, name, isLight])

  const { hidden, toggle } = useHiddenSeries(useMemo(() => usable.map((s) => s.key), [usable]))
  const visible = usable.filter((s) => !hidden.has(s.key))

  const tableColumns: ChartTableColumn[] = useMemo(() => {
    const cols: ChartTableColumn[] = [{ key: 't', label: t('charts.col.time') }]
    for (const s of usable) {
      cols.push({
        key: s.key,
        label: name(s.name, s.nameFa),
        numeric: true,
        format: (v) => `${Number(v).toLocaleString('en-US')} ms`,
      })
    }
    return cols
  }, [usable, name, t])

  return (
    <Card className="sentinel-card-highlight gap-4 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t('charts.latency.title')}
          <span className="ms-auto">
            <ViewAsTableToggle asTable={asTable} onToggle={toggleTable} />
          </span>
        </CardTitle>
        <CardDescription>{t('charts.latency.desc', { n: POINTS })}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={Activity}
            title={t('charts.empty.title')}
            description={t('charts.empty.desc1')}
            className="py-10"
          />
        ) : asTable ? (
          <ChartDataTable rows={rows} columns={tableColumns} />
        ) : (
          <div className="space-y-2">
            <ChartLegend
              items={usable.map((s) => ({ key: s.key, label: name(s.name, s.nameFa), color: config[s.key].color ?? palette.teal }))}
              hidden={hidden}
              onToggle={toggle}
            />
            {/* Charts stay LTR even in RTL mode (financial-chart convention) */}
            <div dir="ltr">
            <ChartContainer config={config} className={`aspect-auto h-[220px] w-full ${chartTickClass}`}>
              <AreaChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
                <CartesianGrid {...chartGridProps(palette.grid)} />
                <XAxis dataKey="t" minTickGap={48} {...AXIS_PROPS} />
                <YAxis width={48} {...AXIS_PROPS} tickFormatter={(v: number) => `${v}ms`} />
                <ChartTooltip
                  cursor={chartCursor(palette.grid)}
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      formatter={(value, _name, item) =>
                        tooltipRow(
                          value,
                          config[String(item.dataKey)]?.label ?? String(item.dataKey),
                          item.color,
                          ' ms'
                        )
                      }
                    />
                  }
                />
                {visible.map((s) => (
                  <Area
                    key={s.key}
                    dataKey={s.key}
                    type="monotone"
                    stroke={`var(--color-${s.key})`}
                    fill={`var(--color-${s.key})`}
                    fillOpacity={0.06}
                    strokeWidth={1.6}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ChartContainer>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Fleet error rate vs throughput — dual axis. */
export function ErrorThroughputChartCard({ services }: { services: ServiceDTO[] }) {
  const { t } = useLang()
  const palette = useChartPalette()
  const { asTable, toggle: toggleTable } = useViewAsTable()
  const { rows } = useMemo(() => {
    const usable = services.filter((s) => s.series.ts.length > 0)
    const count = usable.length ? Math.min(POINTS, Math.min(...usable.map((s) => s.series.ts.length))) : 0
    const rows: Record<string, number | string>[] = []
    const base = usable[0]
    if (base) {
      for (let i = 0; i < count; i++) {
        const errAvg = usable.reduce((acc, s) => acc + (s.series.errorRate[i] ?? 0), 0) / usable.length
        const tps = usable.reduce((acc, s) => acc + (s.series.throughput[i] ?? 0), 0)
        rows.push({
          t: formatClock(new Date(base.series.ts[i]).toISOString()),
          err: Number((errAvg * 100).toFixed(2)),
          tps: Math.round(tps),
        })
      }
    }
    return { rows }
  }, [services])

  const config: ChartConfig = {
    err: { label: t('charts.err'), color: palette.rose },
    tps: { label: t('charts.tps'), color: palette.teal },
  }
  const { hidden, toggle } = useHiddenSeries(['tps', 'err'])

  const tableColumns: ChartTableColumn[] = [
    { key: 't', label: t('charts.col.time') },
    { key: 'tps', label: t('charts.tps'), numeric: true, format: (v) => `${Number(v).toLocaleString('en-US')} tx/s` },
    { key: 'err', label: t('charts.err'), numeric: true, format: (v) => `${Number(v).toLocaleString('en-US')} %` },
  ]

  return (
    <Card className="sentinel-card-highlight gap-4 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t('charts.errtps.title')}
          <span className="ms-auto">
            <ViewAsTableToggle asTable={asTable} onToggle={toggleTable} />
          </span>
        </CardTitle>
        <CardDescription>{t('charts.errtps.desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            icon={Gauge}
            title={t('charts.empty.title')}
            description={t('charts.empty.desc2')}
            className="py-10"
          />
        ) : asTable ? (
          <ChartDataTable rows={rows} columns={tableColumns} />
        ) : (
          <div className="space-y-2">
            <ChartLegend
              items={[
                { key: 'tps', label: t('charts.tps'), color: palette.teal },
                { key: 'err', label: t('charts.err'), color: palette.rose },
              ]}
              hidden={hidden}
              onToggle={toggle}
            />
            {/* Charts stay LTR even in RTL mode (financial-chart convention) */}
            <div dir="ltr">
            <ChartContainer config={config} className={`aspect-auto h-[220px] w-full ${chartTickClass}`}>
              <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: 8 }}>
                <CartesianGrid {...chartGridProps(palette.grid)} />
                <XAxis dataKey="t" minTickGap={48} {...AXIS_PROPS} />
                <YAxis yAxisId="tps" width={48} {...AXIS_PROPS} />
                <YAxis
                  yAxisId="err"
                  orientation="right"
                  width={48}
                  tickFormatter={(v: number) => `${v}%`}
                  {...AXIS_PROPS}
                />
                <ChartTooltip
                  cursor={chartCursor(palette.grid)}
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      formatter={(value, name, item) =>
                        name === 'err'
                          ? tooltipRow(value, t('charts.err'), item.color, '%')
                          : tooltipRow(value, t('charts.tps'), item.color, ' tx/s')
                      }
                    />
                  }
                />
                {!hidden.has('tps') ? (
                  <Line
                    yAxisId="tps"
                    dataKey="tps"
                    type="monotone"
                    stroke="var(--color-tps)"
                    strokeWidth={1.6}
                    dot={false}
                    isAnimationActive={false}
                  />
                ) : null}
                {!hidden.has('err') ? (
                  <Line
                    yAxisId="err"
                    dataKey="err"
                    type="monotone"
                    stroke="var(--color-err)"
                    strokeWidth={1.6}
                    dot={false}
                    isAnimationActive={false}
                  />
                ) : null}
              </LineChart>
            </ChartContainer>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

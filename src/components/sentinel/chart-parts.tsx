'use client'

// Sentinel-SLA — shared Chart wrapper parts (design system §6.10 + §8).
//
// One axes/grid/tooltip/legend style for EVERY Recharts card:
// - 1 px cartesian grid at 8 % opacity (solid, no dashes)
// - mono tabular tick labels (CSS hook appended to ChartContainer)
// - crosshair cursor on the tooltip
// - legend toggles (click a series to hide/show it)
// - accessible "view as table" fallback for every chart (doc §8: charts have
//   text alternatives and a view-as-table toggle)
//
// Charts stay LTR even in RTL mode (financial-chart convention) — callers wrap
// the plot in dir="ltr"; the table fallback does the same.

import { useCallback, useMemo, useState } from 'react'
import { Table2, LineChart as LineChartIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useLang } from '@/hooks/use-language'

/** Cartesian grid: 1 px solid lines at 8 % opacity (doc §6.10). */
export const chartGridProps = (grid: string) =>
  ({
    stroke: grid,
    strokeWidth: 1,
    strokeDasharray: undefined,
    vertical: false,
  }) as const

/** Vertical crosshair line under the tooltip, in the grid tone. */
export const chartCursor = (grid: string) =>
  ({ stroke: grid, strokeWidth: 1 }) as const

/**
 * CSS hooks appended to ChartContainer: mono tabular tick labels on both
 * axes (doc §6.10). The container already colours the tick text; this adds
 * the mono face + tabular digits.
 */
export const chartTickClass =
  '[&_.recharts-cartesian-axis-tick_text]:font-mono [&_.recharts-cartesian-axis-tick_text]:tabular-nums'

/** Hook: which series are hidden (legend toggles). */
export function useHiddenSeries(keys: readonly string[]) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const toggle = useCallback(
    (key: string) => {
      setHidden((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        // never allow hiding EVERY series — keep the chart meaningful
        if (next.size >= keys.length) return prev
        return next
      })
    },
    [keys.length]
  )
  return { hidden, toggle }
}

/** Interactive legend: click toggles the series (doc §6.10 "legend toggles"). */
export function ChartLegend({
  items,
  hidden,
  onToggle,
  className,
}: {
  items: { key: string; label: string; color: string }[]
  hidden: ReadonlySet<string>
  onToggle: (key: string) => void
  className?: string
}) {
  const { t } = useLang()
  return (
    <div
      role="group"
      aria-label={t('charts.legend')}
      className={cn('flex flex-wrap items-center justify-end gap-1.5', className)}
    >
      {items.map((item) => {
        const visible = !hidden.has(item.key)
        return (
          <Button
            key={item.key}
            variant="ghost"
            size="sm"
            onClick={() => onToggle(item.key)}
            aria-pressed={visible}
            title={t('charts.legendToggle')}
            className={cn(
              'h-6 gap-1.5 rounded-[4px] px-2 text-[10px] text-muted-foreground hover:bg-raised hover:text-foreground',
              !visible && 'text-muted-foreground/50 line-through decoration-1'
            )}
          >
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ backgroundColor: visible ? item.color : 'transparent', boxShadow: visible ? undefined : `inset 0 0 0 1.5px ${item.color}` }}
              aria-hidden="true"
            />
            {item.label}
          </Button>
        )
      })}
    </div>
  )
}

/** Chart ⇄ table toggle (doc §8 "view as table" toggle). */
export function ViewAsTableToggle({
  asTable,
  onToggle,
}: {
  asTable: boolean
  onToggle: () => void
}) {
  const { t } = useLang()
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-pressed={asTable}
      aria-label={asTable ? t('charts.viewChart') : t('charts.viewTable')}
      title={asTable ? t('charts.viewChart') : t('charts.viewTable')}
      className="h-7 gap-1.5 rounded-[4px] px-2 text-[11px] text-muted-foreground hover:bg-raised hover:text-foreground"
    >
      {asTable ? (
        <LineChartIcon className="size-3.5" aria-hidden="true" />
      ) : (
        <Table2 className="size-3.5" aria-hidden="true" />
      )}
      {asTable ? t('charts.viewChart') : t('charts.viewTable')}
    </Button>
  )
}

/** One column of the accessible table fallback. */
export interface ChartTableColumn {
  key: string
  label: string
  /** numeric columns render mono/tabular, right-aligned */
  numeric?: boolean
  /** value formatter (already localized by the caller) */
  format?: (value: unknown) => string
}

/**
 * The chart's data as a real table (doc §8 text alternative). Reuses the
 * exact rows the chart plots — the table can never disagree with the chart.
 */
export function ChartDataTable({
  rows,
  columns,
  className,
}: {
  rows: Record<string, unknown>[]
  columns: ChartTableColumn[]
  className?: string
}) {
  const { t } = useLang()
  const cell = (col: ChartTableColumn, value: unknown) => {
    if (value === null || value === undefined) return '—'
    return col.format ? col.format(value) : String(value)
  }
  return (
    <div
      dir="ltr"
      className={cn(
        'sentinel-scroll-native max-h-[260px] overflow-y-auto rounded-sm border border-line',
        className
      )}
    >
      <table className="w-full border-collapse text-[12px]">
        <caption className="sr-only">{t('charts.tableCaption')}</caption>
        <thead className="sticky top-0 z-10 bg-surface-2">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cn(
                  'border-b border-line px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
                  col.numeric ? 'text-right' : 'text-left'
                )}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-line/60 last:border-0">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn(
                    'whitespace-nowrap px-2.5 py-1 text-foreground',
                    col.numeric ? 'text-right font-mono tabular-nums' : 'text-left'
                  )}
                >
                  {cell(col, row[col.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Convenience: memo-safe "show table instead of chart" state. */
export function useViewAsTable() {
  const [asTable, setAsTable] = useState(false)
  const toggle = useCallback(() => setAsTable((v) => !v), [])
  return useMemo(() => ({ asTable, toggle }), [asTable, toggle])
}

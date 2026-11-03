'use client'

// Sentinel-SLA — StatCard (design system §6.4).
//
// The binding stat tile: label, big mono/tabular figure, optional delta
// (arrow AND explicit sign — never one without the other), optional
// sparkline and the optional "how is this calculated?" popover behind any
// derived figure. KpiCard delegates here so every existing tile inherits
// the same behaviour; new pages should use StatCard directly.
//
// The sparkline is a hand-rolled inline SVG (no chart library) so the home
// JS budget stays small; the explain popover reuses FormulaPopover so the
// figure's inputs stay REAL and evidence-linked (truthful-numbers rule).

import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useChartPalette } from './palette'
import { FormulaPopover, type FormulaEvidence, type FormulaInput } from './formula-popover'
import { deltaLabel, deltaTone, type StatDelta } from '@/lib/stat-range'
import type { LucideIcon } from 'lucide-react'

export type StatTone = 'default' | 'good' | 'warn' | 'bad'
export type { StatDelta }

export interface StatExplain {
  /** Symbolic formula, e.g. "lost tx × avg tx value". */
  formula: string
  inputs: FormulaInput[]
  evidence?: FormulaEvidence[]
}

/* Foundry tokens (§2): status colour pairs with meaning; the tile stays
   neutral otherwise so tables of stats read calmly. */
const TONE_TEXT: Record<StatTone, string> = {
  default: 'text-t1',
  good: 'text-ok',
  warn: 'text-warn',
  bad: 'text-crit',
}

const TONE_ICON: Record<StatTone, string> = {
  default: 'text-muted-foreground',
  good: 'text-ok',
  warn: 'text-warn',
  bad: 'text-crit',
}

/** Tiny inline sparkline: area + stroke + last-point dot, zero deps. */
export function Sparkline({
  data,
  width = 72,
  height = 24,
  className,
}: {
  data: readonly number[]
  width?: number
  height?: number
  className?: string
}) {
  const palette = useChartPalette()
  if (data.length < 2) return null
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const step = width / (data.length - 1)
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4)
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`)
  const last = data[data.length - 1]
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn('shrink-0 overflow-visible', className)}
      aria-hidden="true"
      focusable="false"
    >
      <polygon
        points={`0,${height} ${pts.join(' ')} ${width},${height}`}
        fill={palette.teal}
        opacity="0.08"
      />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={palette.teal}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={width} cy={y(last)} r="1.75" fill={palette.teal} />
    </svg>
  )
}

export function StatCard({
  icon: Icon,
  label,
  figure,
  sub,
  tone = 'default',
  delta,
  spark,
  sparkAlt,
  explain,
  right,
  className,
}: {
  icon: LucideIcon
  label: string
  /** The big figure — usually MoneyValue or a tabular string. */
  figure: React.ReactNode
  sub?: React.ReactNode
  tone?: StatTone
  delta?: StatDelta
  /** Last N samples of the metric; rendered as a mini area line. */
  spark?: readonly number[]
  /** Accessible name for the sparkline when present. */
  sparkAlt?: string
  /** Renders the "how is this calculated?" popover (FormulaPopover). */
  explain?: StatExplain
  right?: React.ReactNode
  className?: string
}) {
  const dt = delta ? deltaTone(delta) : null
  return (
    <Card
      className={cn(
        'sentinel-card-highlight group gap-2 rounded-[6px] border-line bg-card p-3.5 shadow-none sm:p-4',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="flex items-center gap-1.5">
          {explain ? <FormulaPopover formula={explain.formula} inputs={explain.inputs} evidence={explain.evidence} /> : null}
          <Icon className={cn('size-4 shrink-0', TONE_ICON[tone])} aria-hidden="true" />
        </span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className={cn('truncate text-lg font-semibold tracking-tight tabular-nums sm:text-xl', TONE_TEXT[tone])}>
            {figure}
          </div>
          {sub ? <div className="mt-1 truncate text-[11px] text-muted-foreground">{sub}</div> : null}
        </div>
        {right}
      </div>
      {delta || (spark && spark.length >= 2) ? (
        <div className="flex items-center justify-between gap-2">
          {delta ? (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums',
                dt === 'good' && 'text-ok',
                dt === 'bad' && 'text-crit',
                dt === 'flat' && 'text-t3',
              )}
              aria-label={delta.ariaLabel}
            >
              {dt !== 'flat' ? (
                delta.value > 0 ? (
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                ) : (
                  <ArrowDownRight className="size-3" aria-hidden="true" />
                )
              ) : null}
              {deltaLabel(delta)}
            </span>
          ) : (
            <span />
          )}
          {spark && spark.length >= 2 ? <Sparkline data={spark} /> : null}
        </div>
      ) : null}
    </Card>
  )
}

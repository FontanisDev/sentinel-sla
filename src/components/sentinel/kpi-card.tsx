'use client'

// Sentinel-SLA — KpiCard.
//
// the binding stat tile is StatCard (§6.4 — delta arrow AND sign,
// optional sparkline, optional "how is this calculated?" popover). KpiCard
// is the historical name kept as a thin delegate so every existing tile
// inherits StatCard behaviour; new pages call StatCard directly.

import { StatCard, type StatExplain, type StatTone } from './stat-card'
import { useChartPalette } from './palette'
import type { LucideIcon } from 'lucide-react'

export type KpiTone = StatTone

export function KpiCard({
  icon,
  label,
  value,
  sub,
  tone = 'default',
  right,
  className,
}: {
  icon: LucideIcon
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: KpiTone
  right?: React.ReactNode
  className?: string
}) {
  return (
    <StatCard
      icon={icon}
      label={label}
      figure={value}
      sub={sub}
      tone={tone}
      right={right}
      className={className}
    />
  )
}

export type { StatExplain }

/**
 * Numeric value display (the framer-motion count-up is gone — the
 * design system mandates minimal motion; values update in place with tabular
 * figures and no bounce).
 */
export function AnimatedValue({
  value,
  format,
}: {
  value: number | null | undefined
  format?: (n: number) => string
}) {
  const target = value ?? 0
  const display = Number.isFinite(target) ? (format ? format(target) : Math.round(target).toLocaleString('en-US')) : '—'
  return <span className="tabular-nums">{display}</span>
}

/** Small conic SVG progress ring used for SLA compliance. */
export function ComplianceRing({ ratio }: { ratio: number }) {
  const palette = useChartPalette()
  const r = 16
  const c = 2 * Math.PI * r
  const clamped = Math.min(1, Math.max(0, ratio))
  const color = clamped >= 1 ? palette.up : clamped >= 0.8 ? palette.degraded : palette.down
  return (
    <svg viewBox="0 0 40 40" className="size-10 shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="20" cy="20" r={r} fill="none" stroke={palette.ringTrack} strokeWidth="3.5" />
      <circle
        cx="20"
        cy="20"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - clamped)}
        className="transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  )
}

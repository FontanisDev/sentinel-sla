import type { TranslationKey } from '@/lib/i18n'
import { chartPalette } from './palette'
import type {
  AlertAudience,
  ChaosStatus,
  ChaosType,
  IncidentSeverity,
  IncidentSource,
  IncidentStatus,
  ServiceStatus,
} from '@/lib/types'

export interface ServiceStatusStyle {
  /** translation key — render with t(label) */
  label: TranslationKey
  dot: string
  text: string
  chip: string
  bar: string
  stroke: string
}

export const SERVICE_STATUS: Record<ServiceStatus, ServiceStatusStyle> = {
  up: {
    label: 'status.up',
    dot: 'bg-ok',
    text: 'text-ok',
    chip: 'border-ok/25 bg-ok-subtle text-ok',
    bar: 'bg-ok',
    stroke: '#34d399',
  },
  degraded: {
    label: 'status.degraded',
    dot: 'bg-warn',
    text: 'text-warn',
    chip: 'border-warn/25 bg-warn-subtle text-warn',
    bar: 'bg-warn',
    stroke: '#fbbf24',
  },
  down: {
    label: 'status.down',
    dot: 'bg-crit',
    text: 'text-crit',
    chip: 'border-crit/25 bg-crit-subtle text-crit',
    bar: 'bg-crit',
    stroke: '#fb7185',
  },
}

/**
 * Status style map. `dark` selects the chart stroke shade for the active
 * theme (class utilities carry their own dark: variants; SVG strokes cannot).
 */
export function serviceStatus(status: ServiceStatus, dark = true): ServiceStatusStyle {
  const p = chartPalette(dark)
  const stroke = status === 'down' ? p.down : status === 'degraded' ? p.degraded : p.up
  return { ...SERVICE_STATUS[status], stroke }
}

export const SEVERITY: Record<IncidentSeverity, { label: TranslationKey; chip: string }> = {
  critical: { label: 'severity.critical', chip: 'border-crit/25 bg-crit-subtle text-crit' },
  warning: { label: 'severity.warning', chip: 'border-warn/25 bg-warn-subtle text-warn' },
}

export const INCIDENT_STATUS: Record<IncidentStatus, { label: TranslationKey; chip: string }> = {
  ongoing: { label: 'istatus.ongoing', chip: 'border-crit/25 bg-crit-subtle text-crit' },
  resolved: { label: 'istatus.resolved', chip: 'border-ok/25 bg-ok-subtle text-ok' },
}

export const INCIDENT_SOURCE: Record<IncidentSource, { label: TranslationKey; chip: string }> = {
  spontaneous: { label: 'isource.spontaneous', chip: 'border-line bg-raised text-muted-foreground' },
  chaos: { label: 'isource.chaos', chip: 'border-warn/25 bg-warn-subtle text-warn' },
  manual: { label: 'isource.manual', chip: 'border-line bg-raised text-muted-foreground' },
}

export const CHAOS_STATUS: Record<ChaosStatus, { label: TranslationKey; chip: string; pulse?: boolean }> = {
  running: { label: 'cstatus.running', chip: 'border-warn/25 bg-warn-subtle text-warn', pulse: true },
  passed: { label: 'cstatus.passed', chip: 'border-ok/25 bg-ok-subtle text-ok' },
  failed: { label: 'cstatus.failed', chip: 'border-crit/25 bg-crit-subtle text-crit' },
  aborted: { label: 'cstatus.aborted', chip: 'border-line bg-raised text-muted-foreground' },
}

export const CHAOS_TYPE_LABEL: Record<ChaosType, TranslationKey> = {
  outage: 'ctype.outage',
  latency: 'ctype.latency',
  'error-spike': 'ctype.error-spike',
}

export const AUDIENCE: Record<AlertAudience, { label: TranslationKey; chip: string }> = {
  technical: { label: 'audience.technical', chip: 'border-info/25 bg-info-subtle text-info' },
  executive: { label: 'audience.executive', chip: 'border-warn/25 bg-warn-subtle text-warn' },
}

/** Chart stroke per service — greens/teals for healthy, amber for degraded, rose for down. */
export function serviceStroke(status: ServiceStatus, index: number, dark = true): string {
  const p = chartPalette(dark)
  if (status === 'down') return p.down
  if (status === 'degraded') return p.degraded
  return p.upStrokes[index % p.upStrokes.length]
}

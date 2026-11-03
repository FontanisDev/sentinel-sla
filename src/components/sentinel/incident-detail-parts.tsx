'use client'

// Shared incident-detail building blocks (design system §5 /incidents/[id]).
// Extracted from incident-detail-dialog so the DIALOG and the full-page
// /incidents/[id] route render the SAME stats, timeline, post-mortem and
// ack/resolve panels — one source of truth, no drift (refactor, do not pile
// on). The dialog supplies the chrome; this file owns the content.

import { useState } from 'react'
import {
  BellRing,
  FileCog,
  Loader2,
  Sparkles,
  TriangleAlert,
  UserCheck,
  Wrench,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import {
  billedMinutes,
  formatClock,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatNumberLocale,
} from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import type { IncidentDTO, IncidentEventDTO } from '@/lib/types'
import type { TranslationKey } from '@/lib/i18n'
import {
  extractPostMortemSummary,
  useAcknowledgeIncident,
  usePostMortem,
  useResolveIncident,
} from '@/hooks/use-sentinel'
import { INCIDENT_SOURCE, INCIDENT_STATUS, SEVERITY } from './status'
import { MoneyValue } from './money-value'
import { FormulaPopover } from './formula-popover'

export function IncidentStat({
  label,
  value,
  tone,
}: {
  label: string
  value: React.ReactNode
  tone?: string
}) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <p className="text-[10px] font-medium tracking-wider text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-sm font-semibold tabular-nums', tone ?? 'text-foreground')}>{value}</p>
    </div>
  )
}

/** Map an engine timeline event name to a translation key. */
const EVENT_KEYS: Record<string, TranslationKey> = {
  fault_started: 'event.fault_started',
  probe_failed: 'event.probe_failed',
  detected: 'event.detected',
  resolved: 'event.resolved',
  acknowledged: 'event.acknowledged',
  escalated: 'timeline.escalated',
}

const EVENT_DOT: Record<string, string> = {
  fault_started: 'bg-crit',
  probe_failed: 'bg-warn',
  detected: 'bg-info',
  resolved: 'bg-ok',
  acknowledged: 'bg-chart-5',
  escalated: 'bg-warn',
}

/** Forensic timeline rendered from the incident's `events` JSON (v2 contract). */
export function IncidentTimeline({ events }: { events: IncidentEventDTO[] }) {
  const { t } = useLang()

  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('timeline.empty')}</p>
  }

  return (
    <ol className="relative space-y-3 border-s border-black/[0.08] dark:border-white/[0.08] ps-4" aria-label={t('timeline.title')}>
      {events.map((ev, i) => {
        const key = EVENT_KEYS[ev.event]
        const dot = EVENT_DOT[ev.event] ?? 'bg-muted-foreground'
        return (
          <li key={`${ev.ts}-${i}`} className="relative">
            <span
              className={cn(
                'absolute -start-[21px] top-1 size-2 rounded-full ring-4 ring-card',
                dot
              )}
              aria-hidden="true"
            />
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="text-xs font-medium text-foreground">
                {key ? t(key) : t('event.unknown', { v: ev.event })}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground" dir="ltr">
                {formatClock(ev.ts)}
              </span>
            </div>
            {ev.detail ? (
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{ev.detail}</p>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * §6.7 penalty figure + its formula popover — only for resolved incidents
 * with a money model (an ongoing incident has no penalty yet — the
 * truthful-numbers rule).
 */
export function IncidentPenaltyStat({ incident }: { incident: IncidentDTO }) {
  const { t, lang } = useLang()
  const mm = incident.moneyModel
  const minutes = billedMinutes(incident.durationSec)
  const resolved = incident.status === 'resolved'
  return (
    <span className="inline-flex items-center gap-0.5">
      <MoneyValue tomans={incident.penaltyTomans} tone={incident.penaltyTomans > 0 ? 'warn' : 'default'} />
      {mm && resolved && minutes !== null ? (
        <FormulaPopover
          formula={t('formula.penalty')}
          inputs={[
            { label: t('formula.input.base'), value: formatNumberLocale(mm.penaltyBase, lang) },
            { label: t('formula.input.perMin'), value: formatNumberLocale(mm.penaltyPerMinute, lang) },
            { label: t('formula.input.minutes'), value: formatNumberLocale(minutes, lang) },
            {
              label: t('formula.input.weight', { pct: incident.severity === 'warning' ? 30 : 100 }),
              value: `× ${incident.severity === 'warning' ? 30 : 100}%`,
            },
          ]}
          evidence={[
            { label: t('formula.evidence.moneyModel'), href: '/settings/services' },
            { label: t('formula.evidence.domainDoc') },
          ]}
        />
      ) : null}
    </span>
  )
}

/** The shared stat grid: detection/ack/recovery times + the money figures. */
export function IncidentStatGrid({ incident }: { incident: IncidentDTO }) {
  const { t, lang } = useLang()
  const ongoing = incident.status === 'ongoing'
  const acked = incident.acknowledgedAt !== null
  const escalated = incident.escalatedAt !== null

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <IncidentStat label={t('dlg.detected')} value={formatDuration(incident.mttdSec)} tone="text-info" />
      <IncidentStat
        label={t('dlg.acknowledged')}
        value={
          acked ? (
            <span title={incident.acknowledgedBy ?? undefined}>
              {formatDuration(incident.mttaSec)}
            </span>
          ) : (
            '—'
          )
        }
        tone="text-chart-5"
      />
      <IncidentStat label={t('dlg.recovered')} value={formatDuration(incident.mttrSec)} />
      {escalated ? (
        <IncidentStat
          label={t('inc.escStat')}
          value={
            <span className="text-[11px]" title={incident.escalatedTo ?? undefined}>
              {incident.escalatedTo}
            </span>
          }
          tone="text-warn"
        />
      ) : null}
      <IncidentStat label={t('dlg.duration')} value={ongoing ? t('itable.ongoing') : formatDuration(incident.durationSec)} />
      <IncidentStat label={t('dlg.lostTx')} value={formatNumber(incident.lostTransactions)} />
      <IncidentStat
        label={t('dlg.revenueLoss')}
        value={
          <span className="inline-flex items-center gap-0.5">
            <MoneyValue tomans={incident.revenueLossTomans} tone="crit" />
            {incident.moneyModel ? (
              <FormulaPopover
                formula={t('formula.revenueLoss')}
                inputs={[
                  {
                    label: t('formula.input.lostTx'),
                    value: formatNumberLocale(incident.lostTransactions, lang),
                  },
                  {
                    label: t('formula.input.ticket'),
                    value: formatNumberLocale(incident.moneyModel.avgTransactionValue, lang),
                  },
                ]}
                evidence={[
                  { label: t('formula.evidence.moneyModel'), href: '/settings/services' },
                  { label: t('formula.evidence.domainDoc') },
                ]}
              />
            ) : null}
          </span>
        }
        tone="text-crit"
      />
      <IncidentStat
        label={t('dlg.slaPenalty')}
        value={<IncidentPenaltyStat incident={incident} />}
        tone="text-warn"
      />
    </div>
  )
}

/** v2.6 escalation banner — the ladder fired on this incident. */
export function IncidentEscalationBanner({ incident }: { incident: IncidentDTO }) {
  const { t } = useLang()
  const escalated = incident.escalatedAt !== null
  if (!escalated) return null
  return (
    <p
      className="flex flex-wrap items-center gap-1.5 rounded-[6px] bg-warn/[0.07] px-3 py-2.5 text-xs text-warn"
      dir="auto"
    >
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        {t('inc.escBanner', {
          who: incident.escalatedTo ?? t('esc.nobody'),
          t: formatDuration(
            incident.escalatedAt && incident.detectedAt
              ? (new Date(incident.escalatedAt).getTime() - new Date(incident.detectedAt).getTime()) / 1000
              : null,
          ),
        })}
      </span>
    </p>
  )
}

/**
 * Post-mortem panel (rule-based fallback is honestly labeled). Owns the
 * summary state — mount keyed by incident id so per-incident state resets.
 */
export function IncidentPostMortemPanel({ incident }: { incident: IncidentDTO }) {
  const postMortem = usePostMortem()
  const { t } = useLang()
  const [summary, setSummary] = useState<string | null>(incident.aiSummary)
  const [summarySource, setSummarySource] = useState<IncidentDTO['aiSource']>(incident.aiSource)

  const heuristic = summarySource === 'heuristic'

  const handlePostMortem = async () => {
    try {
      const res = await postMortem.mutateAsync({ incidentId: incident.id })
      const s = extractPostMortemSummary(res)
      if (s) setSummary(s)
      const src = (res as { source?: IncidentDTO['aiSource'] }).source
      if (src) setSummarySource(src)
    } catch {
      // toast already surfaced by the mutation hook
    }
  }

  return (
    <>
      {summary ? (
        <div className="rounded-lg border-s-2 border-ok/30 bg-ok/[0.04] px-3 py-3">
          <p className="flex flex-wrap items-center gap-1.5 text-[10px] font-medium tracking-wider text-ok">
            {heuristic ? (
              <FileCog className="size-3" aria-hidden="true" />
            ) : (
              <Sparkles className="size-3" aria-hidden="true" />
            )}
            {t(heuristic ? 'inc.rulePostMortem' : 'inc.aiPostMortem')}
            {heuristic ? (
              <Badge variant="outline" className="h-4 border-warn/25 px-1.5 text-[9px] text-warn">
                {t('inc.postMortemOffline')}
              </Badge>
            ) : null}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-foreground/80">{summary}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 h-8 gap-1.5 text-xs"
            onClick={handlePostMortem}
            disabled={postMortem.isPending}
          >
            {postMortem.isPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-3.5" aria-hidden="true" />
            )}
            {t('dlg.regenerate')}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          className="h-11 gap-1.5"
          onClick={handlePostMortem}
          disabled={postMortem.isPending}
        >
          {postMortem.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="size-4" aria-hidden="true" />
          )}
          {t('dlg.genPostMortem')}
        </Button>
      )}
    </>
  )
}

/**
 * Ack (v2.5 on-call ownership) + resolve actions for an ONGOING incident.
 * The API enforces the engineer floor; the panel hides itself for viewers so
 * they never see controls their role cannot use.
 */
export function IncidentAckResolvePanel({
  incident,
  canOperate,
}: {
  incident: IncidentDTO
  /** false for viewer roles — the controls would 403 (RBAC parity) */
  canOperate: boolean
}) {
  const ack = useAcknowledgeIncident()
  const resolve = useResolveIncident()
  const { t } = useLang()
  const [ackHandle, setAckHandle] = useState('')

  const ongoing = incident.status === 'ongoing'
  const acked = incident.acknowledgedAt !== null
  const ackInvalid = ackHandle.trim().length > 0 && ackHandle.trim().length < 2

  if (!ongoing || !canOperate) return null

  return (
    <div className="flex flex-col gap-3">
      {!acked ? (
        <div className="flex flex-col gap-2 rounded-[6px] border border-chart-5/20 bg-chart-5/[0.05] p-3">
          <label htmlFor="incident-ack-handle" className="text-xs font-medium text-foreground">
            {t('ack.dialog.label')}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="incident-ack-handle"
              dir="ltr"
              value={ackHandle}
              onChange={(e) => setAckHandle(e.target.value)}
              placeholder={t('ack.dialog.placeholder')}
              maxLength={40}
              autoComplete="off"
              className="h-9 flex-1 font-mono text-sm"
            />
            {/* contrast audit: chart-5 as TEXT on its own tint was 4.15:1 in light —
                the tint+border keep the categorical accent, the label reads foreground */}
            <Button
              variant="outline"
              className="h-9 shrink-0 gap-1.5 border-chart-5/30 bg-chart-5/10 text-foreground hover:bg-chart-5/20"
              onClick={() => ack.mutate({ incidentId: incident.id, by: ackHandle })}
              disabled={ack.isPending || ackInvalid}
            >
              {ack.isPending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <UserCheck className="size-3.5" aria-hidden="true" />
              )}
              {t('ack.dialog.confirm')}
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t('ack.dialog.hint')}</p>
        </div>
      ) : (
        <p
          className="flex items-center gap-1.5 rounded-[6px] bg-chart-5/[0.06] px-3 py-2.5 text-xs text-chart-5"
          dir="auto"
        >
          <BellRing className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {t('ack.toast.done')} — <span dir="ltr" className="font-mono">{incident.acknowledgedBy}</span>
          </span>
        </p>
      )}
      <div className="flex justify-end">
        <Button
          className="h-11 gap-1.5"
          onClick={() => resolve.mutate(incident.id)}
          disabled={resolve.isPending}
        >
          {resolve.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Wrench className="size-4" aria-hidden="true" />
          )}
          {t('dlg.resolveOnCall')}
        </Button>
      </div>
    </div>
  )
}

/** Status + severity badge row (same chips in the dialog header and the page). */
export function IncidentBadges({ incident }: { incident: IncidentDTO }) {
  const { t } = useLang()
  const sev = SEVERITY[incident.severity]
  const st = INCIDENT_STATUS[incident.status]
  const ongoing = incident.status === 'ongoing'
  return (
    <>
      <Badge variant="outline" className={cn('text-[10px]', sev.chip)}>
        {t(sev.label)}
      </Badge>
      <Badge variant="outline" className={cn('gap-1 text-[10px]', st.chip)}>
        {ongoing ? (
          <span className="size-1.5 animate-status-pulse rounded-full bg-crit" aria-hidden="true" />
        ) : null}
        {t(st.label)}
      </Badge>
    </>
  )
}

/** "Source, started <date>" line — identical wording in dialog and page. */
export function IncidentSourceLine({ incident }: { incident: IncidentDTO }) {
  const { t } = useLang()
  return t('dlg.source', {
    source: t(INCIDENT_SOURCE[incident.source].label),
    t: formatDateTime(incident.startedAt),
  })
}

/** Shared divider tone for both surfaces. */
export function IncidentDivider() {
  return <Separator className="bg-black/[0.06] dark:bg-white/[0.06]" />
}

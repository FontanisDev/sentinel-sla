'use client'

import { History, Loader2, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  billedMinutes,
  formatClock,
  formatDurationLocale,
  formatNumber,
  formatNumberLocale,
} from '@/lib/format'
import type { IncidentDTO } from '@/lib/types'
import { usePostMortem } from '@/hooks/use-sentinel'
import { useLang } from '@/hooks/use-language'
import { INCIDENT_STATUS, SEVERITY } from './status'
import { EmptyState } from './empty-state'
import { MoneyValue } from './money-value'
import { FormulaPopover } from './formula-popover'

export function IncidentList({
  incidents,
  onIncidentSelect,
}: {
  incidents: IncidentDTO[]
  onIncidentSelect: (incident: IncidentDTO) => void
}) {
  const postMortem = usePostMortem()
  const { t, name, lang } = useLang()
  const pendingId = postMortem.isPending ? postMortem.variables?.incidentId : undefined

  // §6.7: penalty popover only for resolved incidents with a money model —
  // an ongoing incident has no penalty yet (truthful-numbers rule).
  const penaltyPopover = (incident: IncidentDTO) => {
    const mm = incident.moneyModel
    const minutes = billedMinutes(incident.durationSec)
    if (!mm || incident.status !== 'resolved' || minutes === null) return null
    const weightPct = incident.severity === 'warning' ? 30 : 100
    return (
      <FormulaPopover
        formula={t('formula.penalty')}
        inputs={[
          { label: t('formula.input.base'), value: formatNumberLocale(mm.penaltyBase, lang) },
          { label: t('formula.input.perMin'), value: formatNumberLocale(mm.penaltyPerMinute, lang) },
          { label: t('formula.input.minutes'), value: formatNumberLocale(minutes, lang) },
          { label: t('formula.input.weight', { pct: weightPct }), value: `× ${weightPct}%` },
        ]}
        evidence={[
          { label: t('formula.evidence.moneyModel'), href: '/settings/services' },
          { label: t('formula.evidence.domainDoc') },
        ]}
      />
    )
  }

  if (incidents.length === 0) {
    return (
      <EmptyState
        icon={History}
        title={t('inc.empty.title')}
        description={t('inc.empty.desc')}
        className="py-8"
      />
    )
  }

  return (
    <ul className="grid gap-3 lg:grid-cols-2" aria-label={t('inc.aria')}>
      {incidents.map((incident) => {
        const sev = SEVERITY[incident.severity]
        const st = INCIDENT_STATUS[incident.status]
        const elapsedSec =
          incident.status === 'ongoing'
            ? Math.max(0, (Date.now() - new Date(incident.startedAt).getTime()) / 1000)
            : null
        const downtime = elapsedSec ?? incident.durationSec
        const isPendingPostMortem = pendingId === incident.id

        return (
          <li key={incident.id}>
            <article className="sentinel-card-highlight h-full rounded-[6px] border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="outline" className={cn('text-[10px]', sev.chip)}>
                    {t(sev.label)}
                  </Badge>
                  <span className="truncate text-sm font-medium text-foreground">
                    {name(incident.serviceName, null)}
                  </span>
                  <Badge variant="outline" className={cn('text-[10px]', st.chip)}>
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        incident.status === 'ongoing' ? 'animate-status-pulse bg-crit' : 'bg-ok'
                      )}
                      aria-hidden="true"
                    />
                    {t(st.label)}
                  </Badge>
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {formatClock(incident.startedAt)}
                </span>
              </div>

              <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
                {incident.status === 'ongoing' && elapsedSec !== null ? (
                  <span className="font-medium text-crit">{t('inc.downSoFar', { dur: formatDurationLocale(elapsedSec, lang) })}</span>
                ) : downtime !== null && downtime !== undefined ? (
                  <span>
                    {t('inc.down', { dur: formatDurationLocale(downtime, lang) })}
                  </span>
                ) : null}
                {' · '}
                {t('inc.txLost', { n: formatNumber(incident.lostTransactions) })} ·{' '}
                <span className="inline-flex items-baseline gap-0.5 align-baseline">
                  {t('inc.penaltyWord')}{' '}
                  <MoneyValue tomans={incident.penaltyTomans} />
                  {penaltyPopover(incident)}
                </span>{' '}
                ·{' '}
                {t('inc.detectedIn', { v: formatDurationLocale(incident.mttdSec, lang) })}
              </p>

              {incident.aiSummary ? (
                <div className="mt-3 rounded-md border-l-2 border-ok/30 bg-ok/[0.04] bg-ok/[0.04] px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-ok">
                    <Sparkles className="size-3" aria-hidden="true" />
                    {t('inc.aiPostMortem')}
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-foreground/80">{incident.aiSummary}</p>
                </div>
              ) : null}

              <div className="mt-3 flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  onClick={() => postMortem.mutate({ incidentId: incident.id })}
                  disabled={postMortem.isPending}
                >
                  {isPendingPostMortem ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Sparkles className="size-3.5" aria-hidden="true" />
                  )}
                  {incident.aiSummary ? t('inc.regenerate') : t('inc.aiButton')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-muted-foreground"
                  onClick={() => onIncidentSelect(incident)}
                >
                  {t('inc.details')}
                </Button>
              </div>
            </article>
          </li>
        )
      })}
    </ul>
  )
}

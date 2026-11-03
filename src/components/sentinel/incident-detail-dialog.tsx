'use client'

// Incident detail DIALOG (row-level quick view). The heavy content — stat
// grid with money popovers, forensic timeline, post-mortem, ack/resolve —
// lives in incident-detail-parts.tsx, shared 1:1 with the full-page
// /incidents/[id] route (design system §5) so the two surfaces never drift.

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import Link from 'next/link'
import { ArrowUpRight, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
} from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import type { IncidentDTO, ServiceDTO } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  IncidentAckResolvePanel,
  IncidentBadges,
  IncidentDivider,
  IncidentEscalationBanner,
  IncidentPostMortemPanel,
  IncidentSourceLine,
  IncidentStat,
  IncidentStatGrid,
  IncidentTimeline,
} from './incident-detail-parts'
import { INCIDENT_STATUS, SEVERITY, serviceStatus } from './status'
import { EmptyState } from './empty-state'
import { MoneyValue } from './money-value'

export function IncidentDetailDialog({
  incident,
  onClose,
}: {
  incident: IncidentDTO | null
  onClose: () => void
}) {
  if (!incident) return null

  return (
    <Dialog open={!!incident} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-black/[0.08] dark:border-white/[0.08] bg-card sm:max-w-lg">
        {/* Keyed by incident id so per-incident state resets naturally. */}
        <IncidentDetailContent key={incident.id} incident={incident} />
      </DialogContent>
    </Dialog>
  )
}

function IncidentDetailContent({ incident }: { incident: IncidentDTO }) {
  const { t, name } = useLang()

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          {t('dlg.incidentTitle', { service: name(incident.serviceName, null) })}
          <IncidentBadges incident={incident} />
        </DialogTitle>
        <DialogDescription>
          <IncidentSourceLine incident={incident} />
        </DialogDescription>
      </DialogHeader>

      <IncidentStatGrid incident={incident} />

      <IncidentDivider />

      <IncidentEscalationBanner incident={incident} />

      {/* Forensic timeline (v2: incident.events) */}
      <div>
        <p className="mb-2.5 text-[10px] font-medium tracking-wider text-muted-foreground">
          {t('timeline.title')}
        </p>
        <IncidentTimeline events={incident.events} />
      </div>

      <IncidentDivider />

      <IncidentPostMortemPanel incident={incident} />

      {incident.status === 'ongoing' ? (
        <DialogFooter className="flex-col gap-3 sm:flex-col sm:items-stretch">
          <IncidentAckResolvePanel incident={incident} canOperate />
        </DialogFooter>
      ) : null}

      {/* The dialog is the quick view; the detail route is the full record. */}
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-t2" asChild>
          <Link
            href={`/incidents/${incident.id}`}
            aria-label={t('incd.openFullPageAria', { id: incident.id.slice(0, 8) })}
          >
            {t('incd.openFullPage')}
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </>
  )
}

/** Per-service incident list shown from the service registry / home health
 *  cards — row click hands the incident up to the detail dialog. */
export function ServiceIncidentsDialog({
  service,
  incidents,
  onClose,
  onIncidentSelect,
}: {
  service: ServiceDTO | null
  incidents: IncidentDTO[]
  onClose: () => void
  onIncidentSelect: (incident: IncidentDTO) => void
}) {
  const { t, name } = useLang()
  if (!service) return null
  const st = serviceStatus(service.status)

  return (
    <Dialog open={!!service} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-black/[0.08] dark:border-white/[0.08] bg-card sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span className={cn('size-2.5 rounded-full', st.dot)} aria-hidden="true" />
            {name(service.name, service.nameFa)}
            {name(service.name, service.nameFa) !== service.name ? (
              <span className="text-xs font-normal text-muted-foreground" lang="en" dir="ltr">
                {service.name}
              </span>
            ) : service.nameFa ? (
              <span className="text-xs font-normal text-muted-foreground" lang="fa" dir="rtl">
                {service.nameFa}
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription dir="ltr">{t('dlg.serviceDesc', { endpoint: service.endpoint, tier: service.tier, crit: service.criticality })}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <IncidentStat
            label={t('dlg.uptime')}
            value={formatPercent(service.uptime)}
            tone={service.uptime >= service.slaTarget ? 'text-ok' : 'text-crit'}
          />
          <IncidentStat label={t('dlg.slaTarget')} value={formatPercent(service.slaTarget, 2)} />
          <IncidentStat label={t('dlg.latency')} value={`${Math.round(service.latencyMs)} ms`} />
          <IncidentStat label={t('dlg.errorRate')} value={`${(service.errorRate * 100).toFixed(2)}%`} />
          <IncidentStat label={t('dlg.throughput')} value={`${Math.round(service.throughput)} tx/s`} />
          <IncidentStat label={t('dlg.penaltyBase')} value={<MoneyValue tomans={service.penaltyBase} />} tone="text-warn" />
        </div>

        <IncidentDivider />

        <div>
          <p className="text-[10px] font-medium tracking-wider text-muted-foreground">
            {t('dlg.incidents', { n: incidents.length })}
          </p>
          {incidents.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={t('dlg.clean.title')}
              description={t('dlg.clean.desc')}
              className="mt-2 py-5"
            />
          ) : (
            <ul className="mt-2 space-y-2" aria-label={t('dlg.serviceIncidents', { name: name(service.name, service.nameFa) })}>
              {incidents.map((inc) => {
                const sev = SEVERITY[inc.severity]
                return (
                  <li key={inc.id}>
                    <button
                      type="button"
                      className="w-full rounded-lg border bg-surface-1 px-3 py-2.5 text-start outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/50"
                      onClick={() => onIncidentSelect(inc)}
                      aria-label={t('dlg.openIncident', { id: inc.id.slice(0, 8) })}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <Badge variant="outline" className={cn('text-[10px]', sev.chip)}>
                            {t(sev.label)}
                          </Badge>
                          <Badge variant="outline" className={cn('text-[10px]', INCIDENT_STATUS[inc.status].chip)}>
                            {t(INCIDENT_STATUS[inc.status].label)}
                          </Badge>
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {formatDateTime(inc.startedAt)}
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        {formatDuration(inc.durationSec ?? undefined)} ·{' '}
                        {t('dlg.lostTxShort', { n: formatNumber(inc.lostTransactions) })} ·{' '}
                        {/* inside a <button> — no popover here (nested interactive
                            elements are an a11y violation); the detail view the
                            button opens carries the full formula popover */}
                        <span className="inline-flex items-baseline gap-0.5 align-baseline">
                          {t('inc.penaltyWord')}
                          <MoneyValue tomans={inc.penaltyTomans} />
                        </span>
                      </p>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* The dialog is the quick view; the detail route is the full record. */}
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-t2" asChild>
            <Link
              href={`/services/${encodeURIComponent(service.key)}`}
              aria-label={t('svcd.openFullPageAria', { key: service.key })}
            >
              {t('incd.openFullPage')}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

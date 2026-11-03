'use client'

// Sentinel-SLA — incident register on the shared DataTable (design system §6.3).
// v2.5: ACKNOWLEDGE (on-call ownership) before resolution.
// v2.6: escalation chips + honest "escalates in" countdown.
// v2.7: rebuilt on DataTable — sort / search / column visibility / density /
//       pagination / CSV; money figures use MoneyValue + FormulaPopover with
//       the REAL inputs (lost tx × avg tx value; (base + per-minute × minutes)
//       × severity weight — the exact engine formulas).

import { useState } from 'react'
import {
  BellRing,
  Check,
  Loader2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UserCheck,
  Wrench,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DataTable, type DataTableColumn } from './data-table'
import { DateText } from './date-text'
import { MoneyWithFormula } from './formula-popover'
import { MoneyValue } from './money-value'
import { EmptyState } from './empty-state'
import { cn } from '@/lib/utils'
import {
  billedMinutes,
  formatDuration,
  formatDurationLocale,
  formatNumberLocale,
} from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import type { EscalationPolicyDTO, IncidentDTO, OnCallEntryDTO } from '@/lib/types'
import { useAcknowledgeIncident, usePostMortem, useResolveIncident } from '@/hooks/use-sentinel'
import { INCIDENT_SOURCE, INCIDENT_STATUS, SEVERITY } from './status'

/** v2.5: prefill suggestion — the active primary on-call, else any active entry. */
function suggestAckHandle(onCall: OnCallEntryDTO[]): string {
  const active = onCall.filter((e) => e.active)
  const primary = active.find((e) => /primary|اصلی/i.test(e.role)) ?? active[0]
  return primary?.engineerName ?? ''
}

/** v2.6: seconds until the ladder fires on this incident (null = not applicable). */
function secondsToEscalation(inc: IncidentDTO, timeoutMin: number | undefined): number | null {
  if (!timeoutMin || !inc.detectedAt || inc.acknowledgedAt || inc.escalatedAt) return null
  const dueMs = new Date(inc.detectedAt).getTime() + timeoutMin * 60_000
  const left = Math.round((dueMs - Date.now()) / 1000)
  return left > 0 ? left : 0
}

/** v2.6: ladder armed for this incident right now (drives row accent). */
function escalationArmed(inc: IncidentDTO, policy: EscalationPolicyDTO | undefined): boolean {
  return (
    !!policy?.enabled &&
    inc.status === 'ongoing' &&
    inc.detectedAt !== null &&
    inc.acknowledgedAt === null &&
    inc.escalatedAt === null
  )
}

export function IncidentTable({
  incidents,
  onIncidentSelect,
  onCall = [],
  escalationPolicy,
  initialQuery,
}: {
  incidents: IncidentDTO[]
  onIncidentSelect: (incident: IncidentDTO) => void
  /** v2.5: live on-call rotation — used to suggest the ack handle */
  onCall?: OnCallEntryDTO[]
  /** v2.6: fleet escalation policy — powers the "escalates in" countdown */
  escalationPolicy?: EscalationPolicyDTO
  /** Pre-fills the table search (deep links from the CommandPalette). */
  initialQuery?: string
}) {
  const resolve = useResolveIncident()
  const ack = useAcknowledgeIncident()
  const postMortem = usePostMortem()
  const { t, lang, name } = useLang()
  const [ackTarget, setAckTarget] = useState<IncidentDTO | null>(null)
  const [ackHandle, setAckHandle] = useState('')
  const pendingPostMortemId = postMortem.isPending ? postMortem.variables?.incidentId : undefined
  const pendingResolveId = resolve.isPending ? resolve.variables : undefined
  const pendingAckId = ack.isPending ? ack.variables?.incidentId : undefined

  const openAckDialog = (inc: IncidentDTO) => {
    setAckTarget(inc)
    setAckHandle(suggestAckHandle(onCall))
  }

  const confirmAck = () => {
    if (!ackTarget) return
    ack.mutate(
      { incidentId: ackTarget.id, by: ackHandle },
      { onSuccess: () => setAckTarget(null) },
    )
  }

  // Columns are rebuilt per render — the React Compiler memoizes what it
  // can, and mutation/pending state changes identity every render anyway.
  const columns: Array<DataTableColumn<IncidentDTO>> = [
    {
        id: 'id',
        header: t('itable.id'),
        accessor: (inc) => inc.id,
        sticky: true,
        locked: true,
        minWidth: 108,
        csv: (inc) => inc.id,
        cell: (inc) => (
          <span className="font-mono text-[11px] text-text-3">{inc.id.slice(0, 8)}</span>
        ),
      },
      {
        id: 'service',
        header: t('itable.service'),
        accessor: (inc) => inc.serviceName,
        minWidth: 130,
        cell: (inc) => (
          <span className="text-[12px] font-medium text-text-1">{name(inc.serviceName, null)}</span>
        ),
      },
      {
        id: 'severity',
        header: t('itable.severity'),
        accessor: (inc) => inc.severity,
        cell: (inc) => (
          <Badge variant="outline" className={cn('px-1.5 py-0 text-[10px]', SEVERITY[inc.severity].chip)}>
            {t(SEVERITY[inc.severity].label)}
          </Badge>
        ),
      },
      {
        id: 'source',
        header: t('itable.source'),
        accessor: (inc) => inc.source,
        defaultHidden: true,
        cell: (inc) => (
          <Badge variant="outline" className={cn('px-1.5 py-0 text-[10px]', INCIDENT_SOURCE[inc.source].chip)}>
            {t(INCIDENT_SOURCE[inc.source].label)}
          </Badge>
        ),
      },
      {
        id: 'started',
        header: t('itable.started'),
        accessor: (inc) => inc.startedAt,
        minWidth: 170,
        csv: (inc) => inc.startedAt,
        cell: (inc) => (
          <span className="text-[11px] tabular-nums text-text-2">
            <DateText date={inc.startedAt} withTime />
          </span>
        ),
      },
      {
        id: 'mttd',
        header: t('itable.mttd'),
        accessor: (inc) => inc.mttdSec ?? -1,
        numeric: true,
        align: 'end',
        csv: (inc) => (inc.mttdSec === null ? '' : Math.round(inc.mttdSec)),
        cell: (inc) => (
          <span className="inline-flex items-center justify-end gap-1 tabular-nums">
            {formatDurationLocale(inc.mttdSec, lang)}
            {inc.mttdSec !== null && inc.mttdSec <= 60 ? (
              <Check className="size-3 text-ok" aria-label={t('itable.within60')} />
            ) : inc.mttdSec !== null ? (
              <X className="size-3 text-crit" aria-label={t('itable.outside60')} />
            ) : null}
          </span>
        ),
      },
      {
        id: 'mtta',
        header: t('itable.mtta'),
        accessor: (inc) => inc.mttaSec ?? -1,
        numeric: true,
        align: 'end',
        csv: (inc) => (inc.mttaSec === null ? '' : Math.round(inc.mttaSec)),
        cell: (inc) =>
          inc.acknowledgedAt ? (
            <span
              className="inline-flex items-center justify-end gap-1 tabular-nums text-info"
              title={inc.acknowledgedBy ?? undefined}
            >
              {formatDurationLocale(inc.mttaSec, lang)}
              <UserCheck className="size-3" aria-label={t('itable.acked')} />
            </span>
          ) : (
            <span className="text-text-3 opacity-60">—</span>
          ),
      },
      {
        id: 'mttr',
        header: t('itable.mttr'),
        accessor: (inc) => inc.mttrSec ?? -1,
        numeric: true,
        align: 'end',
        csv: (inc) => (inc.mttrSec === null ? '' : Math.round(inc.mttrSec)),
        cell: (inc) => (
          <span className="tabular-nums">{formatDurationLocale(inc.mttrSec, lang)}</span>
        ),
      },
      {
        id: 'escalation',
        header: t('itable.escCol'),
        align: 'end',
        defaultHidden: true,
        csv: (inc) => (inc.escalatedAt ? 'escalated' : ''),
        cell: (inc) => {
          const armed = escalationArmed(inc, escalationPolicy)
          const secLeft = armed ? secondsToEscalation(inc, escalationPolicy?.timeoutMin) ?? 0 : null
          if (inc.escalatedAt) {
            return (
              <Badge
                variant="outline"
                className="gap-1 border-warn/25 bg-warn-subtle px-1.5 py-0 text-[10px] text-warn"
                title={t('esc.chipAria', { who: inc.escalatedTo ?? '' })}
              >
                <TriangleAlert className="size-2.5" aria-hidden="true" />
                {t('esc.chip')}
              </Badge>
            )
          }
          if (secLeft !== null) {
            return (
              <span
                className={cn(
                  'text-[10px] tabular-nums text-warn',
                  secLeft <= 30 && 'animate-status-pulse font-semibold',
                )}
                dir="ltr"
              >
                {t('esc.in', { t: formatDuration(secLeft) })}
              </span>
            )
          }
          return <span className="text-text-3 opacity-60">—</span>
        },
      },
      {
        id: 'duration',
        header: t('itable.duration'),
        accessor: (inc) => inc.durationSec ?? -1,
        numeric: true,
        align: 'end',
        csv: (inc) => (inc.durationSec === null ? '' : Math.round(inc.durationSec)),
        cell: (inc) =>
          inc.status === 'ongoing' ? (
            <span className="text-warn">{t('itable.ongoing')}</span>
          ) : (
            <span className="tabular-nums">{formatDurationLocale(inc.durationSec, lang)}</span>
          ),
      },
      {
        id: 'lostTx',
        header: t('itable.lostTx'),
        accessor: (inc) => inc.lostTransactions,
        numeric: true,
        align: 'end',
        cell: (inc) => (
          <span className="tabular-nums text-text-2">
            {formatNumberLocale(inc.lostTransactions, lang)}
          </span>
        ),
      },
      {
        id: 'revenue',
        header: t('itable.revenue'),
        accessor: (inc) => inc.revenueLossTomans,
        numeric: true,
        align: 'end',
        minWidth: 150,
        csv: (inc) => inc.revenueLossTomans,
        cell: (inc) =>
          inc.moneyModel ? (
            <MoneyWithFormula
              tomans={inc.revenueLossTomans}
              tone={inc.revenueLossTomans > 0 ? 'crit' : 'default'}
              formula={t('formula.revenueLoss')}
              inputs={[
                {
                  label: t('formula.input.lostTx'),
                  value: formatNumberLocale(inc.lostTransactions, lang),
                },
                {
                  label: t('formula.input.ticket'),
                  value: formatNumberLocale(inc.moneyModel.avgTransactionValue, lang),
                },
              ]}
              evidence={[
                { label: t('formula.evidence.moneyModel'), href: '/settings/services' },
                { label: t('formula.evidence.domainDoc') },
              ]}
            />
          ) : (
            <MoneyValue tomans={inc.revenueLossTomans} />
          ),
      },
      {
        id: 'penalty',
        header: t('itable.penalty'),
        accessor: (inc) => inc.penaltyTomans,
        numeric: true,
        align: 'end',
        minWidth: 150,
        csv: (inc) => inc.penaltyTomans,
        cell: (inc) => {
          const mm = inc.moneyModel
          const minutes = billedMinutes(inc.durationSec)
          // popover only when the figure is a resolved-engine figure — an
          // ongoing incident has no penalty yet, and pretending otherwise
          // would break the truthful-numbers rule
          if (!mm || inc.status !== 'resolved' || minutes === null) {
            return <MoneyValue tomans={inc.penaltyTomans} />
          }
          const weightPct = inc.severity === 'warning' ? 30 : 100
          return (
            <MoneyWithFormula
              tomans={inc.penaltyTomans}
              tone={inc.penaltyTomans > 0 ? 'warn' : 'default'}
              formula={t('formula.penalty')}
              inputs={[
                { label: t('formula.input.base'), value: formatNumberLocale(mm.penaltyBase, lang) },
                {
                  label: t('formula.input.perMin'),
                  value: formatNumberLocale(mm.penaltyPerMinute, lang),
                },
                { label: t('formula.input.minutes'), value: formatNumberLocale(minutes, lang) },
                { label: t('formula.input.weight', { pct: weightPct }), value: `× ${weightPct}%` },
              ]}
              evidence={[
                { label: t('formula.evidence.moneyModel'), href: '/settings/services' },
                { label: t('formula.evidence.domainDoc') },
              ]}
            />
          )
        },
      },
      {
        id: 'status',
        header: t('itable.status'),
        accessor: (inc) => inc.status,
        cell: (inc) => {
          const st = INCIDENT_STATUS[inc.status]
          const ongoing = inc.status === 'ongoing'
          const acked = inc.acknowledgedAt !== null
          return (
            <div className="flex flex-wrap items-center gap-1">
              <Badge variant="outline" className={cn('gap-1 px-1.5 py-0 text-[10px]', st.chip)}>
                {ongoing ? (
                  <span className="size-1.5 animate-status-pulse rounded-full bg-crit" aria-hidden="true" />
                ) : null}
                {t(st.label)}
              </Badge>
              {ongoing && acked ? (
                <Badge
                  variant="outline"
                  className="gap-1 border-info/30 bg-info-subtle px-1.5 py-0 text-[10px] text-info"
                  title={inc.acknowledgedBy ?? undefined}
                >
                  <UserCheck className="size-2.5" aria-hidden="true" />
                  {t('itable.acked')}
                </Badge>
              ) : null}
              {ongoing && !acked && inc.escalatedAt ? (
                <Badge
                  variant="outline"
                  className="gap-1 border-warn/25 bg-warn-subtle px-1.5 py-0 text-[10px] text-warn"
                  title={t('esc.chipAria', { who: inc.escalatedTo ?? '' })}
                >
                  <TriangleAlert className="size-2.5" aria-hidden="true" />
                  {t('esc.chip')}
                </Badge>
              ) : null}
            </div>
          )
        },
      },
      {
        id: 'actions',
        header: t('itable.actions'),
        align: 'end',
        locked: true,
        csv: () => '',
        cell: (inc) => {
          const ongoing = inc.status === 'ongoing'
          const acked = inc.acknowledgedAt !== null
          return (
            // stopPropagation: the row opens the detail dialog — action
            // buttons must not trigger it (also fixes a pre-existing bug
            // where Resolve/Ack also opened the dialog)
            <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
              {ongoing && !acked ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 border-info/30 bg-info-subtle px-2 text-[11px] text-info hover:bg-info-subtle"
                  aria-label={t('itable.ackAria', { id: inc.id.slice(0, 8) })}
                  onClick={() => openAckDialog(inc)}
                  disabled={ack.isPending}
                >
                  {pendingAckId === inc.id ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <BellRing className="size-3.5" aria-hidden="true" />
                  )}
                  {t('itable.ack')}
                </Button>
              ) : null}
              {ongoing ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 border-warn/30 bg-warn-subtle px-2 text-[11px] text-warn hover:bg-warn-subtle"
                  onClick={() => resolve.mutate(inc.id)}
                  disabled={resolve.isPending}
                >
                  {pendingResolveId === inc.id ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Wrench className="size-3.5" aria-hidden="true" />
                  )}
                  {t('itable.resolve')}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t('itable.genAria', { id: inc.id.slice(0, 8) })}
                onClick={() => postMortem.mutate({ incidentId: inc.id })}
                disabled={postMortem.isPending}
              >
                {pendingPostMortemId === inc.id ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles className="size-3.5" aria-hidden="true" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-text-2"
                onClick={() => onIncidentSelect(inc)}
              >
                {t('inc.details')}
              </Button>
            </div>
          )
        },
      },
  ]

  return (
    <>
      <DataTable
        columns={columns}
        rows={incidents}
        rowKey={(inc) => inc.id}
        ariaLabel={t('inc.aria')}
        searchAccessor={(inc) =>
          `${inc.id} ${inc.serviceName} ${inc.serviceKey} ${inc.severity} ${inc.source} ${inc.status}`
        }
        initialQuery={initialQuery}
        minWidth={1240}
        csvFileName="sentinel-incidents"
        onRowClick={onIncidentSelect}
        rowTone={(inc) => (inc.status === 'ongoing' ? 'warn' : 'default')}
        rowClassName={(inc) =>
          inc.status === 'ongoing' && inc.escalatedAt
            ? 'shadow-[inset_3px_0_0_0_theme(--color-warn)] rtl:shadow-[inset_-3px_0_0_0_theme(--color-warn)]'
            : undefined
        }
        empty={
          <div className="p-4">
            <EmptyState
              icon={ShieldCheck}
              title={t('itable.empty.title')}
              description={t('itable.empty.desc')}
              className="py-8"
            />
          </div>
        }
      />

      {/* v2.5: acknowledge dialog — handle input prefilled with the on-duty primary */}
      <Dialog open={ackTarget !== null} onOpenChange={(open) => !open && setAckTarget(null)}>
        <DialogContent className="border-line bg-surface sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <span className="flex size-8 items-center justify-center rounded-lg bg-info-subtle text-info">
                <BellRing className="size-4" aria-hidden="true" />
              </span>
              {t('ack.dialog.title')}
            </DialogTitle>
            <DialogDescription>{t('ack.dialog.desc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="ack-handle" className="text-[13px] font-medium text-text-1">
              {t('ack.dialog.label')}
            </label>
            <Input
              id="ack-handle"
              dir="ltr"
              value={ackHandle}
              onChange={(e) => setAckHandle(e.target.value)}
              placeholder={t('ack.dialog.placeholder')}
              maxLength={40}
              autoComplete="off"
              className="font-mono text-[13px]"
            />
            <p className="text-[11px] leading-relaxed text-text-2">{t('ack.dialog.hint')}</p>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" className="h-9" onClick={() => setAckTarget(null)}>
              {t('ack.dialog.cancel')}
            </Button>
            <Button
              className="h-9 gap-1.5 bg-brand text-white hover:bg-brand-hover"
              onClick={confirmAck}
              disabled={ack.isPending || (ackHandle.trim().length > 0 && ackHandle.trim().length < 2)}
            >
              {ack.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <UserCheck className="size-4" aria-hidden="true" />
              )}
              {t('ack.dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

'use client'

// Sentinel-SLA — service scorecard on the shared DataTable (design system §6.3).
// Money figures go through MoneyValue + FormulaPopover with the REAL inputs
// behind each figure (truthful-numbers rule): revenue loss is exactly
// Σ(lost tx) × avg tx value per service config, penalties follow
// (base + per-minute × minutes) × severity weight from the contract scheme.

import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { DataTable, type DataTableColumn } from './data-table'
import { MoneyWithFormula } from './formula-popover'
import { MoneyValue } from './money-value'
import { EmptyState } from './empty-state'
import { Activity, SearchX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatNumberLocale, formatPercentLocale } from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import type { IncidentDTO, ServiceDTO } from '@/lib/types'
import { serviceStatus } from './status'

export function ServiceTable({
  services,
  incidents,
  onServiceClick,
  initialQuery,
}: {
  services: ServiceDTO[]
  incidents: IncidentDTO[]
  onServiceClick: (service: ServiceDTO) => void
  /** Pre-fills the table search (deep links from the CommandPalette). */
  initialQuery?: string
}) {
  const { t, lang, name } = useLang()

  const lostTxByService = useMemo(() => {
    const map = new Map<string, number>()
    for (const inc of incidents) {
      map.set(inc.serviceId, (map.get(inc.serviceId) ?? 0) + inc.lostTransactions)
    }
    return map
  }, [incidents])

  const columns = useMemo<Array<DataTableColumn<ServiceDTO>>>(
    () => [
      {
        id: 'service',
        header: t('table.service'),
        accessor: (s) => name(s.name, s.nameFa),
        sticky: true,
        locked: true,
        minWidth: 220,
        csv: (s) => s.name,
        cell: (s) => {
          const st = serviceStatus(s.status)
          return (
            <span className="flex items-center gap-2.5">
              <span className={cn('size-2 shrink-0 rounded-full', st.dot)} aria-hidden="true" />
              <span className="min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-[13px] font-medium text-text-1">
                    {name(s.name, s.nameFa)}
                  </span>
                  {name(s.name, s.nameFa) !== s.name ? (
                    <span className="shrink-0 text-[10px] text-text-3" lang="en" dir="ltr">
                      {s.name}
                    </span>
                  ) : s.nameFa ? (
                    <span className="shrink-0 text-[10px] text-text-3" lang="fa" dir="rtl">
                      {s.nameFa}
                    </span>
                  ) : null}
                </span>
                <span className="block text-[10px] text-text-3" dir="ltr">
                  {s.endpoint}
                </span>
              </span>
              <Badge
                variant="outline"
                className="ms-1 border-line bg-raised px-1 py-0 text-[9px] text-text-2"
              >
                {s.tier}
              </Badge>
            </span>
          )
        },
      },
      {
        id: 'status',
        header: t('table.status'),
        accessor: (s) => s.status,
        cell: (s) => {
          const st = serviceStatus(s.status)
          return (
            <span
              className={cn('flex items-center gap-1.5 text-[12px] font-medium', st.text)}
            >
              {s.status === 'down' ? (
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full opacity-60 bg-crit" />
                  <span className="relative inline-flex size-2 rounded-full bg-crit" />
                </span>
              ) : (
                <span className={cn('size-2 rounded-full', st.dot)} aria-hidden="true" />
              )}
              {t(st.label)}
            </span>
          )
        },
      },
      {
        id: 'uptime',
        header: t('table.uptimeVsSla'),
        accessor: (s) => s.uptime,
        numeric: true,
        align: 'end',
        csv: (s) => (s.uptime * 100).toFixed(3),
        cell: (s) => {
          const belowTarget = s.uptime < s.slaTarget
          return (
            <span className="inline-block">
              <span
                className={cn(
                  'block text-[13px] font-medium tabular-nums',
                  belowTarget ? 'text-crit' : 'text-text-1',
                )}
              >
                {formatPercentLocale(s.uptime, lang)}
              </span>
              <span className="block text-[10px] tabular-nums text-text-3">
                {t('table.target', { v: formatPercentLocale(s.slaTarget, lang, 2) })}
              </span>
            </span>
          )
        },
      },
      {
        id: 'incidents',
        header: t('table.incidents'),
        accessor: (s) => s.incidentsCount,
        numeric: true,
        align: 'end',
        cell: (s) =>
          s.incidentsCount > 0 ? (
            <span className="text-warn tabular-nums">
              {formatNumberLocale(s.incidentsCount, lang)}
            </span>
          ) : (
            <span className="text-text-3 tabular-nums">{formatNumberLocale(0, lang)}</span>
          ),
      },
      {
        id: 'lostTx',
        header: t('table.lostTx'),
        accessor: (s) => s.lostTransactions,
        numeric: true,
        align: 'end',
        cell: (s) => (
          <span className="text-text-2 tabular-nums">
            {formatNumberLocale(s.lostTransactions, lang)}
          </span>
        ),
      },
      {
        id: 'revenueLoss',
        header: t('table.revenueLoss'),
        accessor: (s) => s.revenueLossTomans,
        numeric: true,
        align: 'end',
        csv: (s) => s.revenueLossTomans,
        cell: (s) => (
          <MoneyWithFormula
            tomans={s.revenueLossTomans}
            tone={s.revenueLossTomans > 0 ? 'crit' : 'default'}
            formula={t('formula.revenueLoss')}
            inputs={[
              {
                label: t('formula.input.lostTx'),
                value: formatNumberLocale(s.lostTransactions, lang),
              },
              {
                label: t('formula.input.ticket'),
                value: formatNumberLocale(s.avgTransactionValue, lang),
              },
            ]}
            evidence={[
              { label: t('formula.evidence.moneyModel'), href: '/settings/services' },
              { label: t('formula.evidence.domainDoc') },
            ]}
          />
        ),
      },
      {
        id: 'penalty',
        header: t('table.penalty'),
        accessor: (s) => s.penaltyTomans,
        numeric: true,
        align: 'end',
        csv: (s) => s.penaltyTomans,
        cell: (s) => (
          <MoneyWithFormula
            tomans={s.penaltyTomans}
            tone={s.penaltyTomans > 0 ? 'warn' : 'default'}
            formula={t('formula.penalty')}
            inputs={[
              { label: t('formula.input.base'), value: formatNumberLocale(s.penaltyBase, lang) },
              {
                label: t('formula.input.perMin'),
                value: formatNumberLocale(s.penaltyPerMinute, lang),
              },
              {
                label: t('table.incidents'),
                value: formatNumberLocale(s.incidentsCount, lang),
              },
            ]}
            evidence={[
              { label: t('formula.evidence.moneyModel'), href: '/settings/services' },
              { label: t('formula.evidence.domainDoc') },
            ]}
          />
        ),
      },
    ],
    // name/lostTxByService are stable per language + data change
    [t, lang, name, lostTxByService],
  )

  return (
    <DataTable
      columns={columns}
      rows={services}
      rowKey={(s) => s.id}
      ariaLabel={t('table.aria')}
      searchAccessor={(s) => `${s.key} ${s.name} ${s.nameFa ?? ''} ${s.endpoint} ${s.tier} ${s.status}`}
      initialQuery={initialQuery}
      minWidth={880}
      csvFileName="sentinel-services"
      onRowClick={onServiceClick}
      rowAriaLabel={(s) => t('table.viewHistory', { name: name(s.name, s.nameFa) })}
      empty={
        <div className="p-4">
          <EmptyState
            icon={services.length === 0 ? Activity : SearchX}
            title={t('dt.empty.title')}
            description={t('dt.empty.desc')}
            className="py-8"
          />
        </div>
      }
    />
  )
}

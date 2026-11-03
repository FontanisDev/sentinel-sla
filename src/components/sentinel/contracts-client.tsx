'use client'

// /contracts — client contracts: per-service contract
// rows for the current Jalali month — target, penalty scheme, chargeable
// downtime, measured availability, compliance chip, penalty to date and the
// linear projection. Every money/percent figure carries FormulaPopover
// evidence (§6.7); the table reuses the proven DataTable engine (§6.3).

import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { formatDurationLocale, formatNumberLocale, formatPercentLocale, formatTomansFullLocale } from '@/lib/format'
import type { ContractCompliance, ContractServiceRow } from '@/lib/types'
import { getServerTenantSnapshot, getTenantSnapshot, subscribeTenant, useContracts } from '@/hooks/use-sentinel'
import { useLang } from '@/hooks/use-language'
import { AppShell } from '@/components/sentinel/app-shell'
import { PageHeader } from '@/components/sentinel/page-header'
import { KpiCard } from '@/components/sentinel/kpi-card'
import { MoneyValue } from '@/components/sentinel/money-value'
import { FormulaPopover } from '@/components/sentinel/formula-popover'
import { DataTable, type DataTableColumn } from '@/components/sentinel/data-table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/sentinel/empty-state'
import { DashboardSkeleton } from '@/components/sentinel/skeleton'
import { Building2, CalendarRange, FileWarning, Handshake, RefreshCw } from 'lucide-react'

/** Compliance chip styles — status.ts token classes, contract semantics. */
const COMPLIANCE_CHIP: Record<ContractCompliance, { chip: string; label: Parameters<ReturnType<typeof useLang>['t']>[0] }> = {
  compliant: { chip: 'border-ok/25 bg-ok-subtle text-ok', label: 'contracts.compliance.compliant' },
  breach: { chip: 'border-crit/25 bg-crit-subtle text-crit', label: 'contracts.compliance.breach' },
  pending: { chip: 'border-line bg-raised text-muted-foreground', label: 'contracts.compliance.pending' },
}

export function ContractsClient({
  user,
}: {
  user: { name: string; email: string; role: string; locale?: string | null }
}) {
  const tenantId = useSyncExternalStore(subscribeTenant, getTenantSnapshot, getServerTenantSnapshot)
  const { t, lang, name, isFa } = useLang()
  const { data, error, isLoading, refetch } = useContracts(tenantId)

  const rows = data?.rows ?? []
  const totals = data?.totals ?? null

  const kpis = useMemo<Array<{ key: string; icon: typeof Building2; label: string; tone: 'default' | 'good' | 'bad' | 'warn'; value: ReactNode; sub: ReactNode }>>(() => {
    if (!totals || !data) return []
    return [
      {
        key: 'clients',
        icon: Building2,
        label: t('contracts.kpi.clients'),
        tone: 'default',
        value: formatNumberLocale(totals.tenants, lang),
        sub: t('contracts.kpi.services', { v: formatNumberLocale(totals.services, lang) }),
      },
      {
        key: 'breaches',
        icon: FileWarning,
        label: t('contracts.kpi.breaches'),
        tone: totals.breaches > 0 ? 'bad' : 'good',
        value: formatNumberLocale(totals.breaches, lang),
        sub: t('contracts.kpi.breachSub', { v: formatNumberLocale(totals.services, lang) }),
      },
      {
        key: 'penalty',
        icon: Handshake,
        label: t('contracts.kpi.penaltyToDate'),
        tone: 'warn',
        value: (
          <span className="inline-flex min-w-0 items-center gap-0.5">
            <MoneyValue tomans={totals.penaltyToDate} ultra />
            <FormulaPopover
              formula={t('contracts.formula.penaltySum')}
              inputs={[
                { label: t('contracts.col.service'), value: formatNumberLocale(totals.services, lang) },
                {
                  label: t('contracts.col.downtime'),
                  value: formatDurationLocale(rows.reduce((a, r) => a + r.downtimeSec, 0), lang),
                },
              ]}
              evidence={[
                { label: t('evidence.incidentLedger'), href: '/incidents' },
                { label: t('evidence.contracts') },
              ]}
            />
          </span>
        ),
        sub: t('contracts.window.sub'),
      },
      {
        key: 'projected',
        icon: CalendarRange,
        label: t('contracts.kpi.projected'),
        tone: 'warn',
        value:
          totals.projectedPenalty !== null ? (
            <span className="inline-flex min-w-0 items-center gap-0.5">
              <MoneyValue tomans={totals.projectedPenalty} ultra />
              <FormulaPopover
                formula={t('contracts.formula.projected')}
                inputs={[
                  { label: t('contracts.kpi.penaltyToDate'), value: formatTomansFullLocale(totals.penaltyToDate, lang) },
                  {
                    label: t('contracts.formula.elapsedFrac'),
                    value: formatPercentLocale(
                      data.elapsedSec > 0 ? Math.min(1, data.elapsedSec / data.window.lengthSec) : 0,
                      lang,
                      1,
                    ),
                  },
                ]}
                evidence={[{ label: t('evidence.contracts') }, { label: t('evidence.incidentLedger'), href: '/incidents' }]}
              />
            </span>
          ) : (
            <span className="text-[13px] text-t3" title={t('contracts.projection.pending')}>
              —
            </span>
          ),
        sub: t('contracts.projection.sub'),
      },
      {
        key: 'planned',
        icon: CalendarRange,
        label: t('contracts.kpi.plannedWindows'),
        tone: 'default',
        value: formatNumberLocale(totals.plannedWindows, lang),
        sub: t('contracts.exclusions.note'),
      },
    ]
  }, [data, totals, rows, lang, t])

  const columns = useMemo<Array<DataTableColumn<ContractServiceRow>>>(() => {
    const cols: Array<DataTableColumn<ContractServiceRow>> = [
      {
        id: 'client',
        header: t('contracts.col.client'),
        accessor: (r) => (r.tenantName ? name(r.tenantName, r.tenantNameFa) : '—'),
        cell: (r) => (
          <span className="whitespace-nowrap text-[13px] font-medium text-t1">
            {r.tenantName ? name(r.tenantName, r.tenantNameFa) : <span className="text-t3">—</span>}
          </span>
        ),
        sticky: true,
        minWidth: 140,
      },
      {
        id: 'service',
        header: t('contracts.col.service'),
        accessor: (r) => name(r.serviceName, r.serviceNameFa),
        cell: (r) => (
          <span className="whitespace-nowrap text-[13px] text-t1">
            {name(r.serviceName, r.serviceNameFa)}
          </span>
        ),
        minWidth: 160,
      },
      {
        id: 'target',
        header: t('contracts.col.target'),
        numeric: true,
        accessor: (r) => r.targetPct,
        cell: (r) => (
          <span className="font-mono text-[13px] tabular-nums text-t2">
            {formatPercentLocale(r.targetPct / 100, lang, 2)}
          </span>
        ),
        align: 'end',
      },
      {
        id: 'downtime',
        header: t('contracts.col.downtime'),
        numeric: true,
        accessor: (r) => r.downtimeSec,
        cell: (r) => (
          <span
            className="font-mono text-[13px] tabular-nums text-t2"
            title={`${formatNumberLocale(r.downtimeSec, lang)} s`}
          >
            {r.downtimeSec > 0 ? formatDurationLocale(r.downtimeSec, lang) : '—'}
          </span>
        ),
        align: 'end',
      },
      {
        id: 'availability',
        header: t('contracts.col.availability'),
        numeric: true,
        accessor: (r) => r.availabilityPct ?? -1,
        cell: (r) =>
          r.availabilityPct === null ? (
            <span className="text-[13px] text-t3">—</span>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-0.5">
              <span className="whitespace-nowrap font-mono text-[13px] tabular-nums text-t1">
                {formatPercentLocale(r.availabilityPct / 100, lang)}
              </span>
              <FormulaPopover
                formula={t('contracts.formula.availability')}
                inputs={[
                  { label: t('contracts.formula.elapsed'), value: formatDurationLocale(r.elapsedSec, lang) },
                  { label: t('contracts.col.downtime'), value: formatDurationLocale(r.downtimeSec, lang) },
                  { label: t('contracts.col.incidents'), value: formatNumberLocale(r.incidentsCount, lang) },
                ]}
                evidence={[
                  { label: t('evidence.incidentLedger'), href: `/incidents?q=${encodeURIComponent(r.serviceKey)}` },
                ]}
              />
            </span>
          ),
        align: 'end',
      },
      {
        id: 'compliance',
        header: t('contracts.col.compliance'),
        accessor: (r) => r.compliance,
        cell: (r) => (
          <Badge
            variant="outline"
            className={`gap-1 px-1.5 py-0 text-[10px] ${COMPLIANCE_CHIP[r.compliance].chip}`}
          >
            {t(COMPLIANCE_CHIP[r.compliance].label)}
          </Badge>
        ),
      },
      {
        id: 'penaltyToDate',
        header: t('contracts.col.penaltyToDate'),
        numeric: true,
        accessor: (r) => r.penaltyToDate,
        cell: (r) => (
          <span className="inline-flex min-w-0 items-center gap-0.5">
            <MoneyValue tomans={r.penaltyToDate} tone={r.penaltyToDate > 0 ? 'warn' : 'default'} />
            <FormulaPopover
              formula={t('contracts.formula.penalty')}
              inputs={[
                { label: t('contracts.formula.base'), value: formatTomansFullLocale(r.penaltyBase, lang) },
                { label: t('contracts.formula.perMinute'), value: formatTomansFullLocale(r.penaltyPerMinute, lang) },
                { label: t('contracts.formula.billed'), value: formatNumberLocale(r.billedMinutes, lang) },
                {
                  label: t('contracts.formula.weight'),
                  value: r.incidentsCount > 0 ? t('contracts.formula.weightValue') : '—',
                },
              ]}
              evidence={[
                { label: t('evidence.incidentLedger'), href: `/incidents?q=${encodeURIComponent(r.serviceKey)}` },
                { label: t('evidence.moneyModels'), href: `/services?q=${encodeURIComponent(r.serviceKey)}` },
                { label: t('formula.evidence.domainDoc') },
              ]}
            />
          </span>
        ),
        align: 'end',
      },
      {
        id: 'projected',
        header: t('contracts.col.projected'),
        numeric: true,
        accessor: (r) => r.projectedPenalty ?? -1,
        cell: (r) =>
          r.projectedPenalty === null ? (
            <span className="text-[13px] text-t3" title={t('contracts.projection.pending')}>
              —
            </span>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-0.5">
              <MoneyValue tomans={r.projectedPenalty} tone={r.compliance === 'breach' ? 'crit' : 'warn'} />
              <FormulaPopover
                formula={t('contracts.formula.projected')}
                inputs={[
                  { label: t('contracts.kpi.penaltyToDate'), value: formatTomansFullLocale(r.penaltyToDate, lang) },
                  {
                    label: t('contracts.formula.elapsedFrac'),
                    value: formatPercentLocale(
                      data && data.window.lengthSec > 0
                        ? Math.min(1, r.elapsedSec / data.window.lengthSec)
                        : 0,
                      lang,
                      1,
                    ),
                  },
                ]}
                evidence={[{ label: t('evidence.contracts') }]}
              />
            </span>
          ),
        align: 'end',
      },
      {
        id: 'planned',
        header: t('contracts.col.planned'),
        numeric: true,
        accessor: (r) => r.plannedWindows,
        cell: (r) => (
          <span
            className="font-mono text-[13px] tabular-nums text-t2"
            title={
              r.plannedWindows > 0
                ? `${t('contracts.exclusions.note')} · ${formatDurationLocale(r.plannedSec, lang)}`
                : undefined
            }
          >
            {r.plannedWindows > 0 ? formatNumberLocale(r.plannedWindows, lang) : '—'}
          </span>
        ),
        align: 'end',
        defaultHidden: true,
      },
    ]
    return cols
  }, [t, lang, name, data])

  const windowLabel = data ? (isFa ? data.window.labelFa : data.window.labelEn) : ''

  return (
    <AppShell
      user={user}
      crumbs={[
        { label: t('crumb.home'), href: '/' },
        { label: t('page.contracts.title') },
      ]}
    >
      <PageHeader
        title={t('page.contracts.title')}
        description={t('page.contracts.desc')}
        actions={
          data ? (
            <Badge
              variant="outline"
              className="gap-1.5 border-line px-2 py-1 text-[11px] text-t2"
              title={`${data.window.start} → ${data.window.end}`}
            >
              <CalendarRange className="size-3.5" aria-hidden="true" />
              {t('contracts.window.label')}: <span className="font-medium text-t1">{windowLabel}</span>
            </Badge>
          ) : null
        }
      />

      {isLoading ? (
        <DashboardSkeleton />
      ) : error ? (
        <div
          className="mt-6 flex flex-col items-center gap-3 rounded-[6px] border border-line bg-surface px-6 py-10 text-center"
          role="alert"
        >
          <p className="text-sm text-t2">{t('page.unreachable')}</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t('page.retry')}
          </Button>
        </div>
      ) : data && totals ? (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {kpis.map((k) => (
              <KpiCard key={k.key} icon={k.icon} label={k.label} value={k.value} sub={k.sub} tone={k.tone} />
            ))}
          </div>

          <div className="mt-6 rounded-[6px] border border-line bg-surface">
            {rows.length === 0 ? (
              <EmptyState
                icon={Handshake}
                title={t('contracts.empty.title')}
                description={t('contracts.empty.desc')}
                className="m-4"
              />
            ) : (
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r) => r.serviceId}
                ariaLabel={t('page.contracts.title')}
                searchAccessor={(r) =>
                  `${r.tenantName ?? ''} ${r.tenantNameFa ?? ''} ${r.serviceName} ${r.serviceNameFa ?? ''} ${r.serviceKey}`
                }
                csvFileName={`contracts-${data.window.jy}-${String(data.window.jm).padStart(2, '0')}.csv`}
                toolbarExtra={
                  <span className="hidden text-[11px] text-t3 lg:inline">{t('contracts.exclusions.note')}</span>
                }
                minWidth={1080}
              />
            )}
          </div>
        </>
      ) : null}
    </AppShell>
  )
}

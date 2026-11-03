'use client'

// Sentinel-SLA — SLA error budgets panel (v2 analytics, executive view).
// One row per service: rolling-window downtime allowance vs actual consumption,
// with burn rate and projected exhaustion. Placed right after FinancialImpact.

import { memo } from 'react'
import { PiggyBank } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import type { AnalyticsDTO, ErrorBudgetDTO, ErrorBudgetStatus, ServiceDTO } from '@/lib/types'
import { EmptyState } from './empty-state'
import { WindowSelector } from './window-selector'

const STATUS_STYLE: Record<ErrorBudgetStatus, { labelKey: 'budget.healthy' | 'budget.burning' | 'budget.exhausted'; chip: string; bar: string }> = {
  healthy: {
    labelKey: 'budget.healthy',
    chip: 'border-ok/25 bg-ok-subtle text-ok',
    bar: 'bg-ok',
  },
  burning: {
    labelKey: 'budget.burning',
    chip: 'border-warn/25 bg-warn-subtle text-warn',
    bar: 'bg-warn',
  },
  exhausted: {
    labelKey: 'budget.exhausted',
    chip: 'border-crit/25 bg-crit-subtle text-crit',
    bar: 'bg-crit',
  },
}

function budgetStatus(status: ErrorBudgetStatus) {
  return STATUS_STYLE[status]
}

/** One service budget row — memoized (re-renders only when its data changes). */
const ErrorBudgetRow = memo(function ErrorBudgetRow({
  budget,
  serviceName,
  serviceNameFa,
}: {
  budget: ErrorBudgetDTO
  serviceName: string
  serviceNameFa: string | null
}) {
  const { t, name, isFa } = useLang()
  const style = budgetStatus(budget.status)
  const overdrawn = budget.remainingSec < 0
  // Fill = consumed share of the allowance, capped at 100% (overrun = full bar).
  const fill =
    budget.allowedDowntimeSec > 0
      ? Math.min(1, budget.consumedDowntimeSec / budget.allowedDowntimeSec)
      : overdrawn
        ? 1
        : 0
  const showProjection = budget.projectedExhaustionSec !== null && budget.projectedExhaustionSec > 0
  const primary = name(serviceName, serviceNameFa)
  // Secondary label = the other language's name (EN ↔ FA bilingual hint).
  const secondary = serviceNameFa ? (isFa ? serviceName : serviceNameFa) : null

  return (
    <div className="sentinel-row-hover space-y-1.5 rounded-[6px] px-3 py-2.5 transition-colors">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2 text-xs">
          <span className="truncate font-medium text-foreground">{primary}</span>
          {secondary && secondary !== primary ? (
            <span
              className="shrink-0 text-[10px] text-muted-foreground"
              lang={isFa ? 'en' : 'fa'}
              dir={isFa ? 'ltr' : 'rtl'}
            >
              {secondary}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {overdrawn ? (
            <span className="text-[10px] font-medium tabular-nums text-crit">
              {t('budget.overrun', { v: formatDuration(Math.abs(budget.remainingSec)) })}
            </span>
          ) : null}
          <span
            className={cn('inline-flex h-5 items-center rounded-full border px-2 text-[10px] font-medium', style.chip)}
          >
            {t(style.labelKey)}
          </span>
        </span>
      </div>

      <div
        className="h-2 overflow-hidden rounded-full bg-raised"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={Math.round(budget.allowedDowntimeSec)}
        aria-valuenow={Math.round(Math.min(budget.consumedDowntimeSec, budget.allowedDowntimeSec))}
        aria-label={`${primary} — ${t('budget.consumed')} / ${t('budget.allowed')}`}
      >
        <div
          className={cn('h-full rounded-full transition-all duration-500', style.bar)}
          style={{ width: `${Math.max(fill * 100, budget.consumedDowntimeSec > 0 ? 2 : 0)}%` }}
        />
      </div>

      <p className="text-[10px] tabular-nums text-muted-foreground">
        {t('budget.allowed')} {formatDuration(budget.allowedDowntimeSec)}
        <span aria-hidden="true"> · </span>
        {t('budget.consumed')} {formatDuration(budget.consumedDowntimeSec)}
        <span aria-hidden="true"> · </span>
        {t('budget.burnRate')} {t('budget.perHour', { v: formatDuration(budget.burnRatePerHour) })}
        {showProjection ? (
          <>
            <span aria-hidden="true"> · </span>
            {t('budget.projected')}{' '}
            {t('budget.in', { v: formatDuration(budget.projectedExhaustionSec ?? 0) })}
          </>
        ) : null}
      </p>
    </div>
  )
})

/** Skeleton rows while the analytics query is in flight (first paint). */
function BudgetSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-1.5" aria-busy="true" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="sentinel-shimmer space-y-1.5 rounded-[6px] px-3 py-2.5">
          <div className="h-3 w-1/3 rounded-full bg-raised" />
          <div className="h-2 w-full rounded-full bg-raised" />
          <div className="h-2 w-2/3 rounded-full bg-raised" />
        </div>
      ))}
    </div>
  )
}

export function ErrorBudgetPanel({
  analytics,
  services,
  pending = false,
}: {
  analytics: AnalyticsDTO | undefined
  services: ServiceDTO[]
  pending?: boolean
}) {
  const { t } = useLang()
  const budgets = analytics?.errorBudgets ?? []
  const windowHours = analytics?.windowHours ?? 24
  const nameByKey = new Map(services.map((s) => [s.key, s]))

  return (
    <section aria-label={t('budget.title')} className="space-y-3">
      <Card className="sentinel-card-highlight gap-5 rounded-[6px] shadow-none">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {t('budget.title')}
            <span className="ms-auto">
              <WindowSelector />
            </span>
          </CardTitle>
          <CardDescription>
            {t('budget.desc', { h: windowHours })}
            <span className="ms-1.5 rounded-full border border-black/[0.08] dark:border-white/[0.08] bg-surface-2 px-1.5 py-px align-middle text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('budget.window', { h: windowHours })}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending && budgets.length === 0 ? (
            <BudgetSkeleton rows={Math.min(services.length || 6, 6)} />
          ) : budgets.length === 0 ? (
            <EmptyState
              icon={PiggyBank}
              title={t('budget.empty.title')}
              description={t('budget.empty.desc')}
              className="py-8"
            />
          ) : (
            <div className="divide-y divide-white/[0.05]">
              {budgets.map((budget) => {
                const service = nameByKey.get(budget.serviceKey)
                return (
                  <ErrorBudgetRow
                    key={budget.serviceId}
                    budget={budget}
                    serviceName={service ? service.name : budget.serviceName}
                    serviceNameFa={service ? service.nameFa : null}
                  />
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

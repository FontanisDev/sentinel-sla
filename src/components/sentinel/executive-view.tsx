'use client'

import { useLang } from '@/hooks/use-language'
import type { AnalyticsDTO, DashboardDTO, IncidentDTO, ServiceDTO, TenantDTO } from '@/lib/types'
import { FinancialImpact } from './financial-impact'
import { PenaltyTrendCard } from './penalty-trend-card'
import { ErrorBudgetPanel } from './error-budget-panel'
import { NotificationHealth } from './notification-health'
import { ServiceTable } from './service-table'
import { IncidentList } from './incident-list'
import { ReportsCard } from './reports-card'
import { SchedulesCard } from './schedules-card'
import { SectionHeader } from './section-header'
import { ExportButtons } from './export-buttons'

export function ExecutiveView({
  data,
  analytics,
  analyticsPending,
  tenant,
  onServiceSelect,
  onIncidentSelect,
}: {
  data: DashboardDTO
  /** v2 analytics (error budgets) — undefined while loading. */
  analytics: AnalyticsDTO | undefined
  analyticsPending?: boolean
  /** Active tenant scope (null = fleet-wide). */
  tenant: TenantDTO | null
  onServiceSelect: (service: ServiceDTO) => void
  onIncidentSelect: (incident: IncidentDTO) => void
}) {
  const { t } = useLang()

  return (
    <div className="space-y-8">
      <FinancialImpact kpis={data.kpis} services={data.services} />

      <PenaltyTrendCard analytics={analytics} />

      <ErrorBudgetPanel
        analytics={analytics}
        services={data.services}
        pending={analyticsPending}
      />

      <section aria-label={t('exec.scorecard.title')} className="space-y-3">
        <SectionHeader
          title={t('exec.scorecard.title')}
          description={t('exec.scorecard.desc')}
        />
        <ServiceTable services={data.services} incidents={data.incidents} onServiceClick={onServiceSelect} />
      </section>

      <section aria-label={t('exec.incidents.title')} className="space-y-3">
        <SectionHeader
          title={t('exec.incidents.title')}
          description={t('exec.incidents.desc')}
          badge={t('exec.tracked', { n: data.incidents.length })}
          actions={<ExportButtons kind="incidents" tenantId={tenant?.id ?? null} />}
        />
        <IncidentList incidents={data.incidents} onIncidentSelect={onIncidentSelect} />
      </section>

      <section aria-label={t('gov.exec.title')} className="space-y-3">
        <NotificationHealth channels={data.channels ?? []} onCall={data.onCall ?? []} />
      </section>

      <section aria-label={t('exec.reports.title')} className="space-y-3">
        <SectionHeader
          title={t('exec.reports.title')}
          description={t('exec.reports.desc')}
          badge={t('exec.files', { n: data.reports.length })}
        />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <ReportsCard reports={data.reports} tenant={tenant} />
          <SchedulesCard schedules={data.reportSchedules ?? []} runs={data.scheduleRuns ?? []} tenants={data.tenants} />
        </div>
      </section>
    </div>
  )
}

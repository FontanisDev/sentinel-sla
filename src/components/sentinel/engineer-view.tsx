'use client'

import { useLang } from '@/hooks/use-language'
import type { AnalyticsDTO, DashboardDTO, IncidentDTO } from '@/lib/types'
import { LatencyChartCard, ErrorThroughputChartCard } from './charts'
import { TrendsChart } from './trends-chart'
import { AvailabilityHeatmap } from './heatmap'
import { ServiceCard } from './service-card'
import { ChaosPanel } from './chaos-panel'
import { MaintenancePanel } from './maintenance-panel'
import { GovernancePanel } from './governance-panel'
import { IncidentTable } from './incident-table'
import { AlertsFeed } from './alerts-feed'
import { SectionHeader } from './section-header'
import { ExportButtons } from './export-buttons'
import { WindowSelector } from './window-selector'
import { GettingStartedCard } from './getting-started'

export function EngineerView({
  data,
  analytics,
  analyticsPending,
  tenantId,
  onIncidentSelect,
}: {
  data: DashboardDTO
  /** v2 analytics (trends + heatmap) — undefined while loading. */
  analytics: AnalyticsDTO | undefined
  analyticsPending?: boolean
  /** active tenant scope for exports (null = fleet-wide) */
  tenantId: string | null
  onIncidentSelect: (incident: IncidentDTO) => void
}) {
  const { t } = useLang()

  return (
    <div className="space-y-8">
      <GettingStartedCard />
      <div className="grid gap-4 lg:grid-cols-2">
        <LatencyChartCard services={data.services} />
        <ErrorThroughputChartCard services={data.services} />
      </div>

      <section aria-label={t('trends.title')}>
        <TrendsChart
          analytics={analytics}
          pending={analyticsPending}
          actions={
            <span className="flex flex-wrap items-center gap-2">
              <WindowSelector />
              <ExportButtons kind="analytics" tenantId={tenantId} />
            </span>
          }
        />
      </section>

      <section aria-label={t('eng.fleet.title')} className="space-y-3">
        <SectionHeader
          title={t('eng.fleet.title')}
          description={t('eng.fleet.desc')}
          badge={t('eng.services', { n: data.services.length })}
          actions={<ExportButtons kind="services" tenantId={tenantId} />}
        />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.services.map((service) => (
            <ServiceCard key={service.id} service={service} />
          ))}
        </div>
      </section>

      <AvailabilityHeatmap
        analytics={analytics}
        services={data.services}
        pending={analyticsPending}
      />

      <section aria-label={t('chaos.title')} className="space-y-3">
        <ChaosPanel services={data.services} experiments={data.chaosExperiments} />
      </section>

      <section aria-label={t('maint.title')} className="space-y-3">
        <MaintenancePanel services={data.services} windows={data.maintenanceWindows ?? []} />
      </section>

      <section aria-label={t('gov.rules.title')} className="space-y-3">
        <SectionHeader
          title={t('gov.rules.title')}
          description={t('gov.channels.desc')}
          badge={
            (data.alertRules?.filter((r) => r.enabled).length ?? 0) +
            '/' +
            (data.alertRules?.length ?? 0)
          }
        />
        <GovernancePanel
          services={data.services}
          rules={data.alertRules ?? []}
          channels={data.channels ?? []}
          onCall={data.onCall ?? []}
          escalationPolicy={data.escalationPolicy}
        />
      </section>

      <section aria-label={t('eng.ops.title')} className="space-y-3">
        <SectionHeader
          title={t('eng.ops.title')}
          description={t('eng.ops.desc')}
          badge={t('exec.tracked', { n: data.incidents.length })}
          actions={<ExportButtons kind="incidents" tenantId={tenantId} />}
        />
        <IncidentTable
          incidents={data.incidents}
          onIncidentSelect={onIncidentSelect}
          onCall={data.onCall ?? []}
          escalationPolicy={data.escalationPolicy}
        />
      </section>

      <section aria-label={t('alerts.title')} className="space-y-3">
        <AlertsFeed alerts={data.alerts} maintenanceWindows={data.maintenanceWindows} />
      </section>
    </div>
  )
}

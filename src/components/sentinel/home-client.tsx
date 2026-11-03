'use client'

// HomeClient — the role-aware command center body (refactor of the
// old page.tsx). Renders under AppShell; the role comes from the session via
// the server wrapper, never from a client-side toggle.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import dynamic from 'next/dynamic'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  getServerTenantSnapshot,
  getTenantSnapshot,
  setStoredTenant,
  subscribeTenant,
  useAlertToasts,
  useAnalytics,
  useDashboard,
} from '@/hooks/use-sentinel'
import { useLang } from '@/hooks/use-language'
import { useAnalyticsWindow } from '@/hooks/use-analytics-window'
import type { IncidentDTO, ServiceDTO } from '@/lib/types'
import type { AppShellUser } from '@/components/sentinel/app-shell'
import { AppShell } from '@/components/sentinel/app-shell'
import { KpiStrip } from '@/components/sentinel/kpi-strip'
import { ExecutiveView } from '@/components/sentinel/executive-view'
import { DashboardSkeleton } from '@/components/sentinel/skeleton'

// performance budget: the engineer view owns every recharts-based card
// (charts.tsx, trends-chart.tsx, service-card sparkline). Splitting it behind
// next/dynamic keeps recharts (~127 KB gzip) OUT of the initial JS of `/` and
// `/executive` — the two pages the budget gates. Engineers stream the chunk
// in after hydration; the skeleton covers the gap.
const EngineerView = dynamic(
  () => import('./engineer-view').then((m) => m.EngineerView),
  {
    ssr: false,
    loading: () => <DashboardSkeleton />,
  }
)

// Same budget reasoning: the detail dialogs only render after a click, so
// their chunks (radix dialog + parts module) load on first selection, not at
// page load.
const IncidentDetailDialog = dynamic(
  () => import('./incident-detail-dialog').then((m) => m.IncidentDetailDialog),
  { ssr: false, loading: () => null },
)
const ServiceIncidentsDialog = dynamic(
  () => import('./incident-detail-dialog').then((m) => m.ServiceIncidentsDialog),
  { ssr: false, loading: () => null },
)

export type HomeView = 'executive' | 'engineer'

export function HomeClient({
  user,
  initialView,
  crumbs,
}: {
  user: AppShellUser
  /** from the session role on `/`; `/executive` forces the money view */
  initialView?: HomeView
  crumbs?: Parameters<typeof AppShell>[0]['crumbs']
}) {
  const tenantId = useSyncExternalStore(subscribeTenant, getTenantSnapshot, getServerTenantSnapshot)
  const handleTenantChange = useCallback((next: string | null) => setStoredTenant(next), [])

  const { data, error, refetch, isLoading } = useDashboard(tenantId)
  const { windowHours } = useAnalyticsWindow()
  const { data: analytics, isPending: analyticsPending } = useAnalytics(tenantId, windowHours)
  useAlertToasts(data?.alerts)

  const { t, name } = useLang()

  const scopedTenant = useMemo(
    () => data?.tenants.find((x) => x.id === tenantId) ?? null,
    [data, tenantId]
  )

  const [selectedIncident, setSelectedIncident] = useState<IncidentDTO | null>(null)
  const [selectedService, setSelectedService] = useState<ServiceDTO | null>(null)

  const serviceIncidents = useMemo(
    () => data?.incidents.filter((inc) => inc.serviceId === selectedService?.id) ?? [],
    [data, selectedService]
  )

  const view: HomeView = initialView ?? 'engineer'

  return (
    <AppShell user={user} crumbs={crumbs}>
      {data ? (
        <div className="space-y-6">
          <KpiStrip
            kpis={data.kpis}
            services={data.services}
            scopeName={scopedTenant ? name(scopedTenant.name, scopedTenant.nameFa) : null}
          />
          {view === 'executive' ? (
            <ExecutiveView
              data={data}
              analytics={analytics}
              analyticsPending={analyticsPending}
              tenant={scopedTenant}
              onServiceSelect={setSelectedService}
              onIncidentSelect={setSelectedIncident}
            />
          ) : (
            <EngineerView
              data={data}
              analytics={analytics}
              analyticsPending={analyticsPending}
              tenantId={tenantId}
              onIncidentSelect={setSelectedIncident}
            />
          )}
        </div>
      ) : isLoading ? (
        <DashboardSkeleton />
      ) : (
        <div className="flex flex-col items-center justify-center gap-4 py-24 text-center" role="alert">
          <TriangleAlert className="size-10 text-crit" aria-hidden="true" />
          <div>
            <p className="font-semibold text-t1">{t('page.unreachable')}</p>
            <p className="mt-1 text-sm text-t2">{error?.message ?? t('page.couldNotLoad')}</p>
          </div>
          <Button onClick={() => refetch()} className="h-11 gap-1.5">
            <RefreshCw className="size-4" aria-hidden="true" />
            {t('page.retry')}
          </Button>
        </div>
      )}

      {selectedIncident ? (
        <IncidentDetailDialog
          incident={selectedIncident}
          onClose={() => setSelectedIncident(null)}
        />
      ) : null}
      {selectedService ? (
        <ServiceIncidentsDialog
          service={selectedService}
          incidents={serviceIncidents}
          onClose={() => setSelectedService(null)}
          onIncidentSelect={(incident) => {
            setSelectedService(null)
            setSelectedIncident(incident)
          }}
        />
      ) : null}
    </AppShell>
  )
}

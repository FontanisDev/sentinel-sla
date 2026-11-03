'use client'

import { useMemo, useState } from 'react'
import { AppShell } from '@/components/sentinel/app-shell'
import { PageHeader } from '@/components/sentinel/page-header'
import { useShellDashboard } from '@/components/sentinel/shell-page'
import { ServiceTable } from '@/components/sentinel/service-table'
import { IncidentDetailDialog, ServiceIncidentsDialog } from '@/components/sentinel/incident-detail-dialog'
import { DashboardSkeleton } from '@/components/sentinel/skeleton'
import type { IncidentDTO, ServiceDTO } from '@/lib/types'

export function ServicesClient({
  user,
  initialQuery = '',
}: {
  user: { name: string; email: string; role: string; locale?: string | null }
  /** Deep link from the CommandPalette (/services?q=<key>) — server-provided. */
  initialQuery?: string
}) {
  const { data, isLoading, t, scopedTenant, name } = useShellDashboard()
  const [selectedService, setSelectedService] = useState<ServiceDTO | null>(null)
  const [selectedIncident, setSelectedIncident] = useState<IncidentDTO | null>(null)

  const serviceIncidents = useMemo(
    () => data?.incidents.filter((inc) => inc.serviceId === selectedService?.id) ?? [],
    [data, selectedService]
  )

  return (
    <AppShell
      user={user}
      crumbs={[
        { label: t('crumb.home'), href: '/' },
        { label: t('page.services.title') },
      ]}
    >
      <PageHeader
        title={
          scopedTenant
            ? `${t('page.services.title')} — ${name(scopedTenant.name, scopedTenant.nameFa)}`
            : t('page.services.title')
        }
        description={t('page.services.desc')}
      />

      <div className="mt-6">
        {data ? (
          <div className="rounded-[6px] border border-line bg-surface">
            <ServiceTable
              key={initialQuery}
              services={data.services}
              incidents={data.incidents}
              onServiceClick={setSelectedService}
              initialQuery={initialQuery}
            />
          </div>
        ) : isLoading ? (
          <DashboardSkeleton />
        ) : (
          <p className="py-16 text-center text-sm text-t2" role="alert">
            {t('page.unreachable')}
          </p>
        )}
      </div>

      <IncidentDetailDialog
        incident={selectedIncident}
        onClose={() => setSelectedIncident(null)}
      />
      <ServiceIncidentsDialog
        service={selectedService}
        incidents={serviceIncidents}
        onClose={() => setSelectedService(null)}
        onIncidentSelect={(incident) => {
          // Chain into the incident detail dialog (the same flow as the home
          // health cards) — previously this just closed the dialog and the
          // click appeared to do nothing.
          setSelectedService(null)
          setSelectedIncident(incident)
        }}
      />
    </AppShell>
  )
}

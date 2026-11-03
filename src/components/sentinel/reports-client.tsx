'use client'

import { AppShell } from '@/components/sentinel/app-shell'
import { PageHeader } from '@/components/sentinel/page-header'
import { useShellDashboard } from '@/components/sentinel/shell-page'
import { ReportsCard } from '@/components/sentinel/reports-card'
import { SchedulesCard } from '@/components/sentinel/schedules-card'
import { DashboardSkeleton } from '@/components/sentinel/skeleton'

export function ReportsClient({
  user,
}: {
  user: { name: string; email: string; role: string; locale?: string | null }
}) {
  const { data, isLoading, t, scopedTenant } = useShellDashboard()

  return (
    <AppShell
      user={user}
      crumbs={[
        { label: t('crumb.home'), href: '/' },
        { label: t('page.reports.title') },
      ]}
    >
      <PageHeader title={t('page.reports.title')} description={t('page.reports.desc')} />

      <div className="mt-6 space-y-6">
        {data ? (
          <>
            <ReportsCard
              reports={data.reports}
              tenant={scopedTenant}
              tenants={data.tenants}
              incidents={data.incidents}
            />
            <SchedulesCard schedules={data.reportSchedules} runs={data.scheduleRuns} tenants={data.tenants} />
          </>
        ) : isLoading ? (
          <DashboardSkeleton />
        ) : (
          <p className="py-16 text-center text-sm text-t2" role="alert">
            {t('page.unreachable')}
          </p>
        )}
      </div>
    </AppShell>
  )
}

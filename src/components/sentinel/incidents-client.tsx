'use client'

import { useMemo, useState } from 'react'
import { AppShell } from '@/components/sentinel/app-shell'
import { PageHeader } from '@/components/sentinel/page-header'
import { useShellDashboard } from '@/components/sentinel/shell-page'
import { IncidentTable } from '@/components/sentinel/incident-table'
import { IncidentDetailDialog } from '@/components/sentinel/incident-detail-dialog'
import { DashboardSkeleton } from '@/components/sentinel/skeleton'
import { TimeRange, resolveRange, type TimeRangeValue } from '@/components/sentinel/time-range'
import type { IncidentDTO } from '@/lib/types'

export function IncidentsClient({
  user,
  initialQuery = '',
}: {
  user: { name: string; email: string; role: string; locale?: string | null }
  /** Deep link from the CommandPalette (/incidents?q=<id>) — server-provided. */
  initialQuery?: string
}) {
  const { data, isLoading, t } = useShellDashboard()
  const [selectedIncident, setSelectedIncident] = useState<IncidentDTO | null>(null)
  // §6.8 TimeRange (its first consumer): preset windows or an explicit
  // custom From/To range picked on the shared JalaliDatePicker. Bounds are
  // inclusive; presets are open-ended ("up to the present").
  const [range, setRange] = useState<TimeRangeValue>({
    preset: '30d',
    from: null,
    to: null,
  })

  const incidents = useMemo(() => {
    if (!data) return []
    const { from, to } = resolveRange(range)
    const lo = from?.getTime() ?? null
    const hi = to?.getTime() ?? null
    return data.incidents.filter((inc) => {
      const at = new Date(inc.startedAt).getTime()
      if (lo !== null && at < lo) return false
      if (hi !== null && at > hi) return false
      return true
    })
  }, [data, range])

  return (
    <AppShell
      user={user}
      crumbs={[
        { label: t('crumb.home'), href: '/' },
        { label: t('page.incidents.title') },
      ]}
    >
      <PageHeader
        title={t('page.incidents.title')}
        description={t('page.incidents.desc')}
        actions={<TimeRange value={range} onChange={setRange} />}
      />

      <div className="mt-6">
        {data ? (
          <div className="rounded-[6px] border border-line bg-surface">
            <IncidentTable
              key={initialQuery}
              incidents={incidents}
              onIncidentSelect={setSelectedIncident}
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

      <IncidentDetailDialog incident={selectedIncident} onClose={() => setSelectedIncident(null)} />
    </AppShell>
  )
}

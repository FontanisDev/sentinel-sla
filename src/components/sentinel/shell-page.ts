'use client'

// Shared data plumbing for the route-based pages: tenant scope +
// dashboard + analytics + the document lang/dir effect, identical to the
// home. Pages render inside AppShell and consume this hook.

import { useEffect, useSyncExternalStore } from 'react'
import {
  getServerTenantSnapshot,
  getTenantSnapshot,
  setStoredTenant,
  subscribeTenant,
  useAnalytics,
  useDashboard,
} from '@/hooks/use-sentinel'
import { useAnalyticsWindow } from '@/hooks/use-analytics-window'
import { useLang } from '@/hooks/use-language'

export function useShellDashboard() {
  const tenantId = useSyncExternalStore(subscribeTenant, getTenantSnapshot, getServerTenantSnapshot)
  const { data, error, refetch, isLoading } = useDashboard(tenantId)
  const { windowHours } = useAnalyticsWindow()
  const { data: analytics, isPending: analyticsPending } = useAnalytics(tenantId, windowHours)
  const { t, name, dir, isFa } = useLang()

  useEffect(() => {
    document.documentElement.lang = isFa ? 'fa' : 'en'
    document.documentElement.dir = dir
  }, [isFa, dir])

  const scopedTenant = data?.tenants.find((x) => x.id === tenantId) ?? null

  return {
    tenantId,
    setTenantId: setStoredTenant,
    data,
    error,
    refetch,
    isLoading,
    analytics,
    analyticsPending,
    windowHours,
    scopedTenant,
    t,
    name,
    dir,
    isFa,
  }
}

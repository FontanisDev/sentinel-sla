'use client'

import { useEffect, useRef } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '@/lib/toast'
import { translate } from '@/lib/i18n'
import type {
  AlertDTO,
  ContractsSnapshotDTO,
  AlertRuleDTO,
  AnalyticsDTO,
  AnalyticsWindow,
  ApiError,
  AutoChaosPayload,
  ChaosPayload,
  CreateAlertRulePayload,
  CreateChannelPayload,
  CreateMaintenanceWindowPayload,
  CreateOnCallPayload,
  CreateReportSchedulePayload,
  DashboardDTO,
  EngineActionPayload,
  EscalationPolicyDTO,
  GenerateReportPayload,
  IncidentDTO,
  IncidentDetailDTO,
  MaintenanceWindowDTO,
  NotificationChannelDTO,
  OnCallEntryDTO,
  PostMortemPayload,
  ReportDTO,
  ReportScheduleDTO,
  ServiceDetailDTO,
  UpdateEscalationPayload,
} from '@/lib/types'

export const DASHBOARD_KEY = ['sentinel', 'dashboard'] as const

/** Query key factory (tenant-scoped). */
export const dashboardKey = (tenantId: string | null) =>
  ['sentinel', 'dashboard', tenantId ?? 'all'] as const
export const ANALYTICS_KEY = ['sentinel', 'analytics'] as const

// ── Tenant scope store (localStorage + custom event; mirrors the role/lang
//    hydration-safe useSyncExternalStore pattern). null = fleet-wide. ──────
const TENANT_KEY = 'sentinel-tenant'
const TENANT_EVENT = 'sentinel:tenant-change'

export function subscribeTenant(callback: () => void) {
  window.addEventListener(TENANT_EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(TENANT_EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

export function getTenantSnapshot(): string | null {
  try {
    const v = window.localStorage.getItem(TENANT_KEY)
    return v && v !== 'all' ? v : null
  } catch {
    return null
  }
}

export function getServerTenantSnapshot(): string | null {
  return null
}

/** Set (or clear, with null) + broadcast the tenant scope. */
export function setStoredTenant(tenantId: string | null) {
  try {
    if (tenantId) window.localStorage.setItem(TENANT_KEY, tenantId)
    else window.localStorage.removeItem(TENANT_KEY)
  } catch {
    // storage unavailable — the event below still applies it for this tab
  }
  window.dispatchEvent(new Event(TENANT_EVENT))
}

/** Read the current UI language outside React (for self-heal toasts). */
function currentLang(): 'en' | 'fa' {
  try {
    return window.localStorage.getItem('sentinel-lang') === 'fa' ? 'fa' : 'en'
  } catch {
    return 'en'
  }
}

/** Typed fetch wrapper with consistent error extraction. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      cache: 'no-store',
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    throw new Error('Network error — Sentinel engine unreachable')
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const body = (await res.json()) as ApiError
      if (body?.error) message = body.error
    } catch {
      // non-JSON error body — keep status message
    }
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  try {
    return (await res.json()) as T
  } catch {
    return undefined as T
  }
}

/** Build a tenant-scoped query string ("" | "?tenant=…" | "?tenant=…&windowHours=…"). */
function withTenant(tenantId: string | null | undefined, extra?: Record<string, string | number>) {
  const params = new URLSearchParams()
  if (tenantId) params.set('tenant', tenantId)
  if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, String(v))
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Live dashboard poll, optionally scoped to one tenant. Fast (2.5s) while the
 * engine is running, slow (15s) while paused.
 *
 * A stale tenant id (deleted client) 404s on the server — the queryFn then
 * clears the bad localStorage value, notifies the user and falls back to the
 * fleet-wide snapshot so the UI never dead-ends.
 */
export function useDashboard(tenantId?: string | null) {
  return useQuery<DashboardDTO>({
    queryKey: [...DASHBOARD_KEY, tenantId ?? 'all'],
    queryFn: async () => {
      try {
        return await api<DashboardDTO>(`/api/dashboard${withTenant(tenantId)}`)
      } catch (err) {
        if (tenantId) {
          setStoredTenant(null)
          toast.info(translate(currentLang(), 'tenant.staleCleared'), {
            description: err instanceof Error ? err.message : undefined,
          })
          return await api<DashboardDTO>('/api/dashboard')
        }
        throw err
      }
    },
    refetchInterval: (query) => (query.state.data?.engine.running ? 2500 : 15000),
    placeholderData: keepPreviousData,
    staleTime: 1500,
    retry: 1,
    retryDelay: 1500,
  })
}

/**
 * v2 analytics (error budgets / trends / status heatmap), scoped like
 * the dashboard. v2.4: the display window (6/12/24h) is caller-selected —
 * the server adapts heatmap bucket sizes per window. 60s poll with
 * keepPreviousData so tenant/window switches feel instant.
 */
export function useAnalytics(tenantId?: string | null, windowHours: AnalyticsWindow = 24) {
  return useQuery<AnalyticsDTO>({
    queryKey: [...ANALYTICS_KEY, tenantId ?? 'all', windowHours],
    queryFn: () => api<AnalyticsDTO>(`/api/analytics${withTenant(tenantId, { windowHours })}`),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: 1,
    retryDelay: 1500,
  })
}

/** POST /api/engine — pause / resume / set-mode. */
export function useEngineAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: EngineActionPayload) =>
      api<unknown>('/api/engine', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (_data, payload) => {
      const lang = currentLang()
      if (payload.action === 'pause') {
        toast.success(translate(lang, 'eng.toast.paused'), {
          description: translate(lang, 'eng.toast.pausedDesc'),
        })
      } else if (payload.action === 'resume') {
        toast.success(translate(lang, 'eng.toast.resumed'), {
          description: translate(lang, 'eng.toast.resumedDesc'),
        })
      } else if (payload.action === 'set-mode' && payload.mode) {
        toast.success(translate(lang, 'eng.toast.mode', { mode: payload.mode }), {
          description: translate(
            lang,
            payload.mode === 'storm'
              ? 'eng.toast.modeStorm'
              : payload.mode === 'calm'
                ? 'eng.toast.modeCalm'
                : 'eng.toast.modeNormal',
          ),
        })
      }
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'eng.toast.failed'), { description: e.message }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: DASHBOARD_KEY })
      void qc.invalidateQueries({ queryKey: SERVICE_DETAIL_KEY })
    },
  })
}

/** POST /api/chaos — launch a controlled experiment. */
export function useLaunchChaos() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: ChaosPayload) =>
      api<unknown>('/api/chaos', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (_data, payload) => {
      toast.warning(translate(currentLang(), 'chaos.toast.launched'), {
        description: translate(currentLang(), 'chaos.toast.launchedDesc', { type: payload.type }),
      })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'chaos.toast.failed'), { description: e.message }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: DASHBOARD_KEY })
      void qc.invalidateQueries({ queryKey: SERVICE_DETAIL_KEY })
    },
  })
}

/** POST /api/chaos/auto — toggle the self-test scheduler. */
export function useAutoChaos() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: AutoChaosPayload) =>
      api<unknown>('/api/chaos/auto', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (_data, payload) => {
      const lang = currentLang()
      toast.success(translate(lang, payload.enabled ? 'chaos.toast.autoOn' : 'chaos.toast.autoOff'), {
        description: translate(lang, payload.enabled ? 'chaos.toast.autoOnDesc' : 'chaos.toast.autoOffDesc'),
      })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'chaos.toast.autoFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** POST /api/incidents/{id}/resolve — on-call intervention. */
export function useResolveIncident() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (incidentId: string) =>
      api<unknown>(`/api/incidents/${encodeURIComponent(incidentId)}/resolve`, { method: 'POST' }),
    onSuccess: () => {
      const lang = currentLang()
      toast.success(translate(lang, 'res.toast.done'), {
        description: translate(lang, 'res.toast.doneDesc'),
      })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'res.toast.failed'), { description: e.message }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: DASHBOARD_KEY })
      void qc.invalidateQueries({ queryKey: ANALYTICS_KEY })
      void qc.invalidateQueries({ queryKey: INCIDENT_DETAIL_KEY })
    },
  })
}

/** POST /api/incidents/{id}/acknowledge — v2.5 on-call ownership (MTTA). */
export function useAcknowledgeIncident() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ incidentId, by }: { incidentId: string; by?: string }) =>
      api<unknown>(`/api/incidents/${encodeURIComponent(incidentId)}/acknowledge`, {
        method: 'POST',
        body: JSON.stringify(by && by.trim() ? { by: by.trim() } : {}),
      }),
    onSuccess: (_data, payload) => {
      toast.success(translate(currentLang(), 'ack.toast.done'), {
        description: translate(currentLang(), 'ack.toast.doneDesc', { who: payload.by?.trim() || 'On-call' }),
      })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'ack.toast.failed'), { description: e.message }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: DASHBOARD_KEY })
      void qc.invalidateQueries({ queryKey: ANALYTICS_KEY })
      void qc.invalidateQueries({ queryKey: INCIDENT_DETAIL_KEY })
    },
  })
}

/** POST /api/reports — generate a report PDF (kind × language). */
export function useGenerateReport() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: GenerateReportPayload) =>
      api<ReportDTO>('/api/reports', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (report) => {
      const lang = currentLang()
      toast.success(translate(lang, 'report.toast.done'), {
        description: translate(lang, 'report.toast.doneDesc', { name: report?.fileName ?? 'report.pdf' }),
      })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'report.toast.failed'), { description: e.message }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: DASHBOARD_KEY })
      void qc.invalidateQueries({ queryKey: ANALYTICS_KEY })
    },
  })
}

/** POST /api/reports/[id]/regenerate — rebuild from stored params . */
export function useRegenerateReport() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api<ReportDTO>(`/api/reports/${encodeURIComponent(id)}/regenerate`, { method: 'POST' }),
    onSuccess: (report) => {
      const lang = currentLang()
      toast.success(translate(lang, 'report.toast.regenerated'), {
        description: translate(lang, 'report.toast.doneDesc', { name: report?.fileName ?? 'report.pdf' }),
      })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'report.toast.failed'), { description: e.message }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: DASHBOARD_KEY })
    },
  })
}

/** POST /api/ai/postmortem — LLM post-mortem with rule-based fallback (labeled). */
export function usePostMortem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: PostMortemPayload) =>
      api<Partial<IncidentDTO> & { summary?: string; source?: IncidentDTO['aiSource'] }>('/api/ai/postmortem', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (res) => {
      const lang = currentLang()
      if (res?.source === 'heuristic') {
        toast.warning(translate(lang, 'pm.toast.heuristic'), {
          description: translate(lang, 'pm.toast.heuristicDesc'),
        })
      } else {
        toast.success(translate(lang, 'pm.toast.aiReady'), {
          description: translate(lang, 'pm.toast.aiReadyDesc'),
        })
      }
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'pm.toast.failed'), { description: e.message }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: DASHBOARD_KEY })
      void qc.invalidateQueries({ queryKey: ANALYTICS_KEY })
      void qc.invalidateQueries({ queryKey: INCIDENT_DETAIL_KEY })
    },
  })
}

/** Pull a summary string out of an unknown post-mortem response. */
export function extractPostMortemSummary(res: unknown): string | null {
  if (res && typeof res === 'object') {
    const r = res as { summary?: unknown; aiSummary?: unknown }
    if (typeof r.summary === 'string' && r.summary.trim()) return r.summary.trim()
    if (typeof r.aiSummary === 'string' && r.aiSummary.trim()) return r.aiSummary.trim()
  }
  return null
}

/** PUT /api/escalation — edit the fleet escalation policy (v2.6). */
export function useUpdateEscalationPolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: UpdateEscalationPayload) =>
      api<EscalationPolicyDTO>('/api/escalation', { method: 'PUT', body: JSON.stringify(payload) }),
    onSuccess: () => {
      const lang = currentLang()
      toast.success(translate(lang, 'esc.toast.saved'), {
        description: translate(lang, 'esc.toast.savedDesc'),
      })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'esc.toast.failed'), { description: e.message }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: DASHBOARD_KEY })
    },
  })
}

/** POST /api/maintenance — open a planned maintenance window (alerts suppressed). */
export function useCreateMaintenanceWindow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateMaintenanceWindowPayload) =>
      api<MaintenanceWindowDTO>('/api/maintenance', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (win) => {
      toast.success(translate(currentLang(), 'maint.toast.created'), {
        description: win?.reason,
      })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'maint.toast.createFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** POST /api/maintenance/[id]/cancel — end an active window early. */
export function useCancelMaintenanceWindow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api<MaintenanceWindowDTO>(`/api/maintenance/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(translate(currentLang(), 'maint.toast.cancelled'))
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'maint.toast.cancelFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/**
 * Toast on newly-arriving critical alerts. Skips the first snapshot so the
 * initial page load never spams toasts; caps at 3 toasts per poll cycle.
 */
export function useAlertToasts(alerts: AlertDTO[] | undefined) {
  const primed = useRef(false)
  const seen = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!alerts || alerts.length === 0) return
    if (!primed.current) {
      primed.current = true
      seen.current = new Set(alerts.map((a) => a.id))
      return
    }
    const fresh = alerts.filter((a) => !seen.current.has(a.id)).slice(0, 3)
    for (const a of fresh) {
      if (a.severity === 'critical') {
        toast.error(a.title, { description: a.message })
      }
    }
    seen.current = new Set(alerts.map((a) => a.id))
  }, [alerts])
}

// ── v2.2 alert governance ─────────────────────────────────────────────────────

/** POST /api/rules — create a policy rule. */
export function useCreateAlertRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateAlertRulePayload) =>
      api<AlertRuleDTO>('/api/rules', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (rule) => {
      toast.success(translate(currentLang(), 'gov.toast.ruleCreated'), { description: rule?.name })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'gov.toast.ruleCreateFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** POST /api/rules/[id]/toggle — enable/disable a rule. */
export function useToggleAlertRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<AlertRuleDTO>(`/api/rules/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) }),
    onSuccess: (rule) => {
      toast.success(translate(currentLang(), rule?.enabled ? 'gov.toast.ruleEnabled' : 'gov.toast.ruleDisabled'), {
        description: rule?.name,
      })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'gov.toast.ruleToggleFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** DELETE /api/rules/[id] — remove a rule. */
export function useDeleteAlertRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/api/rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast.success(translate(currentLang(), 'gov.toast.ruleDeleted')),
    onError: (e: Error) => toast.error(translate(currentLang(), 'gov.toast.ruleDeleteFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** POST /api/channels — create a notification channel. */
export function useCreateChannel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateChannelPayload) =>
      api<NotificationChannelDTO>('/api/channels', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (ch) => {
      toast.success(translate(currentLang(), 'gov.toast.channelCreated'), { description: ch?.name })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'gov.toast.channelCreateFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** POST /api/channels/[id]/toggle — enable/disable a channel. */
export function useToggleChannel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<NotificationChannelDTO>(`/api/channels/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) }),
    onSuccess: (ch) => {
      toast.success(translate(currentLang(), ch?.enabled ? 'gov.toast.channelEnabled' : 'gov.toast.channelDisabled'), {
        description: ch?.name,
      })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'gov.toast.channelToggleFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** POST /api/channels/[id]/test — fire a test delivery through a channel. */
export function useTestChannel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api<NotificationChannelDTO>(`/api/channels/${id}/test`, { method: 'POST' }),
    onSuccess: (ch) => {
      if (ch?.lastError) {
        toast.warning(translate(currentLang(), 'gov.toast.testFailed'), {
          description: `${ch.name}: ${ch.lastError}`,
        })
      } else {
        toast.success(translate(currentLang(), 'gov.toast.testSent'), { description: ch?.name })
      }
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'gov.toast.testFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** DELETE /api/channels/[id] — remove a channel. */
export function useDeleteChannel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/api/channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast.success(translate(currentLang(), 'gov.toast.channelDeleted')),
    onError: (e: Error) => toast.error(translate(currentLang(), 'gov.toast.channelDeleteFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** POST /api/oncall — add a rotation entry. */
export function useCreateOnCall() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateOnCallPayload) =>
      api<OnCallEntryDTO>('/api/oncall', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (entry) => {
      toast.success(translate(currentLang(), 'gov.toast.oncallAdded'), { description: entry?.engineerName })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'gov.toast.oncallAddFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** DELETE /api/oncall/[id] — remove a rotation entry. */
export function useDeleteOnCall() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/api/oncall/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast.success(translate(currentLang(), 'gov.toast.oncallRemoved')),
    onError: (e: Error) => toast.error(translate(currentLang(), 'gov.toast.oncallRemoveFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

// ── v2.4 report schedules ──────────────────────────────────────────────────

/** POST /api/schedules — create a cron-style report schedule. */
export function useCreateSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreateReportSchedulePayload) =>
      api<ReportScheduleDTO>('/api/schedules', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: (sched) => {
      toast.success(translate(currentLang(), 'sched.toast.created'), { description: sched?.label })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'sched.toast.createFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** POST /api/schedules/[id]/toggle — enable/disable a schedule. */
export function useToggleSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<ReportScheduleDTO>(`/api/schedules/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) }),
    onSuccess: (sched) => {
      toast.success(translate(currentLang(), sched?.enabled ? 'sched.toast.enabled' : 'sched.toast.disabled'), {
        description: sched?.label,
      })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'sched.toast.toggleFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** POST /api/schedules/[id]/run — fire a schedule's pipeline immediately. */
export function useRunSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api<ReportScheduleDTO>(`/api/schedules/${id}/run`, { method: 'POST' }),
    onSuccess: (sched) => {
      toast.success(translate(currentLang(), 'sched.toast.ran'), {
        description: sched ? `${sched.label} · ${sched.periodHours}h PDF` : undefined,
      })
    },
    onError: (e: Error) => toast.error(translate(currentLang(), 'sched.toast.runFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

/** DELETE /api/schedules/[id] — remove a schedule. */
export function useDeleteSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/api/schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast.success(translate(currentLang(), 'sched.toast.deleted')),
    onError: (e: Error) => toast.error(translate(currentLang(), 'sched.toast.deleteFailed'), { description: e.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: DASHBOARD_KEY }),
  })
}

export const CONTRACTS_KEY = ['sentinel', 'contracts'] as const

/**
 * GET /api/contracts — the contract-compliance snapshot for the current
 * Jalali window. Downtime accrues in minutes, not ticks: a 60 s refresh is
 * plenty and keeps the money page calm.
 */
export function useContracts(tenantId?: string | null) {
  return useQuery<ContractsSnapshotDTO>({
    queryKey: [...CONTRACTS_KEY, tenantId ?? 'all'],
    queryFn: () => api<ContractsSnapshotDTO>(`/api/contracts${withTenant(tenantId)}`),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: 1,
  })
}

/** Query-key prefix — invalidated by ack/resolve/post-mortem mutations. */
export const INCIDENT_DETAIL_KEY = ['sentinel', 'incident-detail'] as const

/** Query-key prefix — invalidated by engine-affecting mutations. */
export const SERVICE_DETAIL_KEY = ['sentinel', 'service-detail'] as const

/**
 * GET /api/services/[key] — the /services/[key] detail page payload:
 * live health + current-window contract row + recent incidents + evidence.
 * Health moves every engine tick; 30 s mirrors useIncidentDetail.
 */
export function useServiceDetail(key: string) {
  return useQuery<ServiceDetailDTO>({
    queryKey: [...SERVICE_DETAIL_KEY, key],
    queryFn: () => api<ServiceDetailDTO>(`/api/services/${encodeURIComponent(key)}`),
    enabled: key.length > 0,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  })
}

/**
 * GET /api/incidents/[id] — the /incidents/[id] detail page payload:
 * incident + its notifications (evidence) + same-service incidents (context).
 * An ongoing incident accrues duration and money every tick: 30 s keeps the
 * page honest without hammering the API; resolved incidents barely change.
 */
export function useIncidentDetail(id: string) {
  return useQuery<IncidentDetailDTO>({
    queryKey: [...INCIDENT_DETAIL_KEY, id],
    queryFn: () => api<IncidentDetailDTO>(`/api/incidents/${encodeURIComponent(id)}`),
    enabled: id.length > 0,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  })
}

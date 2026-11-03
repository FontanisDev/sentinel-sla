'use client'

// Sentinel-SLA — Maintenance windows panel (v2.1, engineer view).
// Planned-work windows: while ACTIVE, alert delivery for the covered scope is
// suppressed; incidents are still detected and recorded (SLA truth untouched).
// The panel shows active windows with live countdowns, lets on-call open a
// window (service or fleet-wide), and lists recent history.

import { useMemo, useState } from 'react'
import { CalendarClock, Loader2, ShieldOff, Wrench } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/format'
import type { MaintenanceWindowDTO, ServiceDTO } from '@/lib/types'
import { useCancelMaintenanceWindow, useCreateMaintenanceWindow } from '@/hooks/use-sentinel'
import { useLang } from '@/hooks/use-language'
import { EmptyState } from './empty-state'

const FLEET = '__fleet__'
const DURATIONS = ['15', '30', '60', '120', '360'] as const

/** Localized status chip for a maintenance window. */
function statusStyle(status: MaintenanceWindowDTO['status']): string {
  switch (status) {
    case 'active':
      return 'border-warn/30 bg-warn-subtle text-warn'
    case 'expired':
      return 'border-ok/25 bg-ok-subtle text-ok'
    default:
      return 'border-line bg-raised text-muted-foreground'
  }
}

function statusKey(status: MaintenanceWindowDTO['status']) {
  return status === 'active'
    ? 'maint.status.active'
    : status === 'expired'
      ? 'maint.status.expired'
      : 'maint.status.cancelled'
}

/** "12m 30s left" / "expires 14:32" — cheap re-render each poll cycle. */
function timeLeft(endAt: string): number {
  return Math.max(0, Math.floor((new Date(endAt).getTime() - Date.now()) / 1000))
}

function fmtCountdown(sec: number): string {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  return `${sec}s`
}

export function MaintenancePanel({
  services,
  windows,
  onChanged,
}: {
  services: ServiceDTO[]
  windows: MaintenanceWindowDTO[]
  /** Optional refresh hook — pages that own the windows fetch call it after
   *  mutations so their list stays honest without waiting for the next poll. */
  onChanged?: () => Promise<void> | void
}) {
  const [scope, setScope] = useState<string>(FLEET)
  const [reason, setReason] = useState('')
  const [durationMin, setDurationMin] = useState('30')
  const create = useCreateMaintenanceWindow()
  const cancel = useCancelMaintenanceWindow()
  const { t, name } = useLang()

  const active = useMemo(() => windows.filter((w) => w.status === 'active'), [windows])
  const history = useMemo(() => windows.filter((w) => w.status !== 'active'), [windows])

  const scopeLabel =
    scope === FLEET
      ? t('maint.fleet')
      : name(
          services.find((s) => s.id === scope)?.name ?? '',
          services.find((s) => s.id === scope)?.nameFa ?? null
        )

  const open = () => {
    const trimmed = reason.trim()
    if (trimmed.length < 3) return
    create.mutate(
      {
        serviceId: scope === FLEET ? null : scope,
        reason: trimmed,
        durationMin: Number(durationMin),
      },
      { onSettled: () => void onChanged?.() },
    )
    setReason('')
  }

  return (
    <Card className="sentinel-card-highlight gap-5 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wrench className="size-4 text-warn" aria-hidden="true" />
          {t('maint.title')}
          {active.length > 0 ? (
            <Badge variant="outline" className="gap-1 border-warn/30 bg-warn-subtle text-[10px] text-warn">
              <span className="size-1.5 animate-status-pulse rounded-full bg-warn" aria-hidden="true" />
              {t('maint.active')}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>{t('maint.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Active windows — highlighted strip */}
        {active.length > 0 ? (
          <div className="space-y-2">
            {active.map((w) => (
              <div
                key={w.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[6px] border border-warn/25 bg-warn/[0.07] bg-warn/[0.07] px-3.5 py-2.5"
              >
                <CalendarClock className="size-4 shrink-0 text-warn" aria-hidden="true" />
                <span className="text-sm font-medium">
                  {w.serviceName ?? t('maint.fleet')}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={w.reason}>
                  {w.reason}
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground" dir="ltr">
                  {t('maint.left', { t: fmtCountdown(timeLeft(w.endAt)) })}
                </span>
                {w.suppressedAlerts > 0 ? (
                  <Badge variant="outline" className="gap-1 border-line bg-raised text-[10px] text-muted-foreground">
                    <ShieldOff className="size-3" aria-hidden="true" />
                    {t('maint.suppressed', { n: w.suppressedAlerts })}
                  </Badge>
                ) : null}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 border-warn/30 px-2.5 text-[11px] text-warn hover:bg-warn dark:hover:bg-warn"
                      disabled={cancel.isPending && cancel.variables === w.id}
                      aria-label={t('maint.endEarly')}
                    >
                      {cancel.isPending && cancel.variables === w.id ? (
                        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                      ) : null}
                      {t('maint.endEarly')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('maint.endConfirmTitle')}</AlertDialogTitle>
                      <AlertDialogDescription>{t('maint.endConfirmDesc')}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('maint.cancel')}</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() =>
                          cancel.mutate(w.id, { onSettled: () => void onChanged?.() })
                        }
                      >
                        {t('maint.endEarly')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
          </div>
        ) : null}

        {/* Open a new window */}
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-end">
          <div className="space-y-1.5 lg:w-[220px]">
            <label htmlFor="maint-scope" className="text-[10px] font-medium tracking-wider text-muted-foreground">
              {t('maint.scope')}
            </label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger id="maint-scope" size="sm" className="h-9 w-full bg-surface-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FLEET}>{t('maint.fleet')}</SelectItem>
                {services.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {name(s.name, s.nameFa)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 space-y-1.5">
            <label htmlFor="maint-reason" className="text-[10px] font-medium tracking-wider text-muted-foreground">
              {t('maint.reason')}
            </label>
            <Input
              id="maint-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('maint.reasonPh')}
              maxLength={200}
              className="h-9 bg-surface-2"
            />
          </div>
          <div className="space-y-1.5 lg:w-[130px]">
            <label htmlFor="maint-duration" className="text-[10px] font-medium tracking-wider text-muted-foreground">
              {t('maint.duration')}
            </label>
            <Select value={durationMin} onValueChange={setDurationMin}>
              <SelectTrigger id="maint-duration" size="sm" className="h-9 w-full bg-surface-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DURATIONS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {t('maint.minutes', { n: d })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="h-9 gap-1.5 border-warn/30 bg-warn-subtle text-warn hover:bg-warn dark:hover:bg-warn sm:self-end"
                disabled={reason.trim().length < 3 || create.isPending}
              >
                {create.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Wrench className="size-4" aria-hidden="true" />
                )}
                {t('maint.open')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('maint.confirmTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('maint.confirmDesc', { scope: scopeLabel })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('maint.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={open}>{t('maint.open')}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {/* History */}
        {windows.length === 0 ? (
          <EmptyState
            icon={Wrench}
            title={t('maint.empty.title')}
            description={t('maint.empty.desc')}
            className="py-6"
          />
        ) : history.length > 0 ? (
          <ul className="space-y-1.5">
            {history.map((w) => (
              <li
                key={w.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-black/[0.05] dark:border-white/[0.05] px-3 py-2 sentinel-row-hover"
              >
                <span className="text-xs font-medium">{w.serviceName ?? t('maint.fleet')}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={w.reason}>
                  {w.reason}
                </span>
                {w.suppressedAlerts > 0 ? (
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {t('maint.suppressed', { n: w.suppressedAlerts })}
                  </span>
                ) : null}
                <span className="text-[10px] tabular-nums text-muted-foreground" dir="ltr">
                  {formatDateTime(w.endAt)}
                </span>
                <Badge variant="outline" className={cn('text-[10px]', statusStyle(w.status))}>
                  {t(statusKey(w.status))}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  )
}

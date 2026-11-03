'use client'

// Sentinel-SLA — report schedules card (v2.4, executive view).
//
// Cron-style executive digests: each row shows when the engine will fire the
// same PDF pipeline as the manual button (origin 'scheduled'). "Run now"
// exercises the full scheduler code path immediately — the engine's due-run
// and this button share one server function.

import { useState } from 'react'
import {
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  FileDown,
  History,
  Loader2,
  Play,
  Plus,
  Repeat,
  Timer,
  Trash2,
  XCircle,
} from 'lucide-react'
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
import { Switch } from '@/components/ui/switch'
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
import { formatClock, formatRelative } from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import {
  useCreateSchedule,
  useDeleteSchedule,
  useRunSchedule,
  useToggleSchedule,
} from '@/hooks/use-sentinel'
import type {
  ReportFrequency,
  ReportScheduleDTO,
  ScheduleRunDTO,
  TenantDTO,
} from '@/lib/types'
import { EmptyState } from './empty-state'
import type { TranslationKey } from '@/lib/i18n'

const FLEET = '__fleet__'
const DAYS = [0, 1, 2, 3, 4, 5, 6] as const
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1)
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const PERIODS = [1, 6, 24] as const

function dayKey(d: number): TranslationKey {
  return `gov.oncall.day.${d}` as TranslationKey
}

/** "08:00" — UTC hour label, LTR mono even inside RTL. */
function hourLabel(h: number): string {
  return `${String(h).padStart(2, '0')}:00`
}

// ── schedule row ────────────────────────────────────────────────────────────

function ScheduleRow({ schedule }: { schedule: ReportScheduleDTO }) {
  const { t, name } = useLang()
  const toggle = useToggleSchedule()
  const remove = useDeleteSchedule()
  const run = useRunSchedule()

  const freqIcon =
    schedule.frequency === 'weekly' ? (
      <Repeat className="size-3" aria-hidden="true" />
    ) : (
      <CalendarDays className="size-3" aria-hidden="true" />
    )

  // "Every Monday at 08:00" / "Day 1 of every month at 09:00" — LTR mono in RTL.
  const cadence =
    schedule.frequency === 'weekly'
      ? t('sched.every', { day: t(dayKey(schedule.dayOfWeek ?? 0)), time: hourLabel(schedule.hour) })
      : t('sched.monthlyAt', { day: String(schedule.dayOfMonth ?? 1), time: hourLabel(schedule.hour) })

  return (
    <li
      className={cn(
        'sentinel-row-hover flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[6px] border px-3.5 py-3 transition-colors',
        schedule.enabled
          ? 'border-black/[0.07] dark:border-white/[0.07] bg-surface-2'
          : 'border-black/[0.05] dark:border-white/[0.05] bg-black/[0.02] dark:bg-white/[0.02]',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="truncate">{schedule.label}</span>
          <Badge
            variant="outline"
            className="h-5 gap-1 border-info/25 border-info/25 bg-info-subtle px-1.5 text-[10px] text-info"
          >
            {freqIcon}
            {t(schedule.frequency === 'weekly' ? 'sched.frequency.weekly' : 'sched.frequency.monthly')}
          </Badge>
          {schedule.enabled ? null : (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-muted-foreground">
              {t('sched.paused')}
            </Badge>
          )}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span dir="ltr" className="font-mono tabular-nums">
            {cadence} {t('sched.utc')}
          </span>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center rounded-full border border-black/[0.08] dark:border-white/[0.08] bg-background px-1.5 py-px text-[9px] font-medium text-muted-foreground">
            {t(schedule.kind === 'statement' ? 'reports.kind.statement' : 'reports.kind.executive')}
          </span>
          <span className="inline-flex items-center rounded-full border border-black/[0.08] dark:border-white/[0.08] bg-background px-1.5 py-px text-[9px] font-medium text-muted-foreground">
            {schedule.language === 'fa' ? t('reports.lang.fa') : t('reports.lang.en')}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {schedule.tenantName
              ? name(schedule.tenantName, null)
              : t('sched.fleet')}
          </span>
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span className="text-muted-foreground">{t('sched.next')}:</span>
          {schedule.enabled && schedule.nextRunAt ? (
            <span dir="ltr" className="font-mono font-medium tabular-nums text-ok">
              {formatRelative(schedule.nextRunAt)}
            </span>
          ) : (
            <span className="text-muted-foreground">{t('sched.paused')}</span>
          )}
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{t('sched.last')}:</span>
          <span dir="ltr" className="font-mono tabular-nums text-muted-foreground">
            {schedule.lastRunAt ? formatClock(schedule.lastRunAt) : t('sched.never')}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => run.mutate(schedule.id)}
          disabled={run.isPending && run.variables === schedule.id}
          aria-label={`${t('sched.runNow')}: ${schedule.label}`}
        >
          {run.isPending && run.variables === schedule.id ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Play className="size-3.5" aria-hidden="true" />
          )}
          {run.isPending && run.variables === schedule.id ? t('sched.running') : t('sched.runNow')}
        </Button>
        <Switch
          checked={schedule.enabled}
          onCheckedChange={(checked) => toggle.mutate({ id: schedule.id, enabled: checked })}
          aria-label={`${t('sched.title')}: ${schedule.label}`}
        />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="size-8 text-muted-foreground hover:text-crit dark:hover:text-crit"
              aria-label={t('sched.deleteAria')}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent dir="auto">
            <AlertDialogHeader>
              <AlertDialogTitle>{t('sched.delete')}</AlertDialogTitle>
              <AlertDialogDescription>{t('sched.deleteDesc')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('maint.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-crit text-white hover:bg-crit bg-crit dark:hover:bg-crit"
                onClick={() => remove.mutate(schedule.id)}
              >
                {t('sched.delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </li>
  )
}

// ── create form ─────────────────────────────────────────────────────────────

function CreateScheduleForm({ tenants }: { tenants: TenantDTO[] }) {
  const { t, name } = useLang()
  const create = useCreateSchedule()

  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [frequency, setFrequency] = useState<ReportFrequency>('weekly')
  const [dayOfWeek, setDayOfWeek] = useState('1')
  const [dayOfMonth, setDayOfMonth] = useState('1')
  const [hour, setHour] = useState('8')
  const [period, setPeriod] = useState('24')
  const [scope, setScope] = useState<string>(FLEET)
  // which template a schedule produces, in which language.
  const [kind, setKind] = useState<'executive' | 'statement'>('executive')
  const [lang, setLang] = useState<'en' | 'fa'>('en')

  const submit = () => {
    const trimmed = label.trim()
    if (trimmed.length < 3) return
    if (kind === 'statement' && scope === FLEET) return // server 400s; stay honest client-side
    create.mutate(
      {
        label: trimmed,
        frequency,
        ...(frequency === 'weekly'
          ? { dayOfWeek: Number(dayOfWeek) }
          : { dayOfMonth: Number(dayOfMonth) }),
        hour: Number(hour),
        periodHours: Number(period) as 1 | 6 | 24,
        kind,
        language: lang,
        ...(scope === FLEET ? {} : { tenantId: scope }),
      },
      {
        onSuccess: () => {
          setLabel('')
          setOpen(false)
        },
      },
    )
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" aria-hidden="true" />
        {t('sched.create')}
      </Button>
    )
  }

  return (
    <div className="space-y-3 rounded-[6px] border border-black/[0.07] dark:border-white/[0.07] bg-surface-2 p-3.5">
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        <label className="grid gap-1 text-[11px] font-medium text-muted-foreground sm:col-span-2 lg:col-span-3">
          {t('sched.label')}
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('sched.labelPh')}
            maxLength={80}
            className="h-9 bg-background text-sm"
          />
        </label>
        <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
          {t('sched.frequency')}
          <Select value={frequency} onValueChange={(v) => setFrequency(v as ReportFrequency)}>
            <SelectTrigger className="h-9 bg-background text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">{t('sched.frequency.weekly')}</SelectItem>
              <SelectItem value="monthly">{t('sched.frequency.monthly')}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {frequency === 'weekly' ? (
          <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
            {t('sched.dayOfWeek')}
            <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
              <SelectTrigger className="h-9 bg-background text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {t(dayKey(d))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        ) : (
          <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
            {t('sched.dayOfMonth')}
            <Select value={dayOfMonth} onValueChange={setDayOfMonth}>
              <SelectTrigger className="h-9 bg-background text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {MONTH_DAYS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
        <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
          {t('sched.hour')}
          <Select value={hour} onValueChange={setHour}>
            <SelectTrigger className="h-9 bg-background text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {HOURS.map((h) => (
                <SelectItem key={h} value={String(h)}>
                  <span dir="ltr" className="font-mono tabular-nums">{hourLabel(h)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
          {t('sched.period')}
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="h-9 bg-background text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => (
                <SelectItem key={p} value={String(p)}>
                  <span dir="ltr" className="font-mono tabular-nums">{p}h</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
          {t('sched.kindLabel')}
          <Select value={kind} onValueChange={(v) => setKind(v as 'executive' | 'statement')}>
            <SelectTrigger className="h-9 bg-background text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="executive">{t('reports.kind.executive')}</SelectItem>
              <SelectItem value="statement">{t('reports.kind.statement')}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
          {t('sched.langLabel')}
          <Select value={lang} onValueChange={(v) => setLang(v as 'en' | 'fa')}>
            <SelectTrigger className="h-9 bg-background text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">{t('reports.lang.en')}</SelectItem>
              <SelectItem value="fa">{t('reports.lang.fa')}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
          {t('sched.scope')}
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger className="h-9 bg-background text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FLEET}>{t('sched.fleet')}</SelectItem>
              {tenants.map((tenant) => (
                <SelectItem key={tenant.id} value={tenant.id}>
                  {name(tenant.name, tenant.nameFa)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setOpen(false)}>
          {t('maint.cancel')}
        </Button>
        <Button
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={submit}
          disabled={create.isPending || label.trim().length < 3 || (kind === 'statement' && scope === FLEET)}
          title={kind === 'statement' && scope === FLEET ? t('sched.kindNeedsTenant') : undefined}
        >
          {create.isPending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Plus className="size-3.5" aria-hidden="true" />
          )}
          {create.isPending ? t('sched.creating') : t('sched.create')}
        </Button>
      </div>
    </div>
  )
}

// ── v2.5: run history (audit trail) ──────────────────────────────────────────

function formatRunDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function RunHistory({ runs }: { runs: ScheduleRunDTO[] }) {
  const { t } = useLang()
  if (runs.length === 0) return null

  return (
    <div className="rounded-[6px] border bg-black/[0.02] dark:bg-white/[0.02] p-3.5">
      <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-muted-foreground">
        <History className="size-3" aria-hidden="true" />
        {t('sched.runs.title')}
        <span className="ms-auto font-normal">
          {t('sched.runs.policy', { n: 30 })}
        </span>
      </p>
      <ul className="sentinel-scroll-native mt-2.5 max-h-56 space-y-1.5 overflow-y-auto pe-1" aria-label={t('sched.runs.title')} tabIndex={0}>
        {runs.map((run) => (
          <li
            key={run.id}
            className="sentinel-row-hover flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg px-2.5 py-2 transition-colors"
          >
            <span className="shrink-0" title={run.success ? t('sched.runs.ok') : t('sched.runs.failed')}>
              {run.success ? (
                <CheckCircle2 className="size-3.5 text-ok" aria-hidden="true" />
              ) : (
                <XCircle className="size-3.5 text-crit" aria-hidden="true" />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium" title={run.error ?? undefined}>
              {run.label}
            </span>
            <Badge
              variant="outline"
              className={cn(
                'h-5 shrink-0 px-1.5 text-[9px]',
                run.trigger === 'manual'
                  ? 'border-info/25 bg-info text-info border-info/25 bg-info text-info'
                  : 'border-black/10 text-muted-foreground dark:border-white/10',
              )}
            >
              {t(run.trigger === 'manual' ? 'sched.runs.manual' : 'sched.runs.due')}
            </Badge>
            {run.reportId ? (
              <a
                href={`/api/reports/${encodeURIComponent(run.reportId)}/download`}
                download
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-black/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 dark:hover:bg-white/[0.05]"
                aria-label={t('sched.runs.downloadAria', { name: run.fileName ?? run.reportId })}
                title={t('sched.runs.downloadAria', { name: run.fileName ?? run.reportId })}
              >
                <FileDown className="size-3.5" aria-hidden="true" />
              </a>
            ) : null}
            <span
              className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground"
              dir="ltr"
              title={run.error ?? undefined}
            >
              <Timer className="me-0.5 inline size-3 align-[-1px]" aria-hidden="true" />
              {formatRunDuration(run.durationMs)}
            </span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground" dir="ltr">
              {formatClock(run.startedAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── card ────────────────────────────────────────────────────────────────────

export function SchedulesCard({
  schedules,
  runs,
  tenants,
}: {
  schedules: ReportScheduleDTO[]
  /** v2.5: latest schedule firings (audit trail, newest first) */
  runs?: ScheduleRunDTO[]
  tenants: TenantDTO[]
}) {
  const { t } = useLang()

  return (
    <Card className="sentinel-card-highlight gap-5 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="size-4 text-info" aria-hidden="true" />
          {t('sched.title')}
          {schedules.length > 0 ? (
            <Badge variant="outline" className="border-line bg-raised text-[10px] text-muted-foreground">
              {schedules.filter((s) => s.enabled).length}/{schedules.length}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>{t('sched.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {schedules.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title={t('sched.empty.title')}
            description={t('sched.empty.desc')}
          />
        ) : (
          <ul className="space-y-2.5">
            {schedules.map((s) => (
              <ScheduleRow key={s.id} schedule={s} />
            ))}
          </ul>
        )}
        <CreateScheduleForm tenants={tenants} />
        <RunHistory runs={runs ?? []} />
      </CardContent>
    </Card>
  )
}

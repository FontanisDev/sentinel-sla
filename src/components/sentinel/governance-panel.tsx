'use client'

// Sentinel-SLA — Alert governance panel (v2.2, engineer view; v2.6 adds card 4).
// Four cooperating cards:
//   1. Alert policy rules — threshold policies the engine evaluates every ~5s
//      (independent of probe detection), with per-rule cooldown.
//   2. Notification channels — delivery endpoints with per-channel counters
//      and health (the paging pipeline is itself monitored).
//   3. On-call rotation — who carries the pager, with a live "on duty now" strip.
//   4. Escalation policy — the ladder that pages the next tier when a detected
//      incident outlives the timeout unacknowledged (v2.6).

import { useMemo, useState } from 'react'
import {
  BellRing,
  CalendarClock,
  Loader2,
  Megaphone,
  Plus,
  Send,
  TriangleAlert,
  Trash2,
  UserPlus,
  UsersRound,
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
import { formatClock } from '@/lib/format'
import type {
  AlertMetric,
  AlertOperator,
  AlertRuleDTO,
  ChannelKind,
  EscalationPolicyDTO,
  NotificationChannelDTO,
  OnCallEntryDTO,
  RuleAudience,
  ServiceDTO,
} from '@/lib/types'
import {
  useCreateAlertRule,
  useCreateChannel,
  useCreateOnCall,
  useDeleteAlertRule,
  useDeleteChannel,
  useDeleteOnCall,
  useTestChannel,
  useToggleAlertRule,
  useToggleChannel,
  useUpdateEscalationPolicy,
} from '@/hooks/use-sentinel'
import { useLang } from '@/hooks/use-language'
import { EmptyState } from './empty-state'
import type { TranslationKey } from '@/lib/i18n'

const FLEET = '__fleet__'
const METRICS: AlertMetric[] = ['uptime', 'errorRate', 'latencyMs', 'throughput']
const KINDS: ChannelKind[] = ['telegram', 'webhook', 'email']
const DAYS = [0, 1, 2, 3, 4, 5, 6] as const

function metricKey(m: AlertMetric): TranslationKey {
  return `gov.rules.metric.${m}` as TranslationKey
}
function operatorKey(o: AlertOperator): TranslationKey {
  return `gov.rules.operator.${o}` as TranslationKey
}
function audienceKey(a: RuleAudience): TranslationKey {
  return `gov.rules.audience.${a}` as TranslationKey
}
function dayKey(d: number): TranslationKey {
  return `gov.oncall.day.${d}` as TranslationKey
}

/** Pretty-print a threshold according to metric semantics. */
function prettyThreshold(metric: AlertMetric, v: number): string {
  if (metric === 'uptime') return `${(v * 100).toFixed(2)}%`
  if (metric === 'errorRate') return `${(v * 100).toFixed(1)}%`
  return Math.round(v).toLocaleString('en-US')
}

function fmtMinuteOfDay(m: number): string {
  const mm = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`
}

// ── 1. Rules ────────────────────────────────────────────────────────────────

function RulesCard({ services, rules }: { services: ServiceDTO[]; rules: AlertRuleDTO[] }) {
  const { t, name } = useLang()
  const create = useCreateAlertRule()
  const toggle = useToggleAlertRule()
  const remove = useDeleteAlertRule()

  const [open, setOpen] = useState(false)
  const [rName, setRName] = useState('')
  const [scope, setScope] = useState<string>(FLEET)
  const [metric, setMetric] = useState<AlertMetric>('uptime')
  const [operator, setOperator] = useState<AlertOperator>('lt')
  const [threshold, setThreshold] = useState('0.999')
  const [severity, setSeverity] = useState<'critical' | 'warning'>('warning')
  const [audience, setAudience] = useState<RuleAudience>('technical')
  const [cooldown, setCooldown] = useState('15')

  const submit = () => {
    const trimmed = rName.trim()
    if (trimmed.length < 3) return
    create.mutate(
      {
        name: trimmed,
        serviceId: scope === FLEET ? null : scope,
        metric,
        operator,
        threshold: Number(threshold),
        severity,
        audience,
        cooldownMin: Math.max(1, Math.min(1440, Number(cooldown) || 15)),
      },
      {
        onSuccess: () => {
          setRName('')
          setOpen(false)
        },
      },
    )
  }

  return (
    <Card className="sentinel-card-highlight gap-5 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="size-4 text-info" aria-hidden="true" />
          {t('gov.rules.title')}
          {rules.length > 0 ? (
            <Badge variant="outline" className="border-line bg-raised text-[10px] text-muted-foreground">
              {rules.filter((r) => r.enabled).length}/{rules.length}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>{t('gov.rules.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {rules.length === 0 ? (
          <EmptyState icon={BellRing} title={t('gov.rules.empty.title')} description={t('gov.rules.empty.desc')} />
        ) : (
          <ul className="space-y-2.5">
            {rules.map((r) => (
              <li
                key={r.id}
                className={cn(
                  'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[6px] border px-3.5 py-3 transition-colors',
                  r.enabled
                    ? 'border-black/[0.07] dark:border-white/[0.07] bg-surface-2'
                    : 'border-black/[0.05] dark:border-white/[0.05] bg-black/[0.02] dark:bg-white/[0.02]',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="truncate">{r.name}</span>
                    {r.violatedNow ? (
                      <Badge
                        variant="outline"
                        className="h-5 gap-1.5 border-crit/25 border-crit/25 bg-crit-subtle px-1.5 text-[10px] text-crit"
                      >
                        <span className="size-1.5 animate-status-pulse rounded-full bg-crit" aria-hidden="true" />
                        {t('gov.rules.violatingNow')}
                      </Badge>
                    ) : null}
                    <Badge
                      variant="outline"
                      className={cn(
                        'h-5 px-1.5 text-[10px]',
                        r.severity === 'critical'
                          ? 'border-crit/30 bg-crit-subtle text-crit'
                          : 'border-warn/30 bg-warn-subtle text-warn',
                      )}
                    >
                      {r.severity === 'critical' ? t('severity.critical') : t('severity.warning')}
                    </Badge>
                    <Badge variant="outline" className="h-5 border-line bg-raised px-1.5 text-[10px] text-muted-foreground">
                      {t(audienceKey(r.audience))}
                    </Badge>
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span dir="ltr" className="font-mono tabular-nums">
                      {t(metricKey(r.metric))} {t(operatorKey(r.operator))}{' '}
                      {prettyThreshold(r.metric, r.threshold)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{r.serviceName ? name(r.serviceName, null) : t('gov.rules.fleetScope')}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {r.timesFired > 0
                        ? t('gov.rules.fired', { n: r.timesFired }) +
                          (r.lastFiredAt ? ` — ${t('gov.rules.lastFired', { t: formatClock(r.lastFiredAt) })}` : '')
                        : t('gov.rules.never')}
                    </span>
                  </p>
                  {r.violatedNow && r.measuredValue !== null ? (
                    <p
                      className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-medium text-crit"
                      dir="ltr"
                    >
                      <span className="font-mono tabular-nums">
                        {t('gov.rules.measured', {
                          v: prettyThreshold(r.metric, r.measuredValue),
                        })}
                      </span>
                      {r.violatedServiceName ? (
                        <>
                          <span aria-hidden="true">—</span>
                          <span>{r.violatedServiceName}</span>
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={r.enabled}
                    onCheckedChange={(checked) => toggle.mutate({ id: r.id, enabled: checked })}
                    disabled={toggle.isPending && toggle.variables?.id === r.id}
                    aria-label={`${t('gov.rules.title')}: ${r.name}`}
                  />
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-7 p-0 text-muted-foreground hover:text-crit dark:hover:text-crit"
                        aria-label={t('gov.rules.deleteConfirmTitle')}
                      >
                        {remove.isPending && remove.variables === r.id ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        )}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('gov.rules.deleteConfirmTitle')}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t('gov.rules.deleteConfirmDesc')} — «{r.name}»
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('maint.cancel')}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => remove.mutate(r.id)}>
                          {t('gov.rules.deleteConfirmTitle')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Create-rule form */}
        {open ? (
          <div className="space-y-3 rounded-[6px] border border-info/25 border-info/25 bg-info/[0.04] bg-info/[0.04] p-3.5">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
              <div className="col-span-2 space-y-1.5 sm:col-span-3 lg:col-span-2">
                <label htmlFor="rule-name" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.rules.name')}
                </label>
                <Input
                  id="rule-name"
                  value={rName}
                  onChange={(e) => setRName(e.target.value)}
                  placeholder={t('gov.rules.namePh')}
                  maxLength={80}
                  className="h-9 bg-surface-2"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rule-scope" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.rules.scope')}
                </label>
                <Select value={scope} onValueChange={setScope}>
                  <SelectTrigger id="rule-scope" size="sm" className="h-9 w-full bg-surface-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={FLEET}>{t('gov.rules.fleet')}</SelectItem>
                    {services.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {name(s.name, s.nameFa)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rule-metric" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.rules.metric')}
                </label>
                <Select value={metric} onValueChange={(v) => setMetric(v as AlertMetric)}>
                  <SelectTrigger id="rule-metric" size="sm" className="h-9 w-full bg-surface-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METRICS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {t(metricKey(m))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rule-op" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.rules.operator')}
                </label>
                <Select value={operator} onValueChange={(v) => setOperator(v as AlertOperator)}>
                  <SelectTrigger id="rule-op" size="sm" className="h-9 w-full bg-surface-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lt">{t('gov.rules.operator.lt')}</SelectItem>
                    <SelectItem value="gt">{t('gov.rules.operator.gt')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rule-threshold" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.rules.threshold')}
                </label>
                <Input
                  id="rule-threshold"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  inputMode="decimal"
                  dir="ltr"
                  className="h-9 bg-surface-2 font-mono tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rule-sev" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.rules.severity')}
                </label>
                <Select value={severity} onValueChange={(v) => setSeverity(v as 'critical' | 'warning')}>
                  <SelectTrigger id="rule-sev" size="sm" className="h-9 w-full bg-surface-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="warning">{t('severity.warning')}</SelectItem>
                    <SelectItem value="critical">{t('severity.critical')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rule-aud" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.rules.audience')}
                </label>
                <Select value={audience} onValueChange={(v) => setAudience(v as RuleAudience)}>
                  <SelectTrigger id="rule-aud" size="sm" className="h-9 w-full bg-surface-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="technical">{t('gov.rules.audience.technical')}</SelectItem>
                    <SelectItem value="executive">{t('gov.rules.audience.executive')}</SelectItem>
                    <SelectItem value="both">{t('gov.rules.audience.both')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="rule-cooldown" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.rules.cooldown')}
                </label>
                <Input
                  id="rule-cooldown"
                  value={cooldown}
                  onChange={(e) => setCooldown(e.target.value)}
                  inputMode="numeric"
                  dir="ltr"
                  className="h-9 bg-surface-2 font-mono tabular-nums"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setOpen(false)}>
                {t('maint.cancel')}
              </Button>
              <Button size="sm" className="h-8 gap-1.5" onClick={submit} disabled={create.isPending || rName.trim().length < 3}>
                {create.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Plus className="size-3.5" aria-hidden="true" />}
                {t('gov.rules.create')}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="h-8 gap-1.5 border-dashed" onClick={() => setOpen(true)}>
            <Plus className="size-3.5" aria-hidden="true" />
            {t('gov.rules.create')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// ── 2. Channels ─────────────────────────────────────────────────────────────

const KIND_ICON: Record<ChannelKind, { icon: typeof Megaphone; tone: string }> = {
  telegram: { icon: Send, tone: 'text-info' },
  bale: { icon: Send, tone: 'text-info' },
  webhook: { icon: Megaphone, tone: 'text-ok' },
  email: { icon: Send, tone: 'text-warn' },
  mattermost: { icon: Megaphone, tone: 'text-ok' },
  jira: { icon: Megaphone, tone: 'text-warn' },
  redmine: { icon: Megaphone, tone: 'text-warn' },
}

function channelStatusChip(status: NotificationChannelDTO['status']): { cls: string; key: TranslationKey; dot: string } {
  switch (status) {
    case 'healthy':
      return {
        cls: 'border-ok/25 bg-ok-subtle text-ok',
        key: 'gov.channels.healthy',
        dot: 'bg-ok',
      }
    case 'degraded':
      return {
        cls: 'border-crit/30 bg-crit-subtle text-crit',
        key: 'gov.channels.degraded',
        dot: 'bg-crit',
      }
    default:
      return {
        cls: 'border-line bg-raised text-muted-foreground',
        key: 'gov.channels.disabled',
        dot: 'bg-muted-foreground',
      }
  }
}

function ChannelsCard({ channels }: { channels: NotificationChannelDTO[] }) {
  const { t } = useLang()
  const create = useCreateChannel()
  const toggle = useToggleChannel()
  const test = useTestChannel()
  const remove = useDeleteChannel()

  const [open, setOpen] = useState(false)
  const [cName, setCName] = useState('')
  const [kind, setKind] = useState<ChannelKind>('telegram')
  const [target, setTarget] = useState('')
  const [audience, setAudience] = useState<RuleAudience>('technical')

  const submit = () => {
    const trimmedName = cName.trim()
    const trimmedTarget = target.trim()
    if (trimmedName.length < 3 || trimmedTarget.length < 3) return
    create.mutate(
      { name: trimmedName, kind, target: trimmedTarget, audience },
      {
        onSuccess: () => {
          setCName('')
          setTarget('')
          setOpen(false)
        },
      },
    )
  }

  return (
    <Card className="sentinel-card-highlight gap-5 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Megaphone className="size-4 text-ok" aria-hidden="true" />
          {t('gov.channels.title')}
        </CardTitle>
        <CardDescription>{t('gov.channels.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {channels.length === 0 ? (
          <EmptyState icon={Megaphone} title={t('gov.channels.empty.title')} description={t('gov.channels.empty.desc')} />
        ) : (
          <ul className="space-y-2.5">
            {channels.map((c) => {
              const chip = channelStatusChip(c.status)
              const Icon = KIND_ICON[c.kind].icon
              return (
                <li
                  key={c.id}
                  className={cn(
                    'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[6px] border px-3.5 py-3 transition-colors',
                    c.enabled
                      ? 'border-black/[0.07] dark:border-white/[0.07] bg-surface-2'
                      : 'border-black/[0.05] dark:border-white/[0.05] bg-black/[0.02] dark:bg-white/[0.02]',
                  )}
                >
                  <Icon className={cn('size-4 shrink-0', KIND_ICON[c.kind].tone)} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="truncate">{c.name}</span>
                      <Badge variant="outline" className={cn('gap-1 h-5 px-1.5 text-[10px]', chip.cls)}>
                        <span className={cn('size-1.5 rounded-full', chip.dot)} aria-hidden="true" />
                        {t(chip.key)}
                      </Badge>
                      <Badge variant="outline" className="h-5 border-line bg-raised px-1.5 text-[10px] text-muted-foreground">
                        {t(audienceKey(c.audience))}
                      </Badge>
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                      <span dir="ltr" className="max-w-[240px] truncate font-mono">{c.target}</span>
                      <span aria-hidden="true">·</span>
                      <span>{t('gov.channels.delivered', { n: c.deliveredCount })}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {c.lastDeliveryAt
                          ? t('gov.channels.lastAt', { t: formatClock(c.lastDeliveryAt) })
                          : t('gov.channels.never')}
                      </span>
                    </p>
                    {c.lastError ? (
                      <p className="mt-1 text-[11px] text-crit" dir="ltr">{c.lastError}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 px-2.5 text-[11px]"
                      onClick={() => test.mutate(c.id)}
                      disabled={test.isPending && test.variables === c.id}
                    >
                      {test.isPending && test.variables === c.id ? (
                        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                      ) : null}
                      {t('gov.channels.test')}
                    </Button>
                    <Switch
                      checked={c.enabled}
                      onCheckedChange={(checked) => toggle.mutate({ id: c.id, enabled: checked })}
                      disabled={toggle.isPending && toggle.variables?.id === c.id}
                      aria-label={`${t('gov.channels.title')}: ${c.name}`}
                    />
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-7 p-0 text-muted-foreground hover:text-crit dark:hover:text-crit"
                          aria-label={t('gov.channels.deleteConfirmTitle')}
                        >
                          {remove.isPending && remove.variables === c.id ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          )}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t('gov.channels.deleteConfirmTitle')}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t('gov.channels.deleteConfirmDesc')} — «{c.name}»
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('maint.cancel')}</AlertDialogCancel>
                          <AlertDialogAction onClick={() => remove.mutate(c.id)}>
                            {t('gov.channels.deleteConfirmTitle')}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {open ? (
          <div className="space-y-3 rounded-[6px] border border-ok/20 bg-ok/[0.04] bg-ok/[0.04] p-3.5">
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              <div className="space-y-1.5">
                <label htmlFor="ch-name" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.channels.name')}
                </label>
                <Input
                  id="ch-name"
                  value={cName}
                  onChange={(e) => setCName(e.target.value)}
                  placeholder={t('gov.channels.namePh')}
                  maxLength={60}
                  className="h-9 bg-surface-2"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="ch-kind" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.channels.kind')}
                </label>
                <Select value={kind} onValueChange={(v) => setKind(v as ChannelKind)}>
                  <SelectTrigger id="ch-kind" size="sm" className="h-9 w-full bg-surface-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {t(`gov.channels.kind.${k}` as TranslationKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="ch-target" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.channels.target')}
                </label>
                <Input
                  id="ch-target"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder={t(`gov.channels.targetPh.${kind}` as TranslationKey)}
                  maxLength={500}
                  dir="ltr"
                  className="h-9 bg-surface-2 font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="ch-aud" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.rules.audience')}
                </label>
                <Select value={audience} onValueChange={(v) => setAudience(v as RuleAudience)}>
                  <SelectTrigger id="ch-aud" size="sm" className="h-9 w-full bg-surface-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="technical">{t('gov.rules.audience.technical')}</SelectItem>
                    <SelectItem value="executive">{t('gov.rules.audience.executive')}</SelectItem>
                    <SelectItem value="both">{t('gov.rules.audience.both')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setOpen(false)}>
                {t('maint.cancel')}
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1.5"
                onClick={submit}
                disabled={create.isPending || cName.trim().length < 3 || target.trim().length < 3}
              >
                {create.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Plus className="size-3.5" aria-hidden="true" />}
                {t('gov.channels.create')}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="h-8 gap-1.5 border-dashed" onClick={() => setOpen(true)}>
            <Plus className="size-3.5" aria-hidden="true" />
            {t('gov.channels.create')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// ── 3. On-call ───────────────────────────────────────────────────────────────

function OnCallCard({ onCall }: { onCall: OnCallEntryDTO[] }) {
  const { t } = useLang()
  const create = useCreateOnCall()
  const remove = useDeleteOnCall()

  const [open, setOpen] = useState(false)
  const [eName, setEName] = useState('')
  const [role, setRole] = useState('Primary')
  const [handle, setHandle] = useState('')
  const [day, setDay] = useState<number>(new Date().getDay())
  const [from, setFrom] = useState('09:00')
  const [to, setTo] = useState('18:00')

  const activeNow = useMemo(() => onCall.filter((o) => o.active), [onCall])

  const submit = () => {
    const parse = (s: string): number => {
      const [h, m] = s.split(':').map((x) => Number(x) || 0)
      return Math.min(1439, Math.max(0, h * 60 + m))
    }
    const trimmed = eName.trim()
    if (trimmed.length < 3 || handle.trim().length < 3) return
    create.mutate(
      {
        engineerName: trimmed,
        role: role.trim().length >= 2 ? role.trim() : 'Primary',
        handle: handle.trim(),
        dayOfWeek: day,
        startMinute: parse(from),
        endMinute: Math.max(1, parse(to) === 0 ? 1440 : parse(to)),
      },
      {
        onSuccess: () => {
          setEName('')
          setHandle('')
          setOpen(false)
        },
      },
    )
  }

  return (
    <Card className="sentinel-card-highlight gap-5 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="size-4 text-warn" aria-hidden="true" />
          {t('gov.oncall.title')}
          {activeNow.length > 0 ? (
            <Badge variant="outline" className="gap-1 border-ok/25 bg-ok-subtle text-[10px] text-ok">
              <span className="size-1.5 animate-status-pulse rounded-full bg-ok" aria-hidden="true" />
              {activeNow.length}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>{t('gov.oncall.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* On duty now — highlighted strip */}
        {onCall.length > 0 ? (
          <div className="space-y-2">
            <p className="text-[10px] font-medium tracking-wider text-muted-foreground">{t('gov.oncall.activeNow')}</p>
            {activeNow.length === 0 ? (
              <p className="rounded-[6px] border border-crit/25 bg-crit/[0.06] bg-crit/[0.06] px-3.5 py-2.5 text-xs text-crit">
                {t('gov.exec.nobody')}
              </p>
            ) : (
              activeNow.map((o) => (
                <div
                  key={o.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[6px] border border-ok/25 bg-ok/[0.07] bg-ok/[0.07] px-3.5 py-2.5"
                >
                  <span className="text-sm font-medium">{o.engineerName}</span>
                  <Badge variant="outline" className="h-5 border-line bg-raised px-1.5 text-[10px] text-muted-foreground">
                    {o.role}
                  </Badge>
                  <span dir="ltr" className="font-mono text-[11px] text-muted-foreground">{o.handle}</span>
                  <span className="ms-auto text-[11px] tabular-nums text-muted-foreground" dir="ltr">
                    {fmtMinuteOfDay(o.startMinute)}–{fmtMinuteOfDay(o.endMinute)}
                  </span>
                </div>
              ))
            )}
          </div>
        ) : null}

        {/* Weekly rotation */}
        {onCall.length === 0 ? (
          <EmptyState icon={UsersRound} title={t('gov.oncall.empty')} description="" />
        ) : (
          <div className="space-y-2">
            <p className="text-[10px] font-medium tracking-wider text-muted-foreground">{t('gov.oncall.week')}</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {onCall.map((o) => (
                <li
                  key={o.id}
                  className={cn(
                    'group flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-[6px] border px-3.5 py-2.5 transition-colors',
                    o.active
                      ? 'border-ok/25 bg-ok/[0.06] bg-ok/[0.06]'
                      : 'bg-surface-2',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="truncate">{o.engineerName}</span>
                      {o.active ? (
                        <Badge variant="outline" className="h-5 border-ok/25 bg-ok-subtle px-1.5 text-[10px] text-ok">
                          {t('gov.oncall.active')}
                        </Badge>
                      ) : null}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>{t(dayKey(o.dayOfWeek))}</span>
                      <span dir="ltr" className="font-mono tabular-nums">
                        {fmtMinuteOfDay(o.startMinute)}–{fmtMinuteOfDay(o.endMinute)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span dir="ltr" className="font-mono">{o.handle}</span>
                    </p>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-7 p-0 text-muted-foreground opacity-60 transition-opacity hover:text-crit dark:hover:text-crit group-hover:opacity-100"
                        aria-label={t('gov.oncall.deleteConfirmTitle')}
                      >
                        {remove.isPending && remove.variables === o.id ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        )}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('gov.oncall.deleteConfirmTitle')}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t('gov.oncall.deleteConfirmDesc')} — «{o.engineerName}»
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('maint.cancel')}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => remove.mutate(o.id)}>
                          {t('gov.oncall.deleteConfirmTitle')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </li>
              ))}
            </ul>
          </div>
        )}

        {open ? (
          <div className="space-y-3 rounded-[6px] border border-warn/25 border-warn/25 bg-warn/[0.04] bg-warn/[0.04] p-3.5">
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
              <div className="space-y-1.5">
                <label htmlFor="oc-name" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.oncall.engineer')}
                </label>
                <Input
                  id="oc-name"
                  value={eName}
                  onChange={(e) => setEName(e.target.value)}
                  placeholder={t('gov.oncall.engineerPh')}
                  maxLength={60}
                  className="h-9 bg-surface-2"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="oc-role" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.oncall.role')}
                </label>
                <Input
                  id="oc-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder={t('gov.oncall.rolePh')}
                  maxLength={40}
                  className="h-9 bg-surface-2"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="oc-handle" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.oncall.handle')}
                </label>
                <Input
                  id="oc-handle"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  placeholder={t('gov.oncall.handlePh')}
                  maxLength={80}
                  dir="ltr"
                  className="h-9 bg-surface-2 font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="oc-day" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.oncall.day')}
                </label>
                <Select value={String(day)} onValueChange={(v) => setDay(Number(v))}>
                  <SelectTrigger id="oc-day" size="sm" className="h-9 w-full bg-surface-2">
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
              </div>
              <div className="space-y-1.5">
                <label htmlFor="oc-from" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.oncall.from')}
                </label>
                <Input
                  id="oc-from"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  placeholder="09:00"
                  dir="ltr"
                  className="h-9 bg-surface-2 font-mono tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="oc-to" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('gov.oncall.to')}
                </label>
                <Input
                  id="oc-to"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="18:00"
                  dir="ltr"
                  className="h-9 bg-surface-2 font-mono tabular-nums"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setOpen(false)}>
                {t('maint.cancel')}
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1.5"
                onClick={submit}
                disabled={create.isPending || eName.trim().length < 3 || handle.trim().length < 3}
              >
                {create.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <UserPlus className="size-3.5" aria-hidden="true" />}
                {t('gov.oncall.create')}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="h-8 gap-1.5 border-dashed" onClick={() => setOpen(true)}>
            <UserPlus className="size-3.5" aria-hidden="true" />
            {t('gov.oncall.create')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// ── 4. Escalation policy (v2.6) ─────────────────────────────────────────────

function EscalationCard({ policy }: { policy: EscalationPolicyDTO | undefined }) {
  const { t } = useLang()
  const save = useUpdateEscalationPolicy()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [timeout, setTimeoutMin] = useState(2)
  const [applies, setApplies] = useState<'critical' | 'all'>('critical')

  if (!policy) return null

  const startEdit = () => {
    setName(policy.name)
    setTimeoutMin(policy.timeoutMin)
    setApplies(policy.appliesTo)
    setOpen(true)
  }

  const dirty = name.trim() !== policy.name || timeout !== policy.timeoutMin || applies !== policy.appliesTo

  const submit = () => {
    save.mutate(
      { name: name.trim(), timeoutMin: timeout, appliesTo: applies },
      { onSuccess: () => setOpen(false) },
    )
  }

  const toggle = (enabled: boolean) => save.mutate({ enabled })

  return (
    <Card className="sentinel-card-highlight gap-5 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <TriangleAlert className="size-4 text-warn" aria-hidden="true" />
          {t('esc.title')}
          {policy.enabled ? (
            <Badge
              variant="outline"
              className="gap-1 border-warn/25 bg-warn-subtle text-[10px] text-warn"
            >
              <span className="size-1.5 animate-status-pulse rounded-full bg-warn" aria-hidden="true" />
              {t('esc.enabled')}
            </Badge>
          ) : null}
          {/* armed/disarmed is a one-tap control right in the header */}
          <span className="ms-auto flex items-center gap-2">
            <Switch
              checked={policy.enabled}
              onCheckedChange={toggle}
              disabled={save.isPending}
              aria-label={t('esc.enabled')}
            />
          </span>
        </CardTitle>
        <CardDescription>{t('esc.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Current policy summary strip */}
        <div className="grid gap-2.5 sm:grid-cols-3">
          <div className="rounded-[6px] border bg-surface-2 px-3.5 py-2.5">
            <p className="text-[10px] font-medium tracking-wider text-muted-foreground">{t('esc.timeout')}</p>
            <p className="mt-1 text-sm font-semibold tabular-nums" dir="ltr">
              {t('esc.timeoutMin', { n: policy.timeoutMin })}
            </p>
          </div>
          <div className="rounded-[6px] border bg-surface-2 px-3.5 py-2.5">
            <p className="text-[10px] font-medium tracking-wider text-muted-foreground">{t('esc.appliesTo')}</p>
            <p className="mt-1 text-sm font-semibold">
              {t(policy.appliesTo === 'critical' ? 'esc.appliesTo.critical' : 'esc.appliesTo.all')}
            </p>
          </div>
          <div className="rounded-[6px] border bg-surface-2 px-3.5 py-2.5">
            <p className="text-[10px] font-medium tracking-wider text-muted-foreground">{t('esc.stats', { n: policy.timesEscalated })}</p>
            <p className="mt-1 text-[11px] tabular-nums text-muted-foreground" dir="ltr">
              {policy.lastEscalatedAt ? t('esc.last', { ts: formatClock(policy.lastEscalatedAt) }) : t('esc.never')}
            </p>
          </div>
        </div>

        {/* Ladder explainer */}
        <p className="rounded-[6px] border border-warn/25 border-warn/25 bg-warn/[0.04] bg-warn/[0.04] px-3.5 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-warn">{t('esc.ladder')}: </span>
          {t('esc.ladder.desc')}
        </p>

        {/* Inline edit form */}
        {open ? (
          <div className="space-y-3 rounded-[6px] border border-warn/25 border-warn/25 bg-warn/[0.04] bg-warn/[0.04] p-3.5">
            <div className="grid gap-2.5 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-1">
                <label htmlFor="esc-name" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('esc.name')}
                </label>
                <Input
                  id="esc-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  className="h-9 bg-surface-2"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="esc-timeout" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('esc.timeout')}
                </label>
                <Select value={String(timeout)} onValueChange={(v) => setTimeoutMin(Number(v))}>
                  <SelectTrigger id="esc-timeout" size="sm" className="h-9 w-full bg-surface-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 5, 10, 15, 20, 30].map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {t('esc.timeoutMin', { n: m })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="esc-applies" className="text-[10px] font-medium tracking-wider text-muted-foreground">
                  {t('esc.appliesTo')}
                </label>
                <Select value={applies} onValueChange={(v) => setApplies(v as 'critical' | 'all')}>
                  <SelectTrigger id="esc-applies" size="sm" className="h-9 w-full bg-surface-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="critical">{t('esc.appliesTo.critical')}</SelectItem>
                    <SelectItem value="all">{t('esc.appliesTo.all')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setOpen(false)}>
                {t('esc.cancel')}
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1.5"
                onClick={submit}
                disabled={save.isPending || !dirty || name.trim().length < 3}
              >
                {save.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <TriangleAlert className="size-3.5" aria-hidden="true" />
                )}
                {t('esc.save')}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="h-8 gap-1.5 border-dashed" onClick={startEdit}>
            <TriangleAlert className="size-3.5" aria-hidden="true" />
            {t('esc.edit')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

/** Engineer-view governance section: rules + channels + on-call + escalation. */
export function GovernancePanel({
  services,
  rules,
  channels,
  onCall,
  escalationPolicy,
}: {
  services: ServiceDTO[]
  rules: AlertRuleDTO[]
  channels: NotificationChannelDTO[]
  onCall: OnCallEntryDTO[]
  /** v2.6: fleet escalation policy (undefined on older dashboards). */
  escalationPolicy?: EscalationPolicyDTO
}) {
  return (
    <div className="space-y-6">
      <RulesCard services={services} rules={rules} />
      <ChannelsCard channels={channels} />
      <OnCallCard onCall={onCall} />
      <EscalationCard policy={escalationPolicy} />
    </div>
  )
}

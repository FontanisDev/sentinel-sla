'use client'

// /services/[key] — full-page service detail (design system §5): live health,
// latency/error rate, money model, the current-Jalali-window contract row
// (same math as /contracts), recent incidents and the evidence trail
// (notifications + chaos experiments).

import Link from 'next/link'
import {
  ArrowUpRight,
  BellRing,
  CircleDollarSign,
  FlaskConical,
  HandCoins,
  HeartPulse,
  SearchX,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AppShell } from '@/components/sentinel/app-shell'
import { PageHeader } from '@/components/sentinel/page-header'
import { DashboardSkeleton } from '@/components/sentinel/skeleton'
import { EmptyState } from '@/components/sentinel/empty-state'
import { DateText } from '@/components/sentinel/date-text'
import { MoneyValue } from '@/components/sentinel/money-value'
import { FormulaPopover } from '@/components/sentinel/formula-popover'
import { ChannelIcon } from '@/components/sentinel/alerts-feed'
import { TpsProfileCard } from '@/components/sentinel/tps-profile-card'
import { IncidentStat } from '@/components/sentinel/incident-detail-parts'
import type { ServiceDetailDTO } from '@/lib/types'
import { CHAOS_STATUS, CHAOS_TYPE_LABEL, INCIDENT_STATUS, SEVERITY, serviceStatus } from '@/components/sentinel/status'
import { useServiceDetail } from '@/hooks/use-sentinel'
import { useLang } from '@/hooks/use-language'
import { formatDurationLocale, formatNumberLocale, formatPercentLocale } from '@/lib/format'
import { cn } from '@/lib/utils'

export function ServiceDetailClient({
  serviceKey,
  user,
}: {
  serviceKey: string
  user: { name: string; email: string; role: string; locale?: string | null }
}) {
  const { t } = useLang()
  const { data, error, isLoading, refetch } = useServiceDetail(serviceKey)

  return (
    <AppShell
      user={user}
      crumbs={[
        { label: t('crumb.home'), href: '/' },
        { label: t('page.services.title'), href: '/services' },
        { label: serviceKey },
      ]}
    >
      <div className="mx-auto w-full max-w-5xl">
        {isLoading ? (
          <DashboardSkeleton />
        ) : error ? (
          isNotFound(error) ? (
            <div className="py-16">
              <EmptyState
                icon={SearchX}
                title={t('svcd.notFound.title')}
                description={t('svcd.notFound.desc')}
              />
              <div className="mt-4 flex justify-center">
                <Button variant="outline" className="h-9 gap-1.5" asChild>
                  <Link href="/services">
                    {t('svcd.backToServices')}
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            </div>
          ) : (
            <div className="py-16 text-center" role="alert">
              <p className="text-sm text-t2">{t('page.unreachable')}</p>
              <Button variant="outline" size="sm" className="mt-3 h-8 gap-1.5" onClick={() => refetch()}>
                {t('page.retry')}
              </Button>
            </div>
          )
        ) : data ? (
          <ServiceDetailBody detail={data} refetch={refetch} />
        ) : null}
      </div>
    </AppShell>
  )
}

/** The API's honest 404 — "does not exist OR you have no access" (no key probing). */
function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Service not found')
}

function ServiceDetailBody({
  detail,
  refetch,
}: {
  detail: ServiceDetailDTO
  refetch: () => void
}) {
  const { t, name, lang } = useLang()
  const svc = detail.service
  const contract = detail.contract
  const st = serviceStatus(svc.status)
  const targetTone = svc.uptime >= svc.slaTarget ? 'text-ok' : 'text-crit'

  return (
    <>
      <PageHeader
        title={name(svc.name, svc.nameFa)}
        description={`${svc.key} · ${svc.endpoint}`}
        actions={
          <Button variant="outline" className="h-9 gap-1.5" asChild>
            <Link
              href={`/services?q=${encodeURIComponent(svc.key)}`}
              aria-label={t('svcd.openRegistryAria', { key: svc.key })}
            >
              {t('svcd.openRegistry')}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        }
      />

      {/* Meta row: health dot + status, live signal, tenant, criticality */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn('gap-1.5 text-[10px]', st.chip)}>
          <span className={cn('size-1.5 rounded-full', st.dot)} aria-hidden="true" />
          {t(st.label)}
        </Badge>
        {svc.liveStatus ? (
          <Badge
            variant="outline"
            className={cn(
              'text-[10px]',
              svc.liveStatus === 'up'
                ? 'border-ok/25 bg-ok-subtle text-ok'
                : svc.liveStatus === 'stale'
                  ? 'border-warn/25 bg-warn-subtle text-warn'
                  : 'border-crit/25 bg-crit-subtle text-crit',
            )}
          >
            {t(`settings.live.${svc.liveStatus}`)}
          </Badge>
        ) : null}
        {svc.tenantName ? (
          <span className="text-xs text-t2">
            {t('contracts.col.client')}: {svc.tenantName}
          </span>
        ) : null}
        <span className="text-xs text-t3">{svc.criticality}</span>
      </div>

      {/* Live health (shared stat-box look with the incident detail page) */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <IncidentStat
          label={t('dlg.uptime')}
          value={formatPercentLocale(svc.uptime, lang)}
          tone={targetTone}
        />
        <IncidentStat label={t('dlg.slaTarget')} value={formatPercentLocale(svc.slaTarget, lang, 2)} />
        <IncidentStat label={t('dlg.latency')} value={`${Math.round(svc.latencyMs)} ms`} />
        <IncidentStat label={t('dlg.errorRate')} value={`${(svc.errorRate * 100).toFixed(2)}%`} />
        <IncidentStat label={t('dlg.throughput')} value={`${Math.round(svc.throughput)} tx/s`} />
        <IncidentStat
          label={t('dlg.penaltyBase')}
          value={<MoneyValue tomans={svc.penaltyBase} />}
          tone="text-warn"
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-5">
        {/* ── left: contract + recent incidents ────────────────────────── */}
        <div className="space-y-4 lg:col-span-3">
          <Card className="gap-3 rounded-[6px] shadow-none">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <HandCoins className="size-4 text-warn" aria-hidden="true" />
                {t('svcd.contract.title')}
                <Badge
                  variant="outline"
                  className={cn(
                    'px-1.5 py-0 text-[9px]',
                    contract.compliance === 'compliant'
                      ? 'border-ok/25 bg-ok-subtle text-ok'
                      : contract.compliance === 'breach'
                        ? 'border-crit/25 bg-crit-subtle text-crit'
                        : 'border-line bg-raised text-muted-foreground',
                  )}
                >
                  {t(`contracts.compliance.${contract.compliance}`)}
                </Badge>
              </CardTitle>
              <CardDescription>{t('contracts.window.sub')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <IncidentStat
                  label={t('contracts.col.availability')}
                  value={
                    <span className="inline-flex items-center gap-0.5">
                      {contract.availabilityPct !== null
                        ? formatPercentLocale(contract.availabilityPct / 100, lang, 2)
                        : '—'}
                      <FormulaPopover
                        formula={t('contracts.formula.availability')}
                        inputs={[
                          {
                            label: t('contracts.formula.elapsed'),
                            value: formatDurationLocale(contract.elapsedSec, lang),
                          },
                          {
                            label: t('contracts.col.downtime'),
                            value: formatDurationLocale(contract.downtimeSec, lang),
                          },
                        ]}
                        evidence={[
                          { label: t('svcd.evidenceWindow'), href: '/contracts' },
                          { label: t('formula.evidence.domainDoc') },
                        ]}
                      />
                    </span>
                  }
                  tone={
                    contract.availabilityPct !== null && contract.availabilityPct < contract.targetPct
                      ? 'text-crit'
                      : 'text-foreground'
                  }
                />
                <IncidentStat label={t('contracts.col.target')} value={formatPercentLocale(contract.targetPct / 100, lang, 2)} />
                <IncidentStat
                  label={t('contracts.col.downtime')}
                  value={formatDurationLocale(contract.downtimeSec, lang)}
                />
                <IncidentStat
                  label={t('contracts.col.penaltyToDate')}
                  value={
                    <span className="inline-flex items-center gap-0.5">
                      <MoneyValue tomans={contract.penaltyToDate} tone={contract.penaltyToDate > 0 ? 'warn' : 'default'} />
                      <FormulaPopover
                        formula={t('contracts.formula.penalty')}
                        inputs={[
                          {
                            label: t('contracts.formula.base'),
                            value: formatNumberLocale(contract.penaltyBase, lang),
                          },
                          {
                            label: t('contracts.formula.perMinute'),
                            value: formatNumberLocale(contract.penaltyPerMinute, lang),
                          },
                          {
                            label: t('contracts.formula.billed'),
                            value: formatNumberLocale(contract.billedMinutes, lang),
                          },
                          {
                            label: t('contracts.formula.weight'),
                            value: t('contracts.formula.weightValue'),
                          },
                        ]}
                        evidence={[
                          { label: t('svcd.evidenceWindow'), href: '/contracts' },
                          { label: t('formula.evidence.domainDoc') },
                        ]}
                      />
                    </span>
                  }
                  tone="text-warn"
                />
                <IncidentStat
                  label={t('contracts.col.projected')}
                  value={
                    contract.projectedPenalty !== null ? (
                      <span className="inline-flex items-center gap-0.5">
                        <MoneyValue tomans={contract.projectedPenalty} />
                        <FormulaPopover
                          formula={t('contracts.formula.projected')}
                          inputs={[
                            {
                              label: t('contracts.col.penaltyToDate'),
                              value: formatNumberLocale(contract.penaltyToDate, lang),
                            },
                            {
                              label: t('contracts.formula.elapsed'),
                              value: formatDurationLocale(contract.elapsedSec, lang),
                            },
                          ]}
                          evidence={[{ label: t('svcd.evidenceWindow'), href: '/contracts' }]}
                        />
                      </span>
                    ) : (
                      <span title={t('contracts.projection.pending')}>—</span>
                    )
                  }
                />
                <IncidentStat
                  label={t('contracts.col.planned')}
                  value={formatNumberLocale(contract.plannedWindows, lang)}
                />
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-t3">{t('contracts.exclusions.note')}</p>
            </CardContent>
          </Card>

          <Card className="gap-3 rounded-[6px] shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <HeartPulse className="size-4 text-crit" aria-hidden="true" />
                {t('svcd.incidents.title')}
                <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {formatNumberLocale(detail.incidents.length, lang)}
                </span>
              </CardTitle>
              <CardDescription>{t('svcd.incidents.desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {detail.incidents.length === 0 ? (
                <EmptyState
                  icon={HeartPulse}
                  title={t('svcd.incidents.empty.title')}
                  description={t('svcd.incidents.empty.desc')}
                  className="py-6"
                />
              ) : (
                <ul className="space-y-2" aria-label={t('svcd.incidents.title')}>
                  {detail.incidents.map((inc) => (
                    <li key={inc.id}>
                      <Link
                        href={`/incidents/${inc.id}`}
                        className="block rounded-lg border border-line bg-surface-1 px-3 py-2.5 outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <Badge
                              variant="outline"
                              className={cn('shrink-0 px-1.5 py-0 text-[9px]', SEVERITY[inc.severity].chip)}
                            >
                              {t(SEVERITY[inc.severity].label)}
                            </Badge>
                            <Badge
                              variant="outline"
                              className={cn('shrink-0 px-1.5 py-0 text-[9px]', INCIDENT_STATUS[inc.status].chip)}
                            >
                              {t(INCIDENT_STATUS[inc.status].label)}
                            </Badge>
                          </span>
                          <span className="shrink-0 text-[10px] tabular-nums text-t3" dir="ltr">
                            <DateText date={inc.startedAt} withTime />
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-t2">
                          {t('incd.related.item', {
                            dur:
                              inc.durationSec !== null
                                ? formatDurationLocale(inc.durationSec, lang)
                                : t('itable.ongoing'),
                            lost: formatNumberLocale(inc.lostTransactions, lang),
                          })}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── right: money model + evidence (alerts, chaos) ────────────── */}
        <div className="space-y-4 lg:col-span-2">
          <Card className="gap-3 rounded-[6px] shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CircleDollarSign className="size-4 text-warn" aria-hidden="true" />
                {t('incd.money.title')}
              </CardTitle>
              <CardDescription>{t('svcd.money.desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-2">
                <MoneyFact
                  label={t('dlg.throughput')}
                  value={`${formatNumberLocale(svc.tps, lang)} tx/s`}
                />
                <MoneyFact
                  label={t('formula.input.ticket')}
                  value={formatNumberLocale(svc.avgTransactionValue, lang)}
                />
                <MoneyFact
                  label={t('formula.input.base')}
                  value={<MoneyValue tomans={svc.penaltyBase} />}
                />
                <MoneyFact
                  label={t('formula.input.perMin')}
                  value={<MoneyValue tomans={svc.penaltyPerMinute} />}
                />
              </dl>
              <Button variant="ghost" size="sm" className="mt-3 h-8 gap-1.5 text-xs" asChild>
                <Link href="/settings/services">
                  {t('formula.evidence.moneyModel')}
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <TpsProfileCard
            serviceKey={svc.key}
            profile={detail.tpsProfile}
            flatTps={svc.tps}
            onChanged={() => void refetch()}
          />

          <Card className="gap-3 rounded-[6px] shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BellRing className="size-4 text-info" aria-hidden="true" />
                {t('incd.evidence.title')}
                <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {formatNumberLocale(detail.alerts.length, lang)}
                </span>
              </CardTitle>
              <CardDescription>{t('svcd.alerts.desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {detail.alerts.length === 0 ? (
                <EmptyState
                  icon={BellRing}
                  title={t('svcd.alerts.empty.title')}
                  description={t('svcd.alerts.empty.desc')}
                  className="py-6"
                />
              ) : (
                <ul className="space-y-2" aria-label={t('incd.evidence.title')}>
                  {detail.alerts.map((a) => (
                    <li
                      key={a.id}
                      className="rounded-lg border border-line bg-surface-1 px-3 py-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <ChannelIcon channel={a.channel} />
                          <span className="truncate text-[11px] font-medium text-text-1">
                            {a.title}
                          </span>
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            'shrink-0 px-1.5 py-0 text-[9px]',
                            a.status === 'failed'
                              ? 'border-crit/25 bg-crit-subtle text-crit'
                              : 'border-ok/25 bg-ok-subtle text-ok',
                          )}
                        >
                          {a.status}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                        {a.message}
                      </p>
                      <p className="mt-1 text-[10px] tabular-nums text-t3" dir="ltr">
                        <DateText date={a.sentAt} withTime />
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="gap-3 rounded-[6px] shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FlaskConical className="size-4 text-muted-foreground" aria-hidden="true" />
                {t('svcd.chaos.title')}
                <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {formatNumberLocale(detail.chaos.length, lang)}
                </span>
              </CardTitle>
              <CardDescription>{t('svcd.chaos.desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {detail.chaos.length === 0 ? (
                <EmptyState
                  icon={FlaskConical}
                  title={t('svcd.chaos.empty.title')}
                  description={t('svcd.chaos.empty.desc')}
                  className="py-6"
                />
              ) : (
                <ul className="space-y-2" aria-label={t('svcd.chaos.title')}>
                  {detail.chaos.map((exp) => (
                    <li
                      key={exp.id}
                      className="rounded-lg border border-line bg-surface-1 px-3 py-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-text-1">
                          {t(CHAOS_TYPE_LABEL[exp.type])}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn('shrink-0 px-1.5 py-0 text-[9px]', CHAOS_STATUS[exp.status].chip)}
                        >
                          {t(CHAOS_STATUS[exp.status].label)}
                        </Badge>
                      </div>
                      <p className="mt-1 text-[10px] tabular-nums text-t3" dir="ltr">
                        <DateText date={exp.startedAt} withTime />
                        {exp.mttdSec !== null
                          ? ` · MTTD ${formatDurationLocale(exp.mttdSec, lang)}`
                          : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}

function MoneyFact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <dt className="text-[10px] font-medium tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

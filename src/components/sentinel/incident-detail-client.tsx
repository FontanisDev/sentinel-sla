'use client'

// /incidents/[id] — full-page incident detail (design system §5): timeline,
// financial breakdown with formula evidence, ack/resolve, post-mortem and an
// evidence panel (notifications + money model + related incidents).
// Content panels are shared 1:1 with the row-level dialog via
// incident-detail-parts.tsx — the two surfaces render the same facts.

import Link from 'next/link'
import {
  ArrowUpRight,
  BellRing,
  CircleDollarSign,
  Clock,
  FileCog,
  HandCoins,
  History,
  SearchX,
  Sparkles,
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
import { ChannelIcon } from '@/components/sentinel/alerts-feed'
import type { IncidentDetailDTO } from '@/lib/types'
import {
  IncidentAckResolvePanel,
  IncidentBadges,
  IncidentEscalationBanner,
  IncidentPostMortemPanel,
  IncidentSourceLine,
  IncidentStatGrid,
  IncidentTimeline,
} from '@/components/sentinel/incident-detail-parts'
import { INCIDENT_STATUS, SEVERITY } from '@/components/sentinel/status'
import { useIncidentDetail } from '@/hooks/use-sentinel'
import { useLang } from '@/hooks/use-language'
import { formatDurationLocale, formatNumberLocale } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Ack/resolve are engineer-floor mutations (owner 50 > admin 40 > engineer 30). */
const OPERATOR_ROLES = new Set(['owner', 'admin', 'engineer'])

export function IncidentDetailClient({
  id,
  user,
}: {
  id: string
  user: { name: string; email: string; role: string; locale?: string | null }
}) {
  const { t } = useLang()
  const { data, error, isLoading, refetch } = useIncidentDetail(id)
  const canOperate = OPERATOR_ROLES.has(user.role)

  return (
    <AppShell
      user={user}
      crumbs={[
        { label: t('crumb.home'), href: '/' },
        { label: t('page.incidents.title'), href: '/incidents' },
        { label: id.slice(0, 8) },
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
                title={t('incd.notFound.title')}
                description={t('incd.notFound.desc')}
              />
              <div className="mt-4 flex justify-center">
                <Button variant="outline" className="h-9 gap-1.5" asChild>
                  <Link href="/incidents">
                    {t('incd.backToIncidents')}
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
          <IncidentDetailBody detail={data} canOperate={canOperate} />
        ) : null}
      </div>
    </AppShell>
  )
}

/** The API's honest 404 — "does not exist OR you have no access" (no id probing). */
function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Incident not found')
}

function IncidentDetailBody({
  detail,
  canOperate,
}: {
  detail: IncidentDetailDTO
  canOperate: boolean
}) {
  const { t, name, lang } = useLang()
  const inc = detail.incident
  const ongoing = inc.status === 'ongoing'
  const acked = inc.acknowledgedAt !== null

  return (
    <>
      <PageHeader
        title={name(inc.serviceName, null)}
        description={t('page.incidents.desc')}
        actions={
          <Button variant="outline" className="h-9 gap-1.5" asChild>
            <Link
              href={`/incidents?q=${encodeURIComponent(inc.id)}`}
              aria-label={t('incd.openLedgerAria', { id: inc.id.slice(0, 8) })}
            >
              {t('incd.openLedger')}
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        }
      />

      {/* Meta row: severity + status chips, source + start time, id */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <IncidentBadges incident={inc} />
        <span className="text-xs text-t2">
          <IncidentSourceLine incident={inc} />
        </span>
        <span className="font-mono text-[11px] tabular-nums text-t3" dir="ltr">
          {inc.id.slice(0, 8)}
        </span>
      </div>
      <div className="mt-2">
        <IncidentEscalationBanner incident={inc} />
      </div>

      {/* Financial breakdown + response times (shared with the dialog) */}
      <div className="mt-4">
        <IncidentStatGrid incident={inc} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-5">
        {/* ── left: timeline, post-mortem, actions ─────────────────────── */}
        <div className="space-y-4 lg:col-span-3">
          <Card className="gap-3 rounded-[6px] shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <History className="size-4 text-info" aria-hidden="true" />
                {t('timeline.title')}
              </CardTitle>
              <CardDescription>{t('incd.timeline.desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <IncidentTimeline events={inc.events} />
            </CardContent>
          </Card>

          <Card className="gap-3 rounded-[6px] shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="size-4 text-ok" aria-hidden="true" />
                {t('incd.postMortem.title')}
              </CardTitle>
              <CardDescription>{t('incd.postMortem.desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <IncidentPostMortemPanel incident={inc} />
            </CardContent>
          </Card>

          {ongoing ? (
            canOperate ? (
              <Card className="gap-3 rounded-[6px] shadow-none">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <BellRing className="size-4 text-chart-5" aria-hidden="true" />
                    {t('incd.actions.title')}
                  </CardTitle>
                  <CardDescription>{t('incd.actions.desc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <IncidentAckResolvePanel incident={inc} canOperate />
                </CardContent>
              </Card>
            ) : (
              acked && (
                <p
                  className="flex items-center gap-1.5 rounded-[6px] bg-chart-5/[0.06] px-3 py-2.5 text-xs text-chart-5"
                  dir="auto"
                >
                  <BellRing className="size-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {t('ack.toast.done')} —{' '}
                    <span dir="ltr" className="font-mono">
                      {inc.acknowledgedBy}
                    </span>
                  </span>
                </p>
              )
            )
          ) : null}
        </div>

        {/* ── right: evidence — notifications, money model, related ────── */}
        <div className="space-y-4 lg:col-span-2">
          <Card className="gap-3 rounded-[6px] shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileCog className="size-4 text-info" aria-hidden="true" />
                {t('incd.evidence.title')}
                <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {formatNumberLocale(detail.alerts.length, lang)}
                </span>
              </CardTitle>
              <CardDescription>{t('incd.evidence.desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {detail.alerts.length === 0 ? (
                <EmptyState
                  icon={BellRing}
                  title={t('incd.alerts.empty.title')}
                  description={t('incd.alerts.empty.desc')}
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
                      <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
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

          {inc.moneyModel ? (
            <Card className="gap-3 rounded-[6px] shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CircleDollarSign className="size-4 text-warn" aria-hidden="true" />
                  {t('incd.money.title')}
                </CardTitle>
                <CardDescription>{t('incd.money.desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-2">
                  <MoneyFact
                    label={t('dlg.throughput')}
                    value={`${formatNumberLocale(inc.moneyModel.tps, lang)} tx/s`}
                  />
                  <MoneyFact
                    label={t('formula.input.ticket')}
                    value={formatNumberLocale(inc.moneyModel.avgTransactionValue, lang)}
                  />
                  <MoneyFact
                    label={t('formula.input.base')}
                    value={<MoneyValue tomans={inc.moneyModel.penaltyBase} />}
                  />
                  <MoneyFact
                    label={t('formula.input.perMin')}
                    value={<MoneyValue tomans={inc.moneyModel.penaltyPerMinute} />}
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
          ) : null}

          <Card className="gap-3 rounded-[6px] shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <HandCoins className="size-4 text-muted-foreground" aria-hidden="true" />
                {t('incd.related.title')}
                <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {formatNumberLocale(detail.related.length, lang)}
                </span>
              </CardTitle>
              <CardDescription>{t('incd.related.desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {detail.related.length === 0 ? (
                <EmptyState
                  icon={Clock}
                  title={t('incd.related.empty.title')}
                  description={t('incd.related.empty.desc')}
                  className="py-6"
                />
              ) : (
                <ul className="space-y-2" aria-label={t('incd.related.title')}>
                  {detail.related.map((rel) => (
                    <li key={rel.id}>
                      <Link
                        href={`/incidents/${rel.id}`}
                        className="block rounded-lg border border-line bg-surface-1 px-3 py-2.5 outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <Badge
                              variant="outline"
                              className={cn('shrink-0 px-1.5 py-0 text-[9px]', SEVERITY[rel.severity].chip)}
                            >
                              {t(SEVERITY[rel.severity].label)}
                            </Badge>
                            <Badge
                              variant="outline"
                              className={cn('shrink-0 px-1.5 py-0 text-[9px]', INCIDENT_STATUS[rel.status].chip)}
                            >
                              {t(INCIDENT_STATUS[rel.status].label)}
                            </Badge>
                          </span>
                          <span className="shrink-0 text-[10px] tabular-nums text-t3" dir="ltr">
                            <DateText date={rel.startedAt} withTime />
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-t2">
                          {t('incd.related.item', {
                            dur:
                              rel.durationSec !== null
                                ? formatDurationLocale(rel.durationSec, lang)
                                : t('itable.ongoing'),
                            lost: formatNumberLocale(rel.lostTransactions, lang),
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

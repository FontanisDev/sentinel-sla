'use client'

import { Banknote, ShieldCheck, TrendingDown } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatNumberLocale, formatTomansFullLocale } from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import type { KpiDTO, ServiceDTO } from '@/lib/types'
import { serviceStatus } from './status'
import { EmptyState } from './empty-state'
import { MoneyValue } from './money-value'
import { FormulaPopover } from './formula-popover'

export function FinancialImpact({ kpis, services }: { kpis: KpiDTO; services: ServiceDTO[] }) {
  const { t, name, lang } = useLang()
  const total = kpis.lostRevenueTomans + kpis.penaltyExposureTomans
  const offenders = services
    .map((s) => ({ service: s, total: s.revenueLossTomans + s.penaltyTomans }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 6)
  const max = offenders[0]?.total ?? 0

  // §6.7 evidence links shared by the fleet-level popovers
  const fleetEvidence = [
    { label: t('evidence.incidentLedger'), href: '/incidents' },
    { label: t('evidence.moneyModels'), href: '/services' },
  ]

  return (
    <Card className="sentinel-card-highlight gap-5 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="text-base">{t('fin.title')}</CardTitle>
        <CardDescription>{t('fin.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
          <div>
            <p className="text-[10px] font-medium tracking-wider text-muted-foreground">
              {t('fin.total')}
            </p>
            {/* §6.6/§6.7: compact magnitude + full value in the popover inputs */}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <MoneyValue
                tomans={total}
                tone="crit"
                className="text-4xl font-bold tracking-tight sm:text-5xl"
              />
              <FormulaPopover
                formula={t('fin.formula.total')}
                inputs={[
                  {
                    label: t('fin.revenueLoss'),
                    value: formatTomansFullLocale(kpis.lostRevenueTomans, lang),
                  },
                  {
                    label: t('fin.penalties'),
                    value: formatTomansFullLocale(kpis.penaltyExposureTomans, lang),
                  },
                ]}
                evidence={fleetEvidence}
                className="size-6"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-5">
            <div>
              <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-muted-foreground">
                <TrendingDown className="size-3.5 text-crit" aria-hidden="true" />
                {t('fin.revenueLoss')}
              </p>
              <p className="mt-1 flex items-center gap-0.5 text-xl font-semibold">
                <MoneyValue tomans={kpis.lostRevenueTomans} tone="crit" ultra className="text-xl font-semibold" />
                <FormulaPopover
                  formula={t('formula.revenueLoss')}
                  inputs={[
                    {
                      label: t('formula.input.lostTx'),
                      value: formatNumberLocale(kpis.transactionsLost, lang),
                    },
                  ]}
                  evidence={fleetEvidence}
                />
              </p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-muted-foreground">
                <Banknote className="size-3.5 text-warn" aria-hidden="true" />
                {t('fin.penalties')}
              </p>
              <p className="mt-1 flex items-center gap-0.5 text-xl font-semibold">
                <MoneyValue tomans={kpis.penaltyExposureTomans} tone="warn" ultra className="text-xl font-semibold" />
                <FormulaPopover
                  formula={t('formula.penalty')}
                  inputs={[
                    {
                      label: t('kpi.incidentsTotal'),
                      value: formatNumberLocale(kpis.incidentsTotal, lang),
                    },
                  ]}
                  evidence={[
                    { label: t('evidence.incidentLedger'), href: '/incidents' },
                    { label: t('evidence.contracts'), href: '/contracts' },
                  ]}
                />
              </p>
            </div>
          </div>
        </div>

        {offenders.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title={t('fin.empty.title')}
            description={t('fin.empty.desc')}
            className="py-8"
          />
        ) : (
          <div className="space-y-3.5">
            <p className="text-[10px] font-medium tracking-wider text-muted-foreground">
              {t('fin.byService', { n: offenders.length })}
            </p>
            {offenders.map(({ service, total: loss }) => (
              <div key={service.id} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-medium text-foreground">{name(service.name, service.nameFa)}</span>
                    {name(service.name, service.nameFa) !== (service.nameFa ?? service.name) ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground" lang={service.nameFa ? 'en' : undefined} dir={service.nameFa ? 'ltr' : undefined}>
                        {service.nameFa ?? service.name}
                      </span>
                    ) : null}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground">
                    <MoneyValue tomans={loss} />
                    <FormulaPopover
                      formula={`${t('formula.revenueLoss')} + ${t('formula.penalty')}`}
                      inputs={[
                        {
                          label: t('formula.input.lostTx'),
                          value: formatNumberLocale(service.lostTransactions, lang),
                        },
                        {
                          label: t('formula.input.ticket'),
                          value: formatNumberLocale(service.avgTransactionValue, lang),
                        },
                        {
                          label: t('formula.input.perMin'),
                          value: formatNumberLocale(service.penaltyPerMinute, lang),
                        },
                      ]}
                      evidence={[
                        { label: t('formula.evidence.moneyModel'), href: '/settings/services' },
                        { label: t('formula.evidence.domainDoc') },
                      ]}
                    />
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-raised" role="presentation">
                  <div
                    className={cn('h-full rounded-full transition-all duration-500', serviceStatus(service.status).bar)}
                    style={{ width: `${max > 0 ? Math.max(2, (loss / max) * 100) : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

'use client'

// Sentinel-SLA — KPI strip (9 cards) with staggered mount animation.

import {
  Banknote,
  BellRing,
  Gauge,
  ShieldCheck,
  ShoppingBag,
  Siren,
  Timer,
  TrendingDown,
  Wrench,
} from 'lucide-react'
import type { KpiDTO, ServiceDTO } from '@/lib/types'
import { formatDurationLocale, formatNumberLocale, formatPercentLocale, formatTomansUltra } from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import { AnimatedValue, ComplianceRing, KpiCard, type KpiTone } from './kpi-card'
import { FormulaPopover } from './formula-popover'

export function KpiStrip({
  kpis,
  services,
  scopeName,
}: {
  kpis: KpiDTO
  services: ServiceDTO[]
  /** Localized tenant name when the dashboard is scoped (subtle context). */
  scopeName?: string | null
}) {
  const { t, lang } = useLang()

  const avgTarget = services.length
    ? services.reduce((acc, s) => acc + s.slaTarget, 0) / services.length
    : 0.999
  const mttdOk = kpis.avgMttdSec !== null && kpis.avgMttdSec <= 60
  const complianceRatio = kpis.totalServices > 0 ? kpis.slaCompliantServices / kpis.totalServices : 0

  const cards = [
    {
      key: 'uptime',
      icon: Gauge,
      label: t('kpi.fleetUptime'),
      tone: (kpis.fleetUptime >= avgTarget ? 'good' : 'warn') as KpiTone,
      value: <AnimatedValue value={kpis.fleetUptime} format={(v) => formatPercentLocale(v, lang)} />,
      sub: <span>{t('kpi.target', { v: formatPercentLocale(avgTarget, lang, 2) })}</span>,
    },
    {
      key: 'incidents',
      icon: Siren,
      label: t('kpi.activeIncidents'),
      tone: (kpis.activeIncidents > 0 ? 'bad' : 'good') as KpiTone,
      value: <AnimatedValue value={kpis.activeIncidents} format={(v) => formatNumberLocale(v, lang)} />,
      // v2.6: escalated subset surfaces right on the card — the ladder is
      // visible even before opening the incident table.
      sub:
        (kpis.escalatedIncidents ?? 0) > 0 ? (
          <span className="inline-flex items-center gap-1">
            <span className="inline-block size-1.5 rounded-full bg-warn" aria-hidden="true" />
            {t('kpi.total', { v: formatNumberLocale(kpis.incidentsTotal, lang) })}
            <span className="font-medium text-warn">
              · {t('kpi.escalated', { n: kpis.escalatedIncidents })}
            </span>
          </span>
        ) : (
          t('kpi.total', { v: formatNumberLocale(kpis.incidentsTotal, lang) })
        ),
    },
    {
      key: 'revenue',
      icon: TrendingDown,
      label: t('kpi.lostRevenue'),
      tone: 'bad' as const,
      // §6.7: the fleet money headline carries its formula + real inputs.
      value: (
        <span className="inline-flex min-w-0 items-center gap-0.5">
          <AnimatedValue value={kpis.lostRevenueTomans} format={(v) => formatTomansUltra(v, lang)} />
          <FormulaPopover
            formula="Σ per incident: lost tx × avg tx value (per service money model)"
            inputs={[
              { label: t('kpi.txLost'), value: formatNumberLocale(kpis.transactionsLost, lang) },
              { label: t('kpi.allServices'), value: formatNumberLocale(kpis.totalServices, lang) },
            ]}
            evidence={[
              { label: t('evidence.incidentLedger'), href: '/incidents' },
              { label: t('evidence.moneyModels'), href: '/services' },
            ]}
          />
        </span>
      ),
      sub: t('kpi.sinceStart'),
    },
    {
      key: 'penalty',
      icon: Banknote,
      label: t('kpi.penaltyExposure'),
      tone: 'warn' as const,
      value: (
        <span className="inline-flex min-w-0 items-center gap-0.5">
          <AnimatedValue
            value={kpis.penaltyExposureTomans}
            format={(v) => formatTomansUltra(v, lang)}
          />
          <FormulaPopover
            formula="Σ per incident: base + per-minute × billable minutes (tier + cap applied)"
            inputs={[
              { label: t('kpi.incidentsTotal'), value: formatNumberLocale(kpis.incidentsTotal, lang) },
            ]}
            evidence={[
              { label: t('evidence.incidentLedger'), href: '/incidents' },
              { label: t('evidence.contracts'), href: '/contracts' },
            ]}
          />
        </span>
      ),
      sub: t('kpi.contractual'),
    },
    {
      key: 'tx',
      icon: ShoppingBag,
      label: t('kpi.txLost'),
      tone: 'default' as const,
      value: <AnimatedValue value={kpis.transactionsLost} format={(v) => formatNumberLocale(v, lang)} />,
      sub: t('kpi.allServices'),
    },
    {
      key: 'mttd',
      icon: Timer,
      label: t('kpi.mttd'),
      tone: (kpis.avgMttdSec === null ? 'default' : mttdOk ? 'good' : 'bad') as KpiTone,
      value: <AnimatedValue value={kpis.avgMttdSec} format={(v) => formatDurationLocale(v, lang)} />,
      sub: t('kpi.mttdTarget'),
    },
    {
      key: 'mtta',
      icon: BellRing,
      label: t('kpi.mtta'),
      // No SLA target for MTTA yet — informational tone until on-call data exists.
      tone: (kpis.avgMttaSec === null ? 'default' : kpis.avgMttaSec <= 120 ? 'good' : 'warn') as KpiTone,
      value: <AnimatedValue value={kpis.avgMttaSec} format={(v) => formatDurationLocale(v, lang)} />,
      sub: t('kpi.mttaSub'),
    },
    {
      key: 'mttr',
      icon: Wrench,
      label: t('kpi.mttr'),
      tone: 'default' as const,
      value: <AnimatedValue value={kpis.avgMttrSec} format={(v) => formatDurationLocale(v, lang)} />,
      sub: t('kpi.mttrSub'),
    },
    {
      key: 'sla',
      icon: ShieldCheck,
      label: t('kpi.slaCompliance'),
      tone: (complianceRatio >= 1 ? 'good' : complianceRatio >= 0.8 ? 'warn' : 'bad') as KpiTone,
      value: (
        <span>
          {formatNumberLocale(kpis.slaCompliantServices, lang)}
          <span className="text-muted-foreground">/{formatNumberLocale(kpis.totalServices, lang)}</span>
        </span>
      ),
      sub: t('kpi.meetingTarget'),
      right: <ComplianceRing ratio={complianceRatio} />,
    },
  ]

  return (
    <section
      aria-label={scopeName ? t('kpi.scopedAria', { name: scopeName }) : t('kpi.section')}
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-9"
    >
      {cards.map((card) => (
        <KpiCard
          key={card.key}
          icon={card.icon}
          label={card.label}
          tone={card.tone}
          value={card.value}
          sub={card.sub}
          right={card.right}
          className="h-full"
        />
      ))}
    </section>
  )
}

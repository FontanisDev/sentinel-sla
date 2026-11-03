'use client'

// Sentinel-SLA — PenaltyTrendCard.
//
// The first direct StatCard (§6.4) consumer beyond the KpiCard delegate:
// the window's SLA-penalty total with the hourly penalty series as its
// sparkline and an honest delta (last bucket vs the bucket before it —
// both REAL engine buckets, never invented). Penalty going down is good
// news, so goodWhen: 'down'. The explain popover carries the window and
// bucket counts behind the figure (§6.7 evidence rule).

import { TrendingDown } from 'lucide-react'
import { useLang } from '@/hooks/use-language'
import { formatNumberLocale, formatTomansFullLocale } from '@/lib/format'
import type { AnalyticsDTO } from '@/lib/types'
import { StatCard } from './stat-card'
import { MoneyValue } from './money-value'

export function PenaltyTrendCard({ analytics }: { analytics: AnalyticsDTO | undefined }) {
  const { t, lang } = useLang()

  if (!analytics || analytics.trends.length === 0) return null

  const trends = analytics.trends
  const total = trends.reduce((acc, p) => acc + p.penaltyTomans, 0)
  const last = trends[trends.length - 1]
  const prev = trends.length >= 2 ? trends[trends.length - 2] : null
  const delta = prev && last.penaltyTomans !== prev.penaltyTomans
    ? { value: last.penaltyTomans - prev.penaltyTomans, goodWhen: 'down' as const }
    : undefined

  return (
    <div className="max-w-sm">
      <StatCard
        icon={TrendingDown}
        label={t('fin.trend.label')}
        tone={total > 0 ? 'bad' : 'good'}
        figure={<MoneyValue tomans={total} tone={total > 0 ? 'crit' : 'ok'} />}
        sub={t('fin.trend.sub', { n: formatNumberLocale(analytics.windowHours, lang) })}
        spark={trends.map((p) => p.penaltyTomans)}
        sparkAlt={t('stat.sparkAlt')}
        delta={
          delta
            ? {
                value: delta.value,
                goodWhen: 'down',
                format: (n) => formatTomansFullLocale(Math.abs(n), lang),
                ariaLabel: `${t('fin.trend.delta')}: ${formatNumberLocale(last.penaltyTomans, lang)} ${t('fin.trend.lastHour')}`,
              }
            : undefined
        }
        explain={{
          formula: t('fin.trend.formula'),
          inputs: [
            { label: t('fin.trend.window'), value: t('fin.trend.windowValue', { n: formatNumberLocale(analytics.windowHours, lang) }) },
            { label: t('fin.trend.buckets'), value: formatNumberLocale(trends.length, lang) },
            { label: t('fin.trend.lastHour'), value: formatTomansFullLocale(last.penaltyTomans, lang) },
          ],
          evidence: [{ label: t('evidence.incidentLedger'), href: '/incidents' }],
        }}
      />
    </div>
  )
}

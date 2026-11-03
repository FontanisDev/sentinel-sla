'use client'

// Sentinel-SLA — Notification health card (v2.2, executive view).
// The CEO-facing answer to "is the pipeline that pages us actually working?":
// channel status + delivery counts, and who is on duty right now.

import { useMemo } from 'react'
import { AlertTriangle, CalendarClock, Megaphone, Send } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatClock } from '@/lib/format'
import type { NotificationChannelDTO, OnCallEntryDTO } from '@/lib/types'
import { useLang } from '@/hooks/use-language'
import type { TranslationKey } from '@/lib/i18n'

const KIND_LABEL: Record<NotificationChannelDTO['kind'], TranslationKey> = {
  telegram: 'gov.channels.kind.telegram',
  bale: 'gov.channels.kind.bale',
  webhook: 'gov.channels.kind.webhook',
  email: 'gov.channels.kind.email',
  mattermost: 'gov.channels.kind.mattermost',
  jira: 'gov.channels.kind.jira',
  redmine: 'gov.channels.kind.redmine',
}

const STATUS_DOT: Record<NotificationChannelDTO['status'], string> = {
  healthy: 'bg-ok',
  degraded: 'bg-crit',
  disabled: 'bg-muted-foreground',
}

export function NotificationHealth({
  channels,
  onCall,
}: {
  channels: NotificationChannelDTO[]
  onCall: OnCallEntryDTO[]
}) {
  const { t } = useLang()

  const activeNow = useMemo(() => onCall.filter((o) => o.active), [onCall])
  const enabledChannels = channels.filter((c) => c.enabled)
  const degraded = channels.filter((c) => c.status === 'degraded')

  return (
    <Card className="sentinel-card-highlight gap-5 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Megaphone className="size-4 text-info" aria-hidden="true" />
          {t('gov.exec.title')}
          {degraded.length > 0 ? (
            <Badge variant="outline" className="gap-1 border-crit/30 bg-crit-subtle text-[10px] text-crit">
              <AlertTriangle className="size-3" aria-hidden="true" />
              {degraded.length}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>{t('gov.exec.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        {/* Channels + delivery counts */}
        <div className="space-y-2.5">
          <ul className="space-y-2">
            {channels.length === 0 ? (
              <li className="rounded-[6px] border border-dashed border-black/[0.08] dark:border-white/[0.08] px-3.5 py-4 text-xs text-muted-foreground">
                {t('gov.channels.empty.title')}
              </li>
            ) : (
              channels.map((c) => (
                <li
                  key={c.id}
                  className={cn(
                    'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[6px] border px-3.5 py-2.5',
                    c.enabled
                      ? 'border-black/[0.07] dark:border-white/[0.07] bg-surface-2'
                      : 'border-black/[0.05] dark:border-white/[0.05] bg-black/[0.02] dark:bg-white/[0.02]',
                  )}
                >
                  <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[c.status])} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="truncate">{c.name}</span>
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {t(KIND_LABEL[c.kind])}
                      </span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t('gov.exec.deliveries', { n: c.deliveredCount })}
                      {c.lastDeliveryAt ? ` — ${t('gov.channels.lastAt', { t: formatClock(c.lastDeliveryAt) })}` : ''}
                    </p>
                  </div>
                  <Send className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                </li>
              ))
            )}
          </ul>
          {enabledChannels.length === 0 && channels.length > 0 ? (
            <p className="text-[11px] text-crit">{t('gov.exec.nobody')}</p>
          ) : null}
        </div>

        {/* Who is on duty right now */}
        <div className="space-y-2.5">
          <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wider text-muted-foreground">
            <CalendarClock className="size-3.5" aria-hidden="true" />
            {t('gov.exec.onNow')}
          </p>
          {activeNow.length === 0 ? (
            <p className="flex items-start gap-2 rounded-[6px] border border-crit/25 bg-crit/[0.06] bg-crit/[0.06] px-3.5 py-3 text-xs text-crit">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t('gov.exec.nobody')}
            </p>
          ) : (
            <ul className="space-y-2">
              {activeNow.map((o) => (
                <li
                  key={o.id}
                  className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-[6px] border border-ok/25 bg-ok/[0.07] bg-ok/[0.07] px-3.5 py-2.5"
                >
                  <span className="text-sm font-medium">{o.engineerName}</span>
                  <Badge variant="outline" className="h-5 border-line bg-raised px-1.5 text-[10px] text-muted-foreground">
                    {o.role}
                  </Badge>
                  <span dir="ltr" className="ms-auto font-mono text-[11px] text-muted-foreground">{o.handle}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

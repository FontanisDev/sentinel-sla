'use client'

import { useEffect, useRef } from 'react'
import {
  BellRing,
  CircleCheck,
  Radio,
  Send,
  ShieldOff,
  Siren,
  TriangleAlert,
  Webhook,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { formatClock } from '@/lib/format'
import { useLang } from '@/hooks/use-language'
import type { AlertDTO, MaintenanceWindowDTO } from '@/lib/types'
import { AUDIENCE } from './status'
import { EmptyState } from './empty-state'

const SEVERITY_ICON = {
  critical: { icon: Siren, className: 'text-crit' },
  warning: { icon: TriangleAlert, className: 'text-warn' },
  info: { icon: CircleCheck, className: 'text-ok' },
} as const

/** v2.6: origin markers parsed out of bracketed alert titles. Distinct from
 * severity (which the icon already encodes): escalation pages and policy-rule
 * firings get their own chip so their source is scannable in the feed. */
function parseOrigin(title: string): { chip: string; cls: string; clean: string } | null {
  const m = title.match(/^\[(ESCALATION|rule)\]\s*/i)
  if (!m) return null
  const kind = m[1].toLowerCase()
  return {
    chip: kind === 'escalation' ? 'ESC' : 'RULE',
    cls:
      kind === 'escalation'
        ? 'border-warn/25 bg-warn text-warn border-warn/25 bg-warn text-warn'
        : 'border-info/25 bg-info text-info border-info/25 bg-info text-info',
    clean: title.slice(m[0].length),
  }
}

/** Channel → icon (telegram / webhook / fallback radio). Shared with the
 *  /incidents/[id] evidence panel so notification rows look the same. */
export function ChannelIcon({ channel }: { channel: string }) {
  const cls = 'size-3.5 text-muted-foreground/80'
  if (channel === 'telegram') return <Send className={cls} aria-hidden="true" />
  if (channel === 'webhook') return <Webhook className={cls} aria-hidden="true" />
  return <Radio className={cls} aria-hidden="true" />
}

export function AlertsFeed({
  alerts,
  maintenanceWindows,
}: {
  alerts: AlertDTO[]
  /** active maintenance windows — shown as a suppression chip when present */
  maintenanceWindows?: MaintenanceWindowDTO[]
}) {
  const { t } = useLang()
  const cardRef = useRef<HTMLDivElement>(null)
  const newestId = useRef<string | null>(null)
  const primed = useRef(false)
  const activeWindows = (maintenanceWindows ?? []).filter((w) => w.status === 'active')

  useEffect(() => {
    if (alerts.length === 0) return
    const id = alerts[0]?.id ?? null
    if (!primed.current) {
      primed.current = true
      newestId.current = id
      return
    }
    if (id && id !== newestId.current) {
      newestId.current = id
      // Restart the one-shot flash animation imperatively (no re-render needed).
      const el = cardRef.current
      if (el) {
        el.classList.remove('sentinel-flash')
        void el.offsetWidth // force reflow so the animation restarts
        el.classList.add('sentinel-flash')
      }
    }
    newestId.current = id
  }, [alerts])

  return (
    <div ref={cardRef} className="rounded-[6px]">
      <Card className="sentinel-card-highlight gap-4 rounded-[6px] shadow-none">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <BellRing className="size-4 text-info" aria-hidden="true" />
            {t('alerts.title')}
            <span className="flex items-center gap-1.5 rounded-full border border-black/[0.08] dark:border-white/[0.08] bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <span className="size-1.5 animate-status-pulse bg-ok" aria-hidden="true" />
              {t('alerts.live')}
            </span>
            {activeWindows.length > 0 ? (
              <span
                className="flex items-center gap-1.5 rounded-full border border-warn/30 bg-warn-subtle px-2 py-0.5 text-[10px] font-medium text-warn"
                title={activeWindows.map((w) => `${w.serviceName ?? t('maint.fleet')}: ${w.reason}`).join('\n')}
              >
                <ShieldOff className="size-3" aria-hidden="true" />
                {t('maint.active')}
              </span>
            ) : null}
          </CardTitle>
          <CardDescription>{t('alerts.desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {alerts.length === 0 ? (
            <EmptyState
              icon={BellRing}
              title={t('alerts.empty.title')}
              description={t('alerts.empty.desc')}
              className="py-8"
            />
          ) : (
            <ScrollArea className="sentinel-scroll h-96 rounded-[6px] border bg-surface-1">
              <ul className="divide-y divide-white/[0.04]" aria-label={t('alerts.title')}>
                {alerts.map((a) => {
                  const sev = SEVERITY_ICON[a.severity] ?? SEVERITY_ICON.info
                  const SevIcon = sev.icon
                  const aud = AUDIENCE[a.audience] ?? AUDIENCE.technical
                  const origin = parseOrigin(a.title)
                  const isEscalation = origin?.chip === 'ESC'
                  return (
                    <li
                      key={a.id}
                      className={cn(
                        'flex gap-3 px-4 py-2.5 transition-colors',
                        // urgent pages read as urgent: escalation rows keep a
                        // faint amber wash so they jump out of the feed
                        isEscalation && 'bg-warn/[0.045] bg-warn/[0.045]',
                      )}
                    >
                      <SevIcon className={cn('mt-0.5 size-4 shrink-0', sev.className, isEscalation && 'animate-status-pulse')} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          {origin ? (
                            <Badge variant="outline" className={cn('shrink-0 px-1.5 text-[9px] font-semibold tracking-wide', origin.cls)}>
                              {origin.chip}
                            </Badge>
                          ) : null}
                          <span className="truncate text-xs font-medium text-foreground">{origin ? origin.clean : a.title}</span>
                          <Badge variant="outline" className={cn('px-1.5 text-[9px]', aud.chip)}>
                            {t(aud.label)}
                          </Badge>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                          {a.message}
                        </p>
                        <p className="mt-1 text-[10px] text-muted-foreground">{a.serviceName}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end justify-between gap-1">
                        <span className="text-[10px] tabular-nums text-muted-foreground">
                          {formatClock(a.sentAt)}
                        </span>
                        <ChannelIcon channel={a.channel} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

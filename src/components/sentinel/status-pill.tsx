'use client'

import { cn } from '@/lib/utils'
import type { ServiceDTO } from '@/lib/types'
import { useLang } from '@/hooks/use-language'

type PillState = 'up' | 'degraded' | 'down'

interface PillConfig {
  label: string
  short: string
  dot: string
  text: string
  bg: string
  pulse: boolean
}

export function StatusPill({ services, className }: { services: ServiceDTO[]; className?: string }) {
  const { t, isFa } = useLang()
  const down = services.filter((s) => s.status === 'down').length
  const degraded = services.filter((s) => s.status === 'degraded').length

  // English pluralizes "{n} service(s)"; Persian needs no plural marker.
  const plural = (n: number) => (isFa || n === 1 ? '' : 's')

  const config: Record<PillState, PillConfig> = {
    up: {
      label: t('pill.allOperational'),
      short: t('pill.operationalShort'),
      dot: 'bg-ok',
      text: 'text-ok',
      bg: 'border-ok/20 bg-ok-subtle',
      pulse: false,
    },
    degraded: {
      label: t('pill.nDegraded', { n: degraded, s: plural(degraded) }),
      short: t('pill.nDegradedShort', { n: degraded }),
      dot: 'bg-warn',
      text: 'text-warn',
      bg: 'border-warn/25 bg-warn-subtle',
      pulse: false,
    },
    down: {
      label: t('pill.nDown', { n: down, s: plural(down) }),
      short: t('pill.nDownShort', { n: down }),
      dot: 'bg-crit',
      text: 'text-crit',
      bg: 'border-crit/25 bg-crit-subtle',
      pulse: true,
    },
  }

  const state: PillState = down > 0 ? 'down' : degraded > 0 ? 'degraded' : 'up'
  const c = config[state]

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={c.label}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-2 rounded-full border px-2 text-[11px] font-medium tracking-wide sm:px-3',
        c.bg,
        c.text,
        !isFa && 'uppercase',
        className
      )}
    >
      <span className="relative flex size-2">
        {c.pulse ? (
          <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', c.dot)} />
        ) : null}
        <span className={cn('relative inline-flex size-2 rounded-full', c.dot)} />
      </span>
      {/* xs: dot only (budget for brand + role switcher); sm–md: short; md+: full */}
      <span className="hidden whitespace-nowrap md:inline">{c.label}</span>
      <span className="hidden whitespace-nowrap sm:inline md:hidden">{c.short}</span>
    </div>
  )
}

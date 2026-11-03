'use client'

// honest deployment-mode badge ("show it
// in the UI"). Demo = amber "simulation" chip; Live = emerald pulsing dot.
// The tooltip spells out what each mode means so nobody mistakes simulated
// numbers for real ones.

import { useLang } from '@/hooks/use-language'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function ModeBadge({ deploymentMode }: { deploymentMode: 'demo' | 'live' | undefined }) {
  const { t } = useLang()
  if (!deploymentMode) return null

  const isLive = deploymentMode === 'live'
  const label = isLive ? t('mode.badge.live') : t('mode.badge.demo')
  const tip = isLive ? t('mode.badge.liveTip') : t('mode.badge.demoTip')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-label={label}
          className={
            'inline-flex select-none items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ' +
            // subtle tint + colored text — never `bg-warn text-warn` (label
            // painted on itself is unreadable; caught in the round-24 UX pass)
            (isLive
              ? 'border-ok/30 bg-ok-subtle text-ok'
              : 'border-warn/30 bg-warn-subtle text-warn')
          }
        >
          {isLive ? (
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-ok opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-ok" />
            </span>
          ) : (
            <span className="size-1.5 rounded-full bg-warn" />
          )}
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-64 text-xs">
        {tip}
      </TooltipContent>
    </Tooltip>
  )
}

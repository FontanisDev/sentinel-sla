'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

export function LiveClock({ className }: { className?: string }) {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    // First tick via rAF (post-hydration) then every second.
    const raf = requestAnimationFrame(() => setNow(new Date()))
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(t)
    }
  }, [])

  return (
    <time
      className={cn('tabular-nums', className)}
      dateTime={now?.toISOString()}
      suppressHydrationWarning
    >
      {now ? now.toLocaleTimeString('en-GB', { hour12: false }) : '--:--:--'}
    </time>
  )
}

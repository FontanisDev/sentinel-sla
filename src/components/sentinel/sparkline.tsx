'use client'

import { useMemo } from 'react'
import { Line, LineChart, ResponsiveContainer } from 'recharts'
import { cn } from '@/lib/utils'

/** Decorative latency sparkline — last 40 points, no axes. */
export function Sparkline({
  values,
  color,
  className,
}: {
  values: number[]
  color: string
  className?: string
}) {
  const data = useMemo(() => values.slice(-40).map((v, i) => ({ i, v })), [values])

  if (data.length < 2) {
    return <div className={cn('h-9 w-full', className)} aria-hidden="true" />
  }

  return (
    <div className={cn('h-9 w-full', className)} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 3, right: 0, bottom: 3, left: 0 }}>
          <Line
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

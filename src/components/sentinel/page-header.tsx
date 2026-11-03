'use client'

// PageHeader (docs/DESIGN-SYSTEM.md): title, description, primary
// actions. 20/28 page title per the type scale; actions align on the inline end.

import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold leading-7 tracking-tight text-t1">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-[13px] leading-5 text-t2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

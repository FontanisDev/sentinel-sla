import { cn } from '@/lib/utils'

export function SectionHeader({
  title,
  description,
  badge,
  actions,
  className,
}: {
  title: string
  description?: string
  badge?: string
  /** right-aligned action cluster (export buttons, links, …) */
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-2', className)}>
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
          <span
            aria-hidden="true"
            className="inline-block h-3.5 w-[3px] rounded-full bg-brand"
          />
          {title}
        </h2>
        {description ? (
          <p className="mt-0.5 ps-[11px] text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {badge ? (
          <span className="rounded-full border border-black/[0.08] dark:border-white/[0.08] bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {badge}
          </span>
        ) : null}
        {actions}
      </div>
    </div>
  )
}

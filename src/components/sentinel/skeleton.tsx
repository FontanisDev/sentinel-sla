import { Skeleton } from '@/components/ui/skeleton'

export function DashboardSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading dashboard">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-[6px] bg-surface-1" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-[320px] rounded-[6px] bg-surface-1" />
        <Skeleton className="h-[320px] rounded-[6px] bg-surface-1" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[280px] rounded-[6px] bg-surface-1" />
        ))}
      </div>
      <Skeleton className="h-[420px] rounded-[6px] bg-surface-1" />
      <Skeleton className="h-[480px] rounded-[6px] bg-surface-1" />
    </div>
  )
}

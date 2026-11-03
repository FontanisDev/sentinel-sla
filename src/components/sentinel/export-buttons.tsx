'use client'

// Sentinel-SLA — data export buttons (v2.1).
// Plain anchor downloads: the API sets Content-Disposition: attachment, so
// no client-side blob handling is needed. Scope follows the active tenant.

import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useLang } from '@/hooks/use-language'

export type ExportKind = 'incidents' | 'services' | 'analytics'

/**
 * Compact CSV/JSON download buttons for an export endpoint.
 * `analytics` only offers JSON (nested DTO — CSV would be lossy).
 */
export function ExportButtons({
  kind,
  tenantId,
  className,
}: {
  kind: ExportKind
  /** active tenant scope (null = fleet-wide) */
  tenantId: string | null
  className?: string
}) {
  const { t } = useLang()
  const formats: ('csv' | 'json')[] = kind === 'analytics' ? ['json'] : ['csv', 'json']

  const href = (format: 'csv' | 'json') => {
    const params = new URLSearchParams({ format })
    if (tenantId) params.set('tenant', tenantId)
    return `/api/export/${kind}?${params.toString()}`
  }

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      {formats.map((f) => (
        <Button
          key={f}
          asChild
          variant="outline"
          size="sm"
          className="h-7 gap-1 border-black/[0.08] dark:border-white/[0.08] bg-surface-2 px-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <a
            href={href(f)}
            download
            aria-label={f === 'csv' ? t('export.csv') : t('export.json')}
            title={f === 'csv' ? t('export.csv') : t('export.json')}
          >
            <Download className="size-3" aria-hidden="true" />
            {f}
          </a>
        </Button>
      ))}
    </div>
  )
}

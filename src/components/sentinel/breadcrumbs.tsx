'use client'

// Breadcrumbs (docs/DESIGN-SYSTEM.md) — logical-property layout,
// RTL-safe. The last crumb is the current page (aria-current, no link).

import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useLang } from '@/hooks/use-language'
import { cn } from '@/lib/utils'

export interface Crumb {
  label: string
  href?: string
}

export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  const { dir } = useLang()
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight

  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-0', className)}>
      <ol className="flex items-center gap-1 text-[12px] text-t2">
        {items.map((crumb, i) => {
          const last = i === items.length - 1
          return (
            <li key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1">
              {i > 0 && <Chevron className="size-3 shrink-0 text-t3" aria-hidden="true" />}
              {crumb.href && !last ? (
                <Link
                  href={crumb.href}
                  className="truncate rounded-[4px] transition-colors duration-150 hover:text-t1"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className={cn('truncate', last && 'font-medium text-t1')} aria-current={last ? 'page' : undefined}>
                  {crumb.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

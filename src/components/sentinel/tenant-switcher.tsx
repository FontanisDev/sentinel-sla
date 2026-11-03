'use client'

// Sentinel-SLA — tenant scope switcher (v2 multi-tenancy).
// Compact shadcn Select: "All tenants" (fleet-wide) or a single client company.
// The backend scopes every KPI, service, incident and analytic to the choice.

import { Building2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useLang } from '@/hooks/use-language'
import type { TenantDTO } from '@/lib/types'

const ALL_VALUE = 'all'

export function TenantSwitcher({
  tenants,
  value,
  onChange,
  className,
}: {
  tenants: TenantDTO[]
  value: string | null
  onChange: (tenantId: string | null) => void
  className?: string
}) {
  const { t, name } = useLang()
  const selected = tenants.find((x) => x.id === value) ?? null

  return (
    <Select
      value={value ?? ALL_VALUE}
      onValueChange={(v) => onChange(v === ALL_VALUE ? null : v)}
    >
      <SelectTrigger
        size="sm"
        aria-label={`${t('tenant.selector')}: ${selected ? name(selected.name, selected.nameFa) : t('tenant.all')}`}
        className={cn(
          'h-8 w-[132px] gap-1.5 rounded-lg border-black/[0.08] dark:border-white/[0.08] bg-surface-2 px-2.5 text-xs font-medium text-foreground shadow-none hover:bg-surface-3 sm:w-[168px]',
          selected && 'border-ok/25 bg-ok/[0.07] bg-ok/[0.07]',
          className
        )}
      >
        <Building2
          className={cn('size-3.5 shrink-0', selected ? 'text-ok' : 'text-muted-foreground')}
          aria-hidden="true"
        />
        {/* Controlled trigger text — the dropdown items carry richer content */}
        <SelectValue>
          <span className="truncate">{selected ? name(selected.name, selected.nameFa) : t('tenant.all')}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-[220px]">
        <SelectGroup>
          <SelectLabel className="text-[10px] font-medium uppercase tracking-wider">
            {t('tenant.selector')}
          </SelectLabel>
          <SelectItem value={ALL_VALUE} className="gap-2 py-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium">{t('tenant.all')}</span>
            </span>
            <span className="ms-auto flex items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground">
              {t('tenant.services', { n: tenants.reduce((acc, x) => acc + x.servicesCount, 0) })}
            </span>
          </SelectItem>
          {tenants.map((tenant) => {
            const display = name(tenant.name, tenant.nameFa)
            return (
              <SelectItem key={tenant.id} value={tenant.id} className="gap-2 py-2">
                <span className="flex min-w-0 items-center gap-2">
                  <Building2
                    className={cn(
                      'size-3.5 shrink-0',
                      tenant.id === value ? 'text-ok' : 'text-muted-foreground'
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate font-medium">{display}</span>
                  {tenant.nameFa && display === tenant.name ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground" lang="fa">
                      {tenant.nameFa}
                    </span>
                  ) : null}
                </span>
                <span className="ms-auto flex items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground">
                  {t('tenant.services', { n: tenant.servicesCount })}
                </span>
              </SelectItem>
            )
          })}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

'use client'

// The heavy half of the command palette (design system §6.12): the cmdk
// dialog listing pages, services and recent incidents. Split out of
// command-palette.tsx so AppShell ships only the tiny keyboard launcher;
// this module streams in on the FIRST ⌘K (performance budget).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { useLang } from '@/hooks/use-language'
import { DASHBOARD_KEY, useDashboard } from '@/hooks/use-sentinel'
import type { ServiceDTO, IncidentDTO } from '@/lib/types'
import { cn } from '@/lib/utils'
import { palettePages } from './command-palette-data'

export function CommandPalette({
  tenantId,
  open,
  onOpenChange,
}: {
  tenantId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t, name } = useLang()
  const router = useRouter()
  const queryClient = useQueryClient()
  // Shared react-query cache — no extra polling; the shell already warms it.
  const { data } = useDashboard(tenantId)

  const pages = useMemo(() => palettePages(), [])

  const run = useCallback(
    (fn: () => void) => {
      onOpenChange(false)
      fn()
    },
    [onOpenChange],
  )

  const goPage = useCallback(
    (href: string) =>
      run(() => {
        router.push(href)
      }),
    [run, router],
  )

  const goService = useCallback(
    (s: ServiceDTO) =>
      run(() => {
        // Straight to the full-page detail record — the palette is
        // navigation, not a search box; ?q= stays for evidence deep links.
        router.push(`/services/${encodeURIComponent(s.key)}`)
      }),
    [run, router],
  )

  const goIncident = useCallback(
    (inc: IncidentDTO) =>
      run(() => {
        // Straight to the full-page detail record — the palette is
        // navigation, not a search box; ?q= stays for evidence deep links.
        router.push(`/incidents/${encodeURIComponent(inc.id)}`)
      }),
    [run, router],
  )

  // Refresh the dashboard cache on open so recent incidents are fresh.
  useEffect(() => {
    if (open) void queryClient.invalidateQueries({ queryKey: DASHBOARD_KEY })
  }, [open, queryClient])

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('palette.open')}
      description={t('palette.hint')}
      className="border-line bg-surface sm:max-w-xl"
      showCloseButton={false}
    >
      <CommandInput
        placeholder={t('palette.placeholder')}
        className="text-[13px] text-t1 placeholder:text-t3"
      />
      <CommandList className="max-h-[380px]">
        <CommandEmpty className="py-8 text-[13px] text-t2">{t('palette.empty')}</CommandEmpty>

        <CommandGroup heading={t('palette.group.pages')}>
          {pages.map((p) => {
            const Icon = p.icon
            return (
              <CommandItem
                key={p.href}
                value={`${p.href} ${t(p.label)}`}
                onSelect={() => goPage(p.href)}
                className="gap-2.5 rounded-[4px] text-[13px] text-t2 aria-selected:bg-raised aria-selected:text-t1"
              >
                <Icon className="size-4 shrink-0 text-t3" aria-hidden="true" />
                <span className="flex-1 truncate">{t(p.label)}</span>
                {p.shortcut ? (
                  <CommandShortcut className="font-mono text-[11px] tracking-normal text-t3">
                    {p.shortcut}
                  </CommandShortcut>
                ) : null}
              </CommandItem>
            )
          })}
        </CommandGroup>

        {data && data.services.length > 0 ? (
          <>
            <CommandSeparator className="bg-line" />
            <CommandGroup heading={t('palette.group.services')}>
              {data.services.map((s) => (
                <CommandItem
                  key={s.id}
                  value={`${s.key} ${s.name} ${s.nameFa ?? ''} ${s.endpoint} ${t('palette.group.services')}`}
                  onSelect={() => goService(s)}
                  className="gap-2.5 rounded-[4px] text-[13px] text-t2 aria-selected:bg-raised aria-selected:text-t1"
                >
                  <ServiceDot status={s.status} />
                  <span className="flex-1 truncate">{name(s.name, s.nameFa)}</span>
                  <span dir="ltr" className="font-mono text-[11px] text-t3">
                    {s.key}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {data && data.incidents.length > 0 ? (
          <>
            <CommandSeparator className="bg-line" />
            <CommandGroup heading={t('palette.group.incidents')}>
              {data.incidents.slice(0, 10).map((inc) => (
                <CommandItem
                  key={inc.id}
                  value={`${inc.id} ${inc.serviceName} ${inc.status} ${inc.severity}`}
                  onSelect={() => goIncident(inc)}
                  className="gap-2.5 rounded-[4px] text-[13px] text-t2 aria-selected:bg-raised aria-selected:text-t1"
                >
                  <IncidentDot ongoing={inc.status === 'ongoing'} crit={inc.severity === 'critical'} />
                  <span className="flex-1 truncate">{inc.serviceName}</span>
                  <span className="font-mono text-[11px] text-t3">
                    {t(inc.status === 'ongoing' ? 'istatus.ongoing' : 'istatus.resolved')}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>

      <div className="border-t border-line bg-inset px-3 py-1.5 text-[11px] text-t3">
        {t('palette.hint')}
      </div>
    </CommandDialog>
  )
}

function ServiceDot({ status }: { status: ServiceDTO['status'] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-2 shrink-0 rounded-full',
        status === 'up' && 'bg-ok',
        status === 'degraded' && 'bg-warn',
        status === 'down' && 'bg-crit',
      )}
    />
  )
}

function IncidentDot({ ongoing, crit }: { ongoing: boolean; crit: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-2 shrink-0 rounded-full',
        !ongoing && 'bg-t3/40',
        ongoing && crit && 'bg-crit',
        ongoing && !crit && 'bg-warn',
      )}
    />
  )
}

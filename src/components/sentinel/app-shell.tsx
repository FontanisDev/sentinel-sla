'use client'

// Sentinel-SLA — AppShell (docs/DESIGN-SYSTEM.md).
//
// Left navigation (232 px expanded / 56 px icons-only, collapsible) + top bar
// (breadcrumbs slot · demo banner · tenant switcher · engine controls ·
// language · theme · account) + content area. In RTL the navigation sits on
// the RIGHT automatically — every utility here is logical (ps-/pe-/ms-/me-,
// border-e/border-s); physical left/right is forbidden in new code.
//
// Role-awareness: the navigation shows the groups relevant to the signed-in
// role. The
// Executive home is a separate page (/executive), never a toggle.

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  Activity,
  BellRing,
  ChevronLeft,
  ChevronRight,
  FileText,
  Gauge,
  Handshake,
  HeartPulse,
  LayoutDashboard,
  LogOut,
  PanelsTopLeft,
  Radio,
  ScrollText,
  Settings2,
  Siren,
  Users,
  Wrench,
} from 'lucide-react'
import { useLang, setLang } from '@/hooks/use-language'
import type { TranslationKey } from '@/lib/i18n'
import {
  getServerTenantSnapshot,
  getTenantSnapshot,
  setStoredTenant,
  subscribeTenant,
  useDashboard,
} from '@/hooks/use-sentinel'
import { ModeBadge } from '@/components/sentinel/mode-badge'
import { TenantSwitcher } from '@/components/sentinel/tenant-switcher'
import { EngineControls } from '@/components/sentinel/engine-controls'
import { LanguageToggle } from '@/components/sentinel/language-toggle'
import { ThemeToggle } from '@/components/sentinel/theme-toggle'
import { Breadcrumbs, type Crumb } from '@/components/sentinel/breadcrumbs'
import { CommandPaletteRoot } from '@/components/sentinel/command-palette'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface AppShellUser {
  name: string
  email: string
  role: string
  /** account language preference (users.locale) — seeds the UI on a browser
   *  that has never chosen a language (journey 6: an fa-locale executive gets
   *  the Persian home on first sign-in). An explicit in-browser toggle always
   *  stays sticky afterwards. */
  locale?: string | null
}

interface NavItemDef {
  href: string
  label: TranslationKey
  icon: React.ComponentType<{ className?: string }>
  /** minimum role that sees this destination in the nav (RBAC parity with
   *  the server guards — a viewer never gets links the API will 403) */
  minRole?: 'admin' | 'engineer'
}

interface NavGroupDef {
  label: TranslationKey
  items: NavItemDef[]
}

const ROLE_RANK: Record<string, number> = {
  owner: 50,
  admin: 40,
  engineer: 30,
  executive: 20,
  viewer: 10,
}

/** Navigation inventory — routes land here as their pages are built. */
function navGroups(role: string | undefined): NavGroupDef[] {
  const rank = ROLE_RANK[role ?? 'viewer'] ?? 10
  const all: NavGroupDef[] = [
    {
      label: 'nav.group.overview',
      items: [
        { href: '/', label: 'nav.overview', icon: LayoutDashboard },
        { href: '/executive', label: 'nav.executive', icon: PanelsTopLeft },
      ],
    },
    { label: 'nav.group.services', items: [{ href: '/services', label: 'nav.services', icon: Activity }] },
    { label: 'nav.group.incidents', items: [{ href: '/incidents', label: 'nav.incidents', icon: Siren }] },
    {
      label: 'nav.group.contracts',
      items: [{ href: '/contracts', label: 'nav.contracts', icon: Handshake }],
    },
    { label: 'nav.group.reports', items: [{ href: '/reports', label: 'nav.reports', icon: FileText }] },
    {
      label: 'nav.group.alerting',
      items: [
        { href: '/alerting/channels', label: 'alerting.nav.channels', icon: Radio },
        { href: '/alerting/rules', label: 'alerting.nav.rules', icon: BellRing },
        { href: '/alerting/oncall', label: 'alerting.nav.oncall', icon: Users },
        { href: '/alerting/maintenance', label: 'alerting.nav.maintenance', icon: Wrench },
      ],
    },
    {
      label: 'nav.group.resilience',
      items: [{ href: '/resilience', label: 'nav.resilience', icon: HeartPulse }],
    },
    {
      label: 'nav.group.settings',
      items: [
        { href: '/settings/users', label: 'nav.settings.users', icon: Users, minRole: 'admin' },
        { href: '/settings/services', label: 'nav.settings.services', icon: Settings2, minRole: 'engineer' },
        { href: '/settings/integrations', label: 'nav.settings.integrations', icon: Gauge, minRole: 'engineer' },
        { href: '/settings/audit', label: 'nav.settings.audit', icon: ScrollText, minRole: 'admin' },
      ],
    },
  ]
  // drop items the role cannot use, then drop groups left empty
  return all
    .map((g) => ({
      ...g,
      items: g.items.filter((it) => {
        if (!it.minRole) return true
        return rank >= ROLE_RANK[it.minRole]
      }),
    }))
    .filter((g) => g.items.length > 0)
}

const COLLAPSE_KEY = 'sentinel-nav-collapsed'

function subscribeCollapse(cb: () => void) {
  window.addEventListener('storage', cb)
  return () => window.removeEventListener('storage', cb)
}

function getCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

function getCollapsedServer(): boolean {
  return false
}

export function AppShell({
  user,
  crumbs,
  children,
}: {
  user: AppShellUser
  crumbs?: Crumb[]
  children: React.ReactNode
}) {
  const { t, dir, isFa } = useLang()
  const pathname = usePathname()
  const router = useRouter()

  // Tenant scope — shared with every page through the same external store.
  const tenantId = useSyncExternalStore(subscribeTenant, getTenantSnapshot, getServerTenantSnapshot)
  const handleTenantChange = useCallback((next: string | null) => setStoredTenant(next), [])
  const { data } = useDashboard(tenantId)

  const collapsed = useSyncExternalStore(subscribeCollapse, getCollapsed, getCollapsedServer)
  const toggleCollapsed = useCallback(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '0' : '1')
    } catch {
      /* ignore — collapse still applies for this render */
    }
    window.dispatchEvent(new Event('storage'))
  }, [collapsed])

  // Keep the document's lang/dir in sync for assistive tech.
  useEffect(() => {
    document.documentElement.lang = isFa ? 'fa' : 'en'
    document.documentElement.dir = dir
  }, [isFa, dir])

  // §6 language: honour the ACCOUNT's locale on a browser that has never
  // explicitly picked one. Runs once per mount; setLang persists the choice so
  // this never fights the language toggle afterwards.
  useEffect(() => {
    if (user.locale !== 'fa' && user.locale !== 'en') return
    try {
      if (window.localStorage.getItem('sentinel-lang') === null) {
        setLang(user.locale)
      }
    } catch {
      /* storage unavailable — the toggle fallback already covers this */
    }
  }, [user.locale])

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
    router.refresh()
  }, [router])

  const groups = navGroups(user.role)
  const demoMode = data?.engine?.deploymentMode === 'demo'

  return (
    <div dir={dir} className={cn('flex min-h-screen bg-app', isFa && 'font-fa')}>
      <a
        href="#sentinel-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:start-2 focus:z-50 focus:rounded-[4px] focus:bg-raised focus:px-3 focus:py-2 focus:text-t1"
      >
        {t('shell.skipToContent')}
      </a>

      {/* ── navigation ─────────────────────────────────────────────────── */}
      <nav
        aria-label="Primary"
        className={cn(
          'sticky top-0 flex h-screen shrink-0 flex-col border-e border-line bg-nav transition-[width] duration-150',
          collapsed ? 'w-14' : 'w-[232px]',
        )}
      >
        {/* brand */}
        <div className={cn('flex h-12 items-center gap-2 border-b border-line px-3', collapsed && 'justify-center px-0')}>
          <Link href="/" className="flex items-center gap-2 rounded-[4px]">
            <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-[4px] bg-brand text-[13px] font-bold text-brand-contrast">
              S
            </span>
            {!collapsed && (
              <span className="text-sm font-semibold tracking-tight text-t1">
                Sentinel<span className="text-t2">-SLA</span>
              </span>
            )}
          </Link>
        </div>

        {/* groups */}
        <div className="sentinel-scroll-native flex-1 overflow-y-auto py-2">
          {groups.map((group) => (
            <div key={group.label} className="mb-1">
              {!collapsed ? (
                <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-t3">
                  {t(group.label)}
                </p>
              ) : (
                <div className="mx-2 my-2 border-t border-line" />
              )}
              <ul>
                {group.items.map((item) => {
                  const active =
                    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
                  const Icon = item.icon
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        title={collapsed ? t(item.label) : undefined}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'relative flex items-center gap-2.5 px-3 py-1.5 text-[13px] transition-colors duration-150',
                          collapsed && 'justify-center px-0',
                          active
                            ? 'bg-raised font-medium text-t1 before:absolute before:start-0 before:top-0 before:h-full before:w-[2px] before:bg-brand'
                            : 'text-t2 hover:bg-raised hover:text-t1',
                        )}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        {!collapsed && <span className="truncate">{t(item.label)}</span>}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>

        {/* collapse control */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          className="flex h-9 items-center justify-center border-t border-line text-t3 transition-colors duration-150 hover:text-t1"
        >
          {dir === 'rtl' ? (
            collapsed ? <ChevronLeft className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />
          ) : (
            collapsed ? <ChevronRight className="size-4" aria-hidden="true" /> : <ChevronLeft className="size-4" aria-hidden="true" />
          )}
        </button>
      </nav>

      {/* ── main column ────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* top bar */}
        <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-line bg-app/95 px-4 backdrop-blur">
          <div className="min-w-0 flex-1">
            <Breadcrumbs items={crumbs ?? [{ label: t('crumb.home') }]} />
          </div>

          {demoMode && <ModeBadge deploymentMode="demo" />}

          {data && data.tenants.length > 0 && (
            <TenantSwitcher tenants={data.tenants} value={tenantId} onChange={handleTenantChange} className="w-[150px]" />
          )}

          {demoMode && data?.engine && <EngineControls engine={data.engine} />}

          <LanguageToggle className="scale-90" />
          <ThemeToggle className="scale-90" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${t('shell.user.menu')}: ${user.name}`}
                className="h-8 gap-2 px-2 text-t2 hover:text-t1"
              >
                {/* initials are CSS-generated content, not DOM text: the
                    accessible name stays the aria-label (label-in-name ✓ at
                    every viewport, incl. mobile where the name is hidden) */}
                <span
                  aria-hidden="true"
                  data-initials={user.name.slice(0, 2)}
                  className="sentinel-initials grid size-6 place-items-center rounded-full bg-raised text-[10px] font-semibold uppercase text-t2"
                />
                <span className="hidden max-w-[120px] truncate text-xs sm:inline">{user.name}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <p className="text-[10px] font-medium uppercase tracking-wider text-t3">{t('shell.user.signedInAs')}</p>
                <p className="truncate text-sm font-medium text-t1">{user.name}</p>
                <p className="truncate text-xs text-t2">{user.email}</p>
                <p className="mt-1 inline-flex rounded-[4px] border border-line bg-raised px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-t2">
                  {user.role}
                </p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void logout()} className="text-crit focus:text-crit">
                <LogOut className="size-4" aria-hidden="true" />
                {t('shell.user.logout')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* demo banner (doc §7 rule 7): slim, permanent, honest.
            contrast audit: warn-subtle over the page bg gave 4.35:1 in light —
            a 7 % tint keeps the amber strip while text passes (4.69 light / 5.85 dark) */}
        {demoMode && (
          <div
            role="note"
            className="border-b border-line bg-warn/[0.07] px-4 py-1 text-center text-[12px] font-medium text-warn"
          >
            {t('shell.demoBanner')}
          </div>
        )}

        <main id="sentinel-content" className="mx-auto w-full max-w-[1680px] flex-1 px-4 py-6 sm:px-6">
          {children}
        </main>
      </div>

      {/* ⌘K palette + `?` shortcut help + g-sequence navigation (§6.12/§7.8) */}
      <CommandPaletteRoot tenantId={tenantId} />
    </div>
  )
}

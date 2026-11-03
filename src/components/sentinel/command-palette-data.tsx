'use client'

// Palette + shortcut DATA (design system §6.12 / §7.8) — shared by the light
// launcher (command-palette.tsx) and the heavy dialog (command-dialog.tsx).
// Kept in its own module so the launcher bundle does not pull cmdk in.

import {
  Activity,
  BellRing,
  FileText,
  Handshake,
  HeartPulse,
  LayoutDashboard,
  PanelsTopLeft,
  Radio,
  ScrollText,
  Settings2,
  Siren,
  Users,
  Wrench,
} from 'lucide-react'
import type { TranslationKey } from '@/lib/i18n'

/** An entry in the shortcut help dialog. */
export interface ShortcutDef {
  keys: string[]
  label: TranslationKey
}

/** The `g`-sequence destinations (order = help-dialog order). */
export const GOTO_SHORTCUTS: readonly ShortcutDef[] = [
  { keys: ['g', 'h'], label: 'shortcuts.home' },
  { keys: ['g', 'e'], label: 'shortcuts.executive' },
  { keys: ['g', 's'], label: 'shortcuts.services' },
  { keys: ['g', 'i'], label: 'shortcuts.incidents' },
  { keys: ['g', 'c'], label: 'shortcuts.contracts' },
  { keys: ['g', 'r'], label: 'shortcuts.reports' },
] as const

export interface PalettePageDef {
  href: string
  label: TranslationKey
  icon: React.ComponentType<{ className?: string }>
  /** Keyboard hint shown on the row ("g i"). */
  shortcut?: string
}

/** Page inventory for the palette — mirrors the nav, plus a few extras. */
export function palettePages(): PalettePageDef[] {
  return [
    { href: '/', label: 'nav.overview', icon: LayoutDashboard, shortcut: 'g h' },
    { href: '/executive', label: 'nav.executive', icon: PanelsTopLeft, shortcut: 'g e' },
    { href: '/services', label: 'nav.services', icon: Activity, shortcut: 'g s' },
    { href: '/incidents', label: 'nav.incidents', icon: Siren, shortcut: 'g i' },
    { href: '/contracts', label: 'nav.contracts', icon: Handshake, shortcut: 'g c' },
    { href: '/reports', label: 'nav.reports', icon: FileText, shortcut: 'g r' },
    { href: '/resilience', label: 'nav.resilience', icon: HeartPulse },
    { href: '/alerting/channels', label: 'alerting.nav.channels', icon: Radio },
    { href: '/alerting/rules', label: 'alerting.nav.rules', icon: BellRing },
    { href: '/alerting/oncall', label: 'alerting.nav.oncall', icon: Users },
    { href: '/alerting/maintenance', label: 'alerting.nav.maintenance', icon: Wrench },
    { href: '/settings/users', label: 'nav.settings.users', icon: Users },
    { href: '/settings/services', label: 'nav.settings.services', icon: Settings2 },
    { href: '/settings/integrations', label: 'nav.settings.integrations', icon: ScrollText },
    { href: '/settings/audit', label: 'nav.settings.audit', icon: ScrollText },
  ]
}

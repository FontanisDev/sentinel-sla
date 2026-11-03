'use client'

// Sentinel-SLA — global shortcuts (§7.8) + the command-palette LAUNCHER.
//
// ⌘K / Ctrl+K opens the palette: jump to a page, service or recent incident.
// The `g`-sequence navigates without the palette (g i → incidents, g s →
// services, g h → home, g e → executive, g r → reports). `?` opens the
// shortcut help dialog. `/` stays owned by DataTable (focuses the table
// search). Shortcuts never fire while typing in a field.
//
// performance budget: this module stays TINY — it ships only the keyboard
// listener and the light help dialog. The cmdk dialog lives in
// command-dialog.tsx and is fetched on the first ⌘K via next/dynamic.

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLang } from '@/hooks/use-language'
import { GOTO_SHORTCUTS } from './command-palette-data'

// The heavy dialog — loaded on demand (first open), never in initial JS.
const CommandPalette = dynamic(
  () => import('./command-dialog').then((m) => m.CommandPalette),
  { ssr: false, loading: () => null },
)

// ── keyboard plumbing (§7.8) ────────────────────────────────────────────────

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

/** Global keyboard behaviour shared by the palette + the help dialog. */
export function useGlobalShortcuts(handlers: {
  onPalette: () => void
  onHelp: () => void
  paletteOpen: boolean
}) {
  const router = useRouter()
  const { onPalette, onHelp, paletteOpen } = handlers
  const goRef = useRef(router)
  useEffect(() => {
    goRef.current = router
  }, [router])

  useEffect(() => {
    let gAt: number | null = null

    const onKey = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K works everywhere, even while typing.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onPalette()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) {
        gAt = null
        return
      }
      if (e.key === '?') {
        e.preventDefault()
        onHelp()
        return
      }
      const now = Date.now()
      if (e.key === 'g' && gAt === null) {
        gAt = now
        return
      }
      if (gAt !== null && now - gAt <= 1500) {
        gAt = null
        const dest =
          e.key === 'h'
            ? '/'
            : e.key === 'e'
              ? '/executive'
              : e.key === 's'
                ? '/services'
                : e.key === 'i'
                  ? '/incidents'
                  : e.key === 'c'
                    ? '/contracts'
                    : e.key === 'r'
                      ? '/reports'
                      : null
        if (dest) {
          e.preventDefault()
          goRef.current.push(dest)
        }
      } else {
        gAt = null
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPalette, onHelp, paletteOpen])
}

// ── shortcuts help dialog (`?`) ─────────────────────────────────────────────

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useLang()

  const rows: Array<{ keys: string[]; label: string }> = [
    { keys: ['⌘', 'K'], label: t('shortcuts.openPalette') },
    ...GOTO_SHORTCUTS.map((s) => ({ keys: s.keys, label: t(s.label) })),
    { keys: ['/'], label: t('shortcuts.search') },
    { keys: ['?'], label: t('shortcuts.help') },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="border-line bg-surface sm:max-w-sm"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="text-base font-semibold text-t1">
            {t('shortcuts.title')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('shortcuts.title')}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-3 text-[13px]">
              <span className="text-t2">{row.label}</span>
              <span className="flex items-center gap-1" dir="ltr">
                {row.keys.map((k, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-[11px] text-t3">{t('shortcuts.sequence')}</span>}
                    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-[4px] border border-line bg-inset px-1.5 font-mono text-[11px] text-t1">
                      {k}
                    </kbd>
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

/** Mounted once in AppShell — owns open state for palette + help. */
export function CommandPaletteRoot({ tenantId }: { tenantId: string | null }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  const openPalette = useCallback(() => {
    setHelpOpen(false)
    setPaletteOpen((v) => !v)
  }, [])
  const openHelp = useCallback(() => {
    setPaletteOpen(false)
    setHelpOpen(true)
  }, [])

  useGlobalShortcuts({ onPalette: openPalette, onHelp: openHelp, paletteOpen })

  return (
    <>
      {/* Conditional mount: the cmdk chunk is fetched on the first open only. */}
      {paletteOpen ? (
        <CommandPalette tenantId={tenantId} open={paletteOpen} onOpenChange={setPaletteOpen} />
      ) : null}
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  )
}

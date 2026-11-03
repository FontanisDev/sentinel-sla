'use client'

import { useSyncExternalStore } from 'react'
import { useTheme } from 'next-themes'
import { Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useLang } from '@/hooks/use-language'

const noopSubscribe = () => () => {}

/** Hydration-safe "mounted" flag without setState-in-effect (react-hooks v6). */
function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  )
}

/**
 * Light/dark mission-control theme toggle.
 * Dark is the default (operations-room aesthetic); light mode is the
 * board-room / daytime variant. Persisted via next-themes (class strategy).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  const { t } = useLang()
  const mounted = useMounted()

  // Hydration-safe default: during SSR and the client's hydration render
  // next-themes' resolvedTheme is already the stored value on the client
  // (it reads the <html> class synchronously) but undefined on the server —
  // so we force the server-agreeable value until mounted. The key-remount
  // below then swaps in the true state without a hydration mismatch.
  const isDark = mounted ? resolvedTheme !== 'light' : true
  const label = t('theme.toggle')

  return (
    <button
      key={mounted ? 'mounted' : 'ssr'}
      type="button"
      role="switch"
      aria-checked={isDark ? 'true' : 'false'}
      aria-label={label}
      title={label}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className={cn(
        'relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border border-border bg-surface-2 transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'cursor-pointer',
        className
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute start-1 flex h-6 w-6 items-center justify-center rounded-full',
          'bg-surface-3 text-foreground shadow-sm transition-transform duration-200 ease-out',
          mounted && isDark ? 'translate-x-6 rtl:-translate-x-6' : 'translate-x-0'
        )}
      >
        {mounted ? (
          isDark ? (
            <Moon className="h-3.5 w-3.5 text-info" aria-hidden />
          ) : (
            <Sun className="h-3.5 w-3.5 text-warn" aria-hidden />
          )
        ) : (
          <Moon className="h-3.5 w-3.5 text-info" aria-hidden />
        )}
      </span>
      {/* static glyphs at both ends */}
      <Sun className="pointer-events-none absolute start-2.5 h-3 w-3 text-muted-foreground/80 ltr" aria-hidden />
      <Moon className="pointer-events-none absolute end-2.5 h-3 w-3 text-muted-foreground/80 ltr" aria-hidden />
    </button>
  )
}

'use client'

// performance budget: sonner costs ~14 KB gzip on EVERY route (root-layout
// mount, even /login where no toast can fire before hydration). The Toaster is
// mount-lazy instead: toast() calls land in sonner's global store either way
// (same API, no call-site changes) and the observer UI streams in on idle —
// worst case a toast fired during the first ~1-2 s appears a beat late.
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'

const Toaster = dynamic(() => import('@/components/ui/sonner').then((m) => m.Toaster), {
  ssr: false,
})

export function LazyToaster() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const mount = () => setReady(true)
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(mount, { timeout: 4000 })
      return () => window.cancelIdleCallback(id)
    }
    const t = window.setTimeout(mount, 1500)
    return () => window.clearTimeout(t)
  }, [])

  return ready ? (
    <Toaster position="bottom-right" richColors closeButton duration={4500} />
  ) : null
}

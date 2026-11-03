'use client'

// Deferred toast facade (performance budget).
//
// `use-sentinel` and other shared modules used to `import { toast } from
// 'sonner'` directly, which pinned the whole sonner client (~14 KB gzip) into
// every route's initial JS — including /login. This facade keeps the same
// call sites (`toast.success(msg, opts?)` / `toast.error(msg, opts?)`) while
// loading sonner's real implementation on FIRST USE (and the observer UI
// separately via the mount-lazy <LazyToaster>). Calls made before the chunk
// arrives simply chain on the same load promise — order is preserved.

type SonnerToast = typeof import('sonner').toast
type ToastOpts = Parameters<SonnerToast['success']>[1]

let impl: Promise<SonnerToast> | null = null

function load(): Promise<SonnerToast> {
  impl ??= import('sonner').then((m) => m.toast)
  return impl
}

export const toast = {
  success(message: string, opts?: ToastOpts) {
    void load().then((t) => t.success(message, opts))
  },
  error(message: string, opts?: ToastOpts) {
    void load().then((t) => t.error(message, opts))
  },
  warning(message: string, opts?: ToastOpts) {
    void load().then((t) => t.warning(message, opts))
  },
  info(message: string, opts?: ToastOpts) {
    void load().then((t) => t.info(message, opts))
  },
}

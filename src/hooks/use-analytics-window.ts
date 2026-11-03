'use client'

// Sentinel-SLA — analytics display-window store (v2.4).
//
// Same pattern as role/tenant/lang: localStorage as an external store via
// useSyncExternalStore (hydration-safe, zero effects, HMR-safe). The selected
// window (6/12/24h) drives /api/analytics?windowHours= for budgets, trends
// and the heatmap — the server adapts bucket sizes per window (v2.3).

import { useSyncExternalStore } from 'react'
import type { AnalyticsWindow } from '@/lib/types'

const WINDOW_KEY = 'sentinel-analytics-window'
const WINDOW_EVENT = 'sentinel:window-change'

const WINDOWS: readonly AnalyticsWindow[] = [6, 12, 24]

function subscribeWindow(callback: () => void) {
  window.addEventListener(WINDOW_EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(WINDOW_EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

function getWindowSnapshot(): AnalyticsWindow {
  try {
    const raw = window.localStorage.getItem(WINDOW_KEY)
    const n = Number(raw)
    return (WINDOWS as readonly number[]).includes(n) ? (n as AnalyticsWindow) : 24
  } catch {
    return 24
  }
}

function getServerWindowSnapshot(): AnalyticsWindow {
  return 24
}

/** Set + broadcast the analytics display window (persisted to localStorage). */
export function setAnalyticsWindow(next: AnalyticsWindow) {
  try {
    window.localStorage.setItem(WINDOW_KEY, String(next))
  } catch {
    // storage unavailable — the event below still applies it for this tab
  }
  window.dispatchEvent(new Event(WINDOW_EVENT))
}

export interface AnalyticsWindowApi {
  windowHours: AnalyticsWindow
  setWindow: (next: AnalyticsWindow) => void
}

/** Reactive analytics window access; re-renders the caller on change. */
export function useAnalyticsWindow(): AnalyticsWindowApi {
  const windowHours = useSyncExternalStore(subscribeWindow, getWindowSnapshot, getServerWindowSnapshot)
  return { windowHours, setWindow: setAnalyticsWindow }
}

'use client'

import { useTheme } from 'next-themes'

/**
 * Theme-aware chart palette (the ONLY file allowed to hold hex literals —
 * docs/DESIGN-SYSTEM.md; every value here mirrors the --chart-* and
 * status tokens declared in src/app/globals.css).
 *
 * Recharts/rebits need concrete color strings for SVG strokes, so chart colors
 * cannot ride on CSS variables directly — this hook resolves the active
 * palette from next-themes (dark default for SSR).
 *
 * Data-series palette (doc §2 rule 4): 6 colours distinguishable in both
 * themes and under colour-blind simulation. Down/breach areas are always crit.
 */
export interface ChartPalette {
  /** status stroke colors */
  up: string
  degraded: string
  down: string
  /** rotating per-service strokes (the 6-series palette, chart-1..6) */
  upStrokes: string[]
  /** semantic accents used by trends / dual-axis charts */
  teal: string
  rose: string
  amber: string
  /** v2.5 MTTA series accent */
  violet: string
  /** compliance ring track */
  ringTrack: string
  /** cartesian grid line: 1 px grid at ~8 % opacity (doc §6.10) */
  grid: string
}

const DARK_PALETTE: ChartPalette = {
  up: '#38b57a', // --ok
  degraded: '#e6a532', // --warn
  down: '#e5484d', // --crit
  upStrokes: ['#3fa9c9', '#f2562b', '#38b57a', '#e6a532', '#9b8ce8', '#c97bb2'],
  teal: '#3fa9c9', // --info (the old teal glow is gone — links/info chips)
  rose: '#e5484d', // --crit
  amber: '#e6a532', // --warn
  violet: '#9b8ce8', // chart-5
  ringTrack: 'rgba(232, 237, 239, 0.08)',
  grid: 'rgba(232, 237, 239, 0.08)',
}

const LIGHT_PALETTE: ChartPalette = {
  up: '#1e8a58', // --ok (600-level)
  degraded: '#b27a0c', // --warn
  down: '#c62f34', // --crit
  upStrokes: ['#17718f', '#d8401a', '#1e8a58', '#b27a0c', '#6d5bc7', '#a54e86'],
  teal: '#17718f', // --info
  rose: '#c62f34', // --crit
  amber: '#b27a0c', // --warn
  violet: '#6d5bc7', // chart-5
  ringTrack: 'rgba(20, 32, 31, 0.1)',
  grid: 'rgba(20, 32, 31, 0.08)',
}

export function chartPalette(dark: boolean): ChartPalette {
  return dark ? DARK_PALETTE : LIGHT_PALETTE
}

export function useChartPalette(): ChartPalette {
  const { resolvedTheme } = useTheme()
  return chartPalette(resolvedTheme !== 'light')
}

/** Convenience: is the resolved theme light? (dark/SSR default → false) */
export function useIsLightTheme(): boolean {
  const { resolvedTheme } = useTheme()
  return resolvedTheme === 'light'
}

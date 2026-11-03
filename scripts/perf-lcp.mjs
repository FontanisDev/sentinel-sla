#!/usr/bin/env node
// LCP evidence: "largest contentful paint < 2.5 s
// on the reference machine against the production build".
//
// Method: Playwright Chromium against the prod standalone server (default
// :3001). The reference machine is the build container itself — recorded
// honestly with its constraints (shared CI-class vCPU, no GPU) in the
// evidence file. LCP is read from the buffered PerformanceObserver entries after
// the page settles (network idle + a fixed settle window), mirroring what a
// real user sees on first authenticated paint.
//
// Usage: node scripts/perf-lcp.mjs [baseUrl] [iterations]

import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:3001';
const RUNS = Number(process.argv[3] ?? 3);
const EMAIL = process.env.PERF_EMAIL ?? 'owner@sentinel.test';
const PASSWORD = process.env.PERF_PASSWORD ?? 'Sentinel-Dev-Owner!2026';

const browser = await chromium.launch();

async function measureOnce(label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Authenticate at the API layer — cookies land in the same cookie jar the
  // page uses, so the goto is a fully authenticated first paint.
  await context.request.post(`${BASE}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  const page = await context.newPage();
  // LCP entries are NOT exposed via getEntriesByType — they must be observed.
  // Register a buffered observer before any navigation, then read the last
  // candidate after the page settles.
  await page.addInitScript(() => {
    window.__lcpEntries = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__lcpEntries.push({ startTime: Math.round(e.startTime), size: e.size });
        }
      });
      po.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      // observer unsupported — window.__lcpEntries stays empty
    }
  });
  await page.goto(`${BASE}${label}`, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(1200); // settle window for late LCP candidates
  const lcp = await page.evaluate(() => {
    const arr = window.__lcpEntries ?? [];
    const last = arr[arr.length - 1];
    return last ? last.startTime : null;
  });
  const fcp = await page.evaluate(() => {
    const paints = performance.getEntriesByType('paint');
    const e = paints.find((p) => p.name === 'first-contentful-paint');
    return e ? Math.round(e.startTime) : null;
  });
  await context.close();
  return { lcp, fcp };
}

const results = [];
for (let i = 0; i < RUNS; i++) {
  const r = await measureOnce('/');
  results.push(r);
  console.log(`run ${i + 1}: LCP ${r.lcp ?? 'n/a'} ms  FCP ${r.fcp ?? 'n/a'} ms`);
}

const lcpRuns = results.map((r) => r.lcp).filter((v) => v !== null);
const median = lcpRuns.length ? [...lcpRuns].sort((a, b) => a - b)[Math.floor(lcpRuns.length / 2)] : null;
const pass = median !== null && median < 2500;
console.log(
  `\nLCP (median of ${lcpRuns.length} runs) = ${median ?? 'n/a'} ms < 2500 ms → ${pass ? 'PASS ✓' : 'FAIL ✗'}`
);

mkdirSync(path.resolve('data/evidence'), { recursive: true });
writeFileSync(
  path.resolve('data/evidence/perf-lcp.json'),
  JSON.stringify(
    {
      base: BASE,
      measuredAt: new Date().toISOString(),
      referenceMachine:
        'build container (shared CI-class vCPU, headless Chromium, no GPU) — recorded as the reference machine',
      runs: results,
      medianLcpMs: median,
      budgetMs: 2500,
      pass,
    },
    null,
    2,
  ) + '\n',
);
console.log('evidence → data/evidence/perf-lcp.json');
await browser.close();
process.exit(pass ? 0 : 2);

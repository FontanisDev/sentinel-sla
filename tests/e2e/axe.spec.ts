// axe-core accessibility sweep:
//   "axe-core reports zero serious/critical violations on every page in all
//   four variants".
//
// Runs gated: AXE_SWEEP=1 E2E_NO_SERVER=1 E2E_PORT=3001 playwright test axe.spec.ts
// (kept out of the default e2e run — the sweep visits every page × variant).
//
// Four variants = dark/light × EN/FA. Theme comes from next-themes
// (localStorage['theme'], class strategy); UI language from
// localStorage['sentinel-lang'] — both set before any app script runs, so
// first paint already matches the variant.
//
// Evidence lands in data/evidence/axe-sweep.json. The check: no
// serious/critical violations anywhere; everything else is recorded and
// triaged (moderate/minor are listed, not gating).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Playwright transpiles specs to CJS — no import.meta here; resolve the
// bundle from the workspace's node_modules (tests always run from the repo
// root, which is where the devDependency is installed).
const axeSource = readFileSync(
  path.resolve(process.cwd(), 'node_modules/axe-core/axe.min.js'),
  'utf8',
);

function loadEnvTest(): Record<string, string> {
  const file = path.resolve(process.cwd(), '.env.test');
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // untracked file may not exist — env vars are the fallback
  }
  return out;
}

const EMAIL =
  process.env.E2E_OWNER_EMAIL ??
  process.env.MATRIX_OWNER_EMAIL ??
  'owner@sentinel.test';
const PASSWORD =
  process.env.E2E_OWNER_PASSWORD ??
  process.env.MATRIX_OWNER_PASSWORD ??
  'Sentinel-Dev-Owner!2026';

const VARIANTS = [
  { name: 'en-dark', lang: 'en', theme: 'dark' },
  { name: 'en-light', lang: 'en', theme: 'light' },
  { name: 'fa-dark', lang: 'fa', theme: 'dark' },
  { name: 'fa-light', lang: 'fa', theme: 'light' },
] as const;

/** Static routes + the two dynamic detail routes (ids fetched live). */
async function routesFor(page: Page): Promise<string[]> {
  const base = ['/login', '/', '/executive', '/incidents', '/services', '/contracts', '/reports', '/resilience', '/alerting', '/alerting/channels', '/alerting/rules', '/alerting/oncall', '/alerting/maintenance', '/settings/services', '/settings/integrations', '/settings/audit'];
  const res = await page.request.get('/api/incidents');
  if (res.ok()) {
    const data = await res.json();
    const id = data?.incidents?.[0]?.id;
    if (id) base.push(`/incidents/${encodeURIComponent(id)}`);
  }
  const sres = await page.request.get('/api/services');
  if (sres.ok()) {
    const data = await sres.json();
    const key = data?.services?.[0]?.key;
    if (key) base.push(`/services/${encodeURIComponent(key)}`);
  }
  return base;
}

interface AxeNode { target: string[]; failureSummary?: string }
interface AxeResult {
  id: string;
  impact: string | null;
  tags: string[];
  nodes: AxeNode[];
}
interface AxeResponse {
  violations: AxeResult[];
}

/**
 * Log in INSIDE this test's context (its API request shares the cookie jar
 * with the page) and survive the login brute-force throttle
 * (10 / 5 min per IP, src/server/ratelimit.ts): on 429, wait out the
 * announced retry window once and retry.
 */
async function login(page: Page) {
  const post = () =>
    page.context().request.post('/api/auth/login', {
      data: { email: EMAIL, password: PASSWORD },
    });
  let res = await post();
  if (res.status() === 429) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const waitSec = Number(/Retry in (\d+)/.exec(body.error ?? '')?.[1] ?? 5) + 1;
    await new Promise((r) => setTimeout(r, waitSec * 1000));
    res = await post();
  }
  expect(res.ok(), `axe sweep login failed: ${res.status()}`).toBeTruthy();
}

for (const variant of VARIANTS) {
  test(`axe: ${variant.name} — no serious/critical violations`, async ({ page }, testInfo) => {
    test.setTimeout(10 * 60_000); // ~17 routes × settle waits inside ONE test
    test.skip(!EMAIL || !PASSWORD, 'no axe credentials available');

    await login(page);

    await page.addInitScript(
      ([lang, theme]) => {
        window.localStorage.setItem('sentinel-lang', lang!);
        window.localStorage.setItem('theme', theme!);
      },
      [variant.lang, variant.theme],
    );

    const routes = await routesFor(page);
    const collected: Array<{ route: string; id: string; impact: string | null; nodes: number; sample: string[] }> = [];
    const serious: Array<{ route: string; id: string; impact: string | null; sample: string[] }> = [];

    for (const route of routes) {
      await page.goto(route, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(500);
      await page.addScriptTag({ content: axeSource });
      const axe = await page.evaluate(async () => {
        const a = (window as unknown as { axe: { run: (o?: object) => Promise<AxeResponse> } }).axe;
        return a.run({ resultTypes: ['violations'] });
      });
      for (const v of axe.violations ?? []) {
        const sample = v.nodes.slice(0, 3).map((n) => n.target.join(' '));
        collected.push({ route, id: v.id, impact: v.impact, nodes: v.nodes.length, sample });
        if (v.impact === 'serious' || v.impact === 'critical') {
          serious.push({ route, id: v.id, impact: v.impact, sample });
        }
      }
    }

    const evidencePath = path.resolve('data/evidence');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(evidencePath, { recursive: true });
    // per-variant evidence file; scripts/qa-axe.sh merges them into
    // data/evidence/axe-sweep.json after the run
    writeFileSync(
      path.join(evidencePath, `axe-sweep.${variant.name}.json`),
      JSON.stringify({ variant: variant.name, routesScanned: routes.length, collected, serious }, null, 2) + '\n',
    );

    testInfo.attach(`axe-${variant.name}.json`, {
      body: JSON.stringify({ collected, serious }, null, 2),
      contentType: 'application/json',
    });

    expect(
      serious,
      `axe found serious/critical violations in ${variant.name}:\n` +
        serious.map((s) => `  [${s.impact}] ${s.id} @ ${s.route}: ${s.sample.join(' | ')}`).join('\n'),
    ).toEqual([]);
  });
}

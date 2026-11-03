/**
 * Lighthouse accessibility check: runs Lighthouse with --only-categories=accessibility
 * against the production standalone on :3001 for the key routes, authenticated where the
 * route needs it (cookie forwarded via --extra-headers). Writes per-route JSON into
 * data/evidence/lighthouse/<name>.json and prints a summary table.
 *
 * Usage: node scripts/lh-a11y.mjs [route ...]   (defaults to the standard set)
 * Env:   PORT (default 3001)
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 3001);
const BASE = `http://localhost:${PORT}`;
const OUT = path.join(ROOT, 'data/evidence/lighthouse');
mkdirSync(OUT, { recursive: true });

const ROUTES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/', '/login', '/executive', '/incidents', '/services', '/contracts', '/reports', '/alerting'];

// Login once (owner) and reuse the session cookie for authed routes.
const res = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner@sentinel.test', password: process.env.OWNER_PASSWORD || 'Sentinel-Dev-Owner!2026' }),
});
if (!res.ok) {
  console.error(`login failed: ${res.status} ${await res.text()}`);
  process.exit(2);
}
const setCookie = res.headers.get('set-cookie') || '';
const cookiePair = setCookie.split(';')[0];
console.log(`session cookie acquired (${cookiePair.split('=')[0]}, len ${cookiePair.length})`);

// Locate a Chromium binary from the Playwright cache.
const { readdirSync, existsSync } = await import('node:fs'); // readFileSync imported above
const cache = path.join(os.homedir(), '.cache/ms-playwright');
let chrome = null;
for (const dir of readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
  for (const cand of [
    path.join(cache, dir, 'chrome-linux', 'chrome'),
    path.join(cache, dir, 'chrome-linux64', 'chrome'),
  ]) {
    if (existsSync(cand)) { chrome = cand; break; }
  }
  if (chrome) break;
}
if (!chrome) { console.error('no playwright chromium found'); process.exit(2); }
console.log(`CHROME_PATH=${chrome}`);

let allPass = true;
for (const route of ROUTES) {
  const name = route === '/' ? 'home' : route.replaceAll('/', '_').slice(1);
  const outPath = path.join(OUT, `${name}.json`);
  const authed = route !== '/login';
  const args = [
    `${BASE}${route}`,
    '--output=json',
    `--output-path=${outPath}`,
    '--only-categories=accessibility',
    '--quiet',
    '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage',
  ];
  if (authed) args.splice(1, 0, `--extra-headers=${JSON.stringify({ Cookie: cookiePair })}`);
  const env = { ...process.env, CHROME_PATH: chrome };
  try {
    execFileSync('bun', ['x', 'lighthouse', ...args], { env, stdio: 'pipe', timeout: 180_000 });
    const report = JSON.parse(readFileSync(outPath, 'utf8'));
    const score = report.categories?.accessibility?.score;
    const audits = report.audits || {};
    const failed = Object.values(audits).filter((a) => a.score !== null && a.score < 1 && !['notApplicable','informative'].includes(a.scoreDisplayMode));
    const pct = score === null ? 'n/a' : `${Math.round(score * 100)}`;
    console.log(`${route.padEnd(12)} a11y=${pct}${pct !== 'n/a' && score < 0.95 ? '  << FAIL' : '  PASS'}`);
    for (const f of failed) console.log(`    - [${f.id}] ${f.title} (score ${f.score})`);
    if (score === null || score < 0.95) allPass = false;
  } catch (err) {
    console.error(`${route} lighthouse run failed: ${String(err).slice(0, 400)}`);
    allPass = false;
  }
}
console.log(allPass ? 'LH-A11Y: ALL PASS (>=95)' : 'LH-A11Y: FAILURES PRESENT');
process.exit(allPass ? 0 : 1);

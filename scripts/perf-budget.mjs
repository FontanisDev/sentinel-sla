#!/usr/bin/env node
// Performance budget evidence:
//   "initial JS for the home page < 250 KB gzip" against the PRODUCTION build.
//
// Method (offline-first, no network flakiness):
//   1. Log in against the prod standalone server (default :3001) to get a session.
//   2. Fetch each page's HTML and collect every external <script src> and
//      <link rel=preload|modulepreload as=script> (the browser-fetched JS set).
//   3. Resolve each URL to its file on disk under .next/standalone/ and measure
//      the EXACT gzip size with zlib.gzipSync — the same number the browser
//      would download when the server negotiates gzip.
//   4. Sum unique chunks per page (shared chunks counted once) and compare the
//      home page total with the 250 KB budget. Formula + per-chunk evidence is
//      written to data/evidence/perf-budget.json.
//
// Usage: node scripts/perf-budget.mjs [baseUrl]   (default http://localhost:3001)

import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:3001';
const ROOT = path.resolve(process.cwd(), '.next/standalone');
const BUDGET_HOME_GZIP_KB = 250;

const EMAIL = process.env.PERF_EMAIL ?? 'owner@sentinel.test';
const PASSWORD = process.env.PERF_PASSWORD ?? 'Sentinel-Dev-Owner!2026';

const PAGES = ['/', '/executive', '/incidents', '/services', '/contracts', '/alerting/channels', '/reports'];

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) fail(`login failed: ${res.status} — is the prod build running on ${BASE}?`);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const jar = [];
  for (const c of setCookie) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    jar.push([pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()]);
  }
  if (jar.length === 0) fail('no session cookie returned by /api/auth/login');
  return jar.map(([n, v]) => `${n}=${v}`).join('; ');
}

function fileForUrl(url) {
  const u = new URL(url, BASE);
  if (!u.pathname.startsWith('/_next/static/')) return null;
  const rel = u.pathname.replace('/_next/static/', '');
  const candidate = path.join(ROOT, '.next/static', rel);
  return existsSync(candidate) ? candidate : null;
}

function collectScripts(html) {
  const urls = [];
  const scriptRe = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g;
  for (const m of html.matchAll(scriptRe)) {
    if (/\.js(?:\?|$)/.test(m[1])) urls.push(m[1]);
  }
  const linkRe = /<link\b[^>]*\brel=["'](?:preload|modulepreload)["'][^>]*>/g;
  for (const tag of html.matchAll(linkRe)) {
    const href = /href=["']([^"']+)["']/.exec(tag[0])?.[1];
    const as = /as=["']([^"']+)["']/.exec(tag[0])?.[1];
    if (href && as === 'script' && /\.js(?:\?|$)/.test(href)) urls.push(href);
  }
  // inline scripts (theme bootstrap etc.) — counted separately, uncompressed
  let inlineBytes = 0;
  const inlineRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(inlineRe)) inlineBytes += Buffer.byteLength(m[1], 'utf8');
  return { urls: [...new Set(urls)], inlineBytes };
}

async function pageChunks(cookie, pagePath) {
  const res = await fetch(`${BASE}${pagePath}`, { headers: { cookie } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const html = await res.text();
  const { urls, inlineBytes } = collectScripts(html);
  const chunks = [];
  const missing = [];
  const seen = new Set();
  for (const u of urls) {
    const f = fileForUrl(u);
    if (!f) {
      if (u.includes('/_next/static/')) missing.push(u);
      continue;
    }
    if (seen.has(f)) continue;
    seen.add(f);
    const raw = readFileSync(f);
    const gz = gzipSync(raw).length;
    chunks.push({ url: u, file: path.relative(ROOT, f), rawKB: +(raw.length / 1024).toFixed(1), gzipKB: +(gz / 1024).toFixed(1) });
  }
  chunks.sort((a, b) => b.gzipKB - a.gzipKB);
  return { chunks, missing, inlineBytes, htmlKB: +(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1) };
}

const cookie = await login();
console.log(`✓ logged in against ${BASE} (prod standalone)\n`);

const report = { base: BASE, measuredAt: new Date().toISOString(), budgetKB: BUDGET_HOME_GZIP_KB, pages: {} };

let homeGzip = null;
for (const p of PAGES) {
  const r = await pageChunks(cookie, p);
  if (r.error) {
    console.log(`✗ ${p} → ${r.error}`);
    report.pages[p] = { error: r.error };
    continue;
  }
  const totalRaw = r.chunks.reduce((s, c) => s + c.rawKB, 0);
  const totalGz = r.chunks.reduce((s, c) => s + c.gzipKB, 0);
  const inline = +(r.inlineBytes / 1024).toFixed(1);
  console.log(
    `${p.padEnd(22)} chunks:${String(r.chunks.length).padStart(3)}  raw:${totalRaw.toFixed(1).padStart(7)} KB  gzip:${totalGz.toFixed(1).padStart(7)} KB  inline:${inline} KB  html:${r.htmlKB} KB`
  );
  if (r.missing.length) console.log(`   ⚠ missing on disk: ${r.missing.join(', ')}`);
  report.pages[p] = { chunkCount: r.chunks.length, rawKB: +totalRaw.toFixed(1), gzipKB: +totalGz.toFixed(1), inlineKB: inline, htmlKB: r.htmlKB, chunks: r.chunks };
  if (p === '/') homeGzip = totalGz;
}

if (homeGzip !== null) {
  const pass = homeGzip < BUDGET_HOME_GZIP_KB;
  report.homeGzipKB = +homeGzip.toFixed(1);
  report.homePass = pass;
  console.log(
    `\nBudget: home initial JS = ${homeGzip.toFixed(1)} KB gzip < ${BUDGET_HOME_GZIP_KB} KB → ${pass ? 'PASS ✓' : 'FAIL ✗'}`
  );
} else {
  fail('home page (/) could not be measured');
}

mkdirSync(path.resolve('data/evidence'), { recursive: true });
writeFileSync(path.resolve('data/evidence/perf-budget.json'), JSON.stringify(report, null, 2) + '\n');
console.log('evidence → data/evidence/perf-budget.json');
process.exit(report.homePass ? 0 : 2);

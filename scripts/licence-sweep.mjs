#!/usr/bin/env node
// Licence sweep for THIRD_PARTY_NOTICES.md.
// Walks node_modules package.json files (real installed truth, not ranges),
// separates production closure from dev-only, aggregates by licence id.
// Usage: node scripts/licence-sweep.mjs [--json out.json]
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const nm = join(root, 'node_modules');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const prod = new Set(Object.keys(pkg.dependencies ?? {}));
const dev = new Set(Object.keys(pkg.devDependencies ?? {}));

// Resolve the real production closure via node_modules/.prisma? No — use npm-less walk:
// Bun installs flat; a dep is "in the shipped image" if reachable from prod deps.
// Build an adjacency map of every installed package.
const packages = new Map(); // name@dir -> {name, version, licence, license, deps, location}

function readPkg(dir) {
  const pj = join(dir, 'package.json');
  if (!existsSync(pj)) return null;
  try { return JSON.parse(readFileSync(pj, 'utf8')); } catch { return null; }
}

function scan(scopeDir, prefix = '') {
  let entries;
  try { entries = readdirSync(scopeDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(scopeDir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('@')) { scan(full, `${prefix}${e.name}/`); continue; }
      const meta = readPkg(full);
      if (meta?.name) {
        packages.set(`${prefix}${e.name}`, {
          name: meta.name, version: meta.version ?? '?',
          licence: meta.license ?? meta.licence ?? 'UNKNOWN',
          deps: Object.keys({ ...(meta.dependencies ?? {}), ...(meta.optionalDependencies ?? {}) }),
          location: `${prefix}${e.name}`,
        });
      }
    }
  }
}
scan(nm);

// BFS the production closure.
const prodClosure = new Set();
const queue = [...prod];
while (queue.length) {
  const name = queue.shift();
  if (prodClosure.has(name) || !packages.has(name)) continue;
  prodClosure.add(name);
  queue.push(...(packages.get(name)?.deps ?? []));
}

const byLicence = new Map();
for (const name of [...prodClosure].sort()) {
  const p = packages.get(name);
  if (!p) continue;
  const lic = String(p.licence).trim() || 'UNKNOWN';
  if (!byLicence.has(lic)) byLicence.set(lic, []);
  byLicence.get(lic).push(`${p.name}@${p.version}`);
}
const devOnly = [...packages.keys()].filter(n => !prodClosure.has(n));
const devByLicence = new Map();
for (const name of devOnly.sort()) {
  const p = packages.get(name);
  const lic = String(p?.licence ?? 'UNKNOWN').trim();
  if (!devByLicence.has(lic)) devByLicence.set(lic, []);
  devByLicence.get(lic).push(`${p.name}@${p.version}`);
}

console.log(`installed top-level packages: ${packages.size}`);
console.log(`production closure: ${prodClosure.size} packages`);
const licenceRows = [...byLicence.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [lic, names] of licenceRows) console.log(`  ${lic}: ${names.length}`);
console.log(`dev-only packages: ${devOnly.length}`);
for (const [lic, names] of [...devByLicence.entries()].sort((a, b) => b[1].length - a[1].length))
  console.log(`  ${lic}: ${names.length}`);

if (process.argv.includes('--json')) {
  const out = process.argv[process.argv.indexOf('--json') + 1] ?? 'scripts/licence-sweep.json';
  writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    prodClosure: Object.fromEntries(licenceRows),
    devOnly: Object.fromEntries([...devByLicence.entries()].sort()),
    prodList: [...prodClosure].sort().map(n => { const p = packages.get(n); return { name: p.name, version: p.version, licence: p.licence }; }),
  }, null, 2));
  console.log(`json → ${out}`);
}

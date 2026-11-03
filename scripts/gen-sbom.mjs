#!/usr/bin/env node
// CycloneDX 1.5 SBOM generator for Sentinel-SLA v2.0.0 (release artefact).
//
// Produces release/sentinel-sla-<version>.cdx.json covering the three real
// supply-chain surfaces of this product:
//   1. the npm production closure actually installed in node_modules
//      (same walk as scripts/licence-sweep.mjs — real installed truth, not
//      package.json ranges),
//   2. the pinned monitoring-stack container images from
//      deploy/docker-compose.yml (parsed from the compose file, not guessed),
//   3. the Go exporter module (exporter/go.mod; module deps enumerated in
//      exporter/go.sum — referenced, not duplicated).
//
// Usage: node scripts/gen-sbom.mjs   (writes the file, prints a summary)
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = process.cwd();
const nm = join(root, 'node_modules');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('gen-sbom: package.json has no valid version'); process.exit(1);
}

// ── 1. npm production closure (installed truth) ──────────────────────────────
const prod = new Set(Object.keys(pkg.dependencies ?? {}));
const packages = new Map(); // name -> {version, licence, deps}
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
        packages.set(meta.name, {
          version: meta.version ?? '0.0.0',
          licence: String(meta.license ?? meta.licence ?? 'NOASSERTION').trim(),
          deps: Object.keys({ ...(meta.dependencies ?? {}), ...(meta.optionalDependencies ?? {}) }),
          location: `${prefix}${e.name}`,
        });
      }
    }
  }
}
scan(nm);
const prodClosure = new Set();
const queue = [...prod];
while (queue.length) {
  const name = queue.shift();
  if (prodClosure.has(name) || !packages.has(name)) continue;
  prodClosure.add(name);
  queue.push(...(packages.get(name)?.deps ?? []));
}
if (prodClosure.size < 100) {
  console.error(`gen-sbom: production closure suspiciously small (${prodClosure.size}) — run bun install first`);
  process.exit(1);
}

// ── CycloneDX licence helpers ────────────────────────────────────────────────
// SPDX ids used verbatim; expressions (contains OR/AND/parens) use the
// expression form; anything else is carried as a license name (honest).
const SPDX_IDS = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD',
  'CC-BY-4.0', 'MIT-AND-ISC', 'LGPL-3.0-or-later', 'GPL-3.0-or-later', 'Unlicense', 'CC0-1.0',
  'Python-2.0', 'PSF-2.0', 'MPL-2.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later']);
function licences(raw) {
  const s = String(raw || 'NOASSERTION').trim();
  if (/[()]/.test(s) || /\b(OR|AND|WITH)\b/.test(s)) return [{ expression: s }];
  if (SPDX_IDS.has(s)) return [{ license: { id: s } }];
  return [{ license: { name: s } }];
}
function purlNpm(name, ver) {
  return `pkg:npm/${encodeURIComponent(name).replace(/%40/g, '%40')}@${ver}`;
}

const npmComponents = [...prodClosure].sort().map((name) => {
  const p = packages.get(name);
  return {
    type: 'library',
    'bom-ref': purlNpm(name, p.version),
    name,
    version: p.version,
    purl: purlNpm(name, p.version),
    licenses: licences(p.licence),
    properties: [{ name: 'sentinel:npm-path', value: `node_modules/${p.location}` }],
  };
});

// ── 2. monitoring-stack container images from the real compose file ─────────
const composeText = readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8');
const imageRefs = [...composeText.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map(m => m[1]);
if (imageRefs.length < 5) {
  console.error(`gen-sbom: compose images suspiciously few (${imageRefs.length}) — parse failure?`);
  process.exit(1);
}
const AGPL = new Set(['grafana/grafana', 'grafana/loki', 'grafana/promtail']);
const containerComponents = imageRefs.map((ref) => {
  const [repo, tag = 'latest'] = ref.split(':');
  return {
    type: 'container',
    'bom-ref': `pkg:docker/${repo}@${tag}`,
    name: repo,
    version: tag,
    purl: `pkg:docker/${repo}@${tag}`,
    licenses: [{ license: { id: AGPL.has(repo) ? 'AGPL-3.0-only' : 'NOASSERTION' } }],
    // NOASSERTION for Apache images (prometheus/alertmanager/blackbox): their
    // licences are documented per-component in docs/THIRD_PARTY_NOTICES.md;
    // the pinned upstream trees are recorded there as well.
    properties: [
      { name: 'sentinel:pin-source', value: 'deploy/docker-compose.yml' },
      { name: 'sentinel:licence-doc', value: 'docs/THIRD_PARTY_NOTICES.md' },
      ...(AGPL.has(repo) ? [{ name: 'sentinel:upstream-source', value: `https://github.com/${repo.startsWith('grafana/') ? repo : repo}` }] : []),
    ],
  };
});

// ── 3. Go exporter module ────────────────────────────────────────────────────
const goMod = readFileSync(join(root, 'exporter', 'go.mod'), 'utf8');
const goModule = (goMod.match(/^module\s+(\S+)/m) ?? [])[1];
const goVersion = (goMod.match(/^go\s+(\S+)/m) ?? [])[1] ?? '?';
if (!goModule) { console.error('gen-sbom: cannot parse exporter/go.mod'); process.exit(1); }
const exporterComponent = {
  type: 'application',
  'bom-ref': `pkg:golang/${goModule}@${version}`,
  name: goModule,
  version,
  purl: `pkg:golang/${goModule}@${version}`,
  licenses: [{ license: { id: 'PolyForm-Noncommercial-1.0.0' } }],
  description: `Sentinel-SLA Prometheus business exporter (Go ${goVersion}). Go module dependencies are enumerated in exporter/go.sum; the module ships as a static binary in the Docker image.`,
  properties: [{ name: 'sentinel:source-path', value: 'exporter/' }],
};

// ── assemble the BOM ─────────────────────────────────────────────────────────
const rootPurl = `pkg:npm/${pkg.name}@${version}`;
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'Sentinel-SLA', name: 'scripts/gen-sbom.mjs', version }],
    authors: [{ name: 'Sentinel-SLA build pipeline' }],
    component: {
      type: 'application',
      'bom-ref': rootPurl,
      name: pkg.name,
      version,
      purl: rootPurl,
      description: 'Sentinel-SLA — the money-and-contract layer on top of Prometheus (Next.js/TypeScript app + worker, Python report renderer, Go exporter, unmodified monitoring stack).',
      licenses: [{ license: { id: 'PolyForm-Noncommercial-1.0.0' } }],
    },
    properties: [
      { name: 'sentinel:release', value: 'v2.0.0' },
      { name: 'sentinel:licence-note', value: 'Sentinel-SLA is licensed under PolyForm Noncommercial 1.0.0 (see LICENSE). Third-party licence obligations are documented in docs/THIRD_PARTY_NOTICES.md.' },
    ],
  },
  components: [...npmComponents, ...containerComponents, exporterComponent],
  dependencies: [
    {
      ref: rootPurl,
      dependsOn: [...prodClosure].sort().map(n => purlNpm(n, packages.get(n).version)),
    },
  ],
};

const outDir = join(root, 'release');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `sentinel-sla-${version}.cdx.json`);
writeFileSync(outFile, JSON.stringify(bom, null, 2) + '\n');

console.log(`SBOM written: ${outFile}`);
console.log(`  npm production closure : ${npmComponents.length} components`);
console.log(`  container images       : ${containerComponents.length} (${imageRefs.join(', ')})`);
console.log(`  exporter module        : ${goModule} (go ${goVersion})`);
console.log(`  total components       : ${bom.components.length}`);

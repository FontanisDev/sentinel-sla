#!/usr/bin/env node
// Sentinel-SLA — generate docs/API.md FROM openapi/openapi.yaml.
//
// The markdown is a VIEW of the
// spec, never hand-edited — run `bun run docs:api` after changing the OpenAPI document and
// commit both files together (CI fails on drift via `--check`).
//
// Usage:
//   node scripts/generate-api-docs.mjs           regenerate docs/API.md
//   node scripts/generate-api-docs.mjs --check   exit 1 when docs/API.md is stale

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SPEC = path.join(ROOT, 'openapi', 'openapi.yaml');
const OUT = path.join(ROOT, 'docs', 'API.md');

const spec = parse(fs.readFileSync(SPEC, 'utf8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const METHOD_ORDER = { get: 0, post: 1, put: 2, patch: 3, delete: 4 };

function esc(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function schemaLabel(refOrSchema) {
  if (!refOrSchema) return '—';
  if (typeof refOrSchema === 'string') return refOrSchema;
  if (refOrSchema.$ref) return refOrSchema.$ref.split('/').pop();
  return 'inline object';
}

const lines = [];
lines.push('# API Reference');
lines.push('');
lines.push(`> **Generated from \`openapi/openapi.yaml\`** (OpenAPI ${spec.openapi}, v${spec.info.version}) — do not edit by hand.`);
lines.push('> Regenerate with `bun run docs:api`; CI fails when this file drifts from the spec.');
lines.push('> The spec is machine-enforced: `bun run lint:spec` lints it (Spectral + the official');
lines.push('> OpenAPI JSON-Schema) and `tests/integration/api-contract.mjs` calls every endpoint and');
lines.push('> validates each response against these schemas.');
lines.push('');
lines.push(esc(spec.info.description));
lines.push('');
lines.push('## Authentication');
lines.push('');
lines.push('Every operation requires a signed-in principal unless explicitly marked **public**:');
lines.push('');
lines.push('- **Browser** — the HTTP-only `sentinel_session` cookie set by `POST /api/auth/login` (or first-run setup).');
lines.push('- **Machine** — `Authorization: Bearer <api-token>` (hashed, prefix-visible, expiring tokens).');
lines.push('- Role floors (`owner > admin > engineer > executive > viewer`) are enforced server-side by');
lines.push('  `src/server/authz.ts`; the full route-by-route matrix lives in `docs/SECURITY.md` and is');
lines.push('  proven by `tests/integration/authz-matrix.mjs`.');
lines.push('');
lines.push('All errors share one envelope: `{ "error": string, "details"?: string[] }`');
lines.push('(with `details` carrying zod field messages on validation failures).');
lines.push('');
lines.push('## Operations');
lines.push('');

const tags = [...new Set(Object.values(spec.tags ?? {}).map((t) => t.name))];
const byTag = new Map(tags.map((t) => [t, []]));
for (const [p, item] of Object.entries(spec.paths)) {
  for (const [m, op] of Object.entries(item)) {
    if (!METHODS.includes(m)) continue;
    if (!byTag.has(op.tags?.[0])) byTag.set(op.tags?.[0], []);
    byTag.get(op.tags?.[0]).push({ p, m, op });
  }
}
for (const list of byTag.values()) {
  list.sort((a, b) => a.p.localeCompare(b.p) || METHOD_ORDER[a.m] - METHOD_ORDER[b.m]);
}

// summary table
lines.push('| Method | Path | Summary |');
lines.push('|--------|------|---------|');
for (const t of tags) {
  for (const { p, m, op } of byTag.get(t) ?? []) {
    lines.push(`| \`${m.toUpperCase()}\` | \`${p}\` | ${esc(op.summary)} |`);
  }
}
lines.push('');

// per-tag detail
for (const t of tags) {
  const tagMeta = (spec.tags ?? []).find((x) => x.name === t);
  lines.push(`## ${t}`);
  if (tagMeta?.description) {
    lines.push('');
    lines.push(esc(tagMeta.description));
  }
  lines.push('');
  for (const { p, m, op } of byTag.get(t) ?? []) {
    lines.push(`### \`${m.toUpperCase()} ${p}\` — ${esc(op.summary)}`);
    lines.push('');
    if (op.security === [] || (op.security && op.security.length === 0)) {
      lines.push('**Public** (no session required).');
      lines.push('');
    }
    if (op.description) {
      lines.push(esc(op.description));
      lines.push('');
    }
    // parameters
    const params = [...(op.parameters ?? [])];
    const shared = params.filter((x) => x.$ref).map((x) => spec.components.parameters[x.$ref.split('/').pop()]);
    const concrete = params.filter((x) => !x.$ref);
    const all = [...shared, ...concrete];
    if (all.length > 0) {
      lines.push('| Parameter | In | Description |');
      lines.push('|-----------|-----|-------------|');
      for (const prm of all) {
        lines.push(`| \`${prm.name}\` | ${prm.in} | ${esc(prm.description ?? '')} |`);
      }
      lines.push('');
    }
    // request body
    const body = op.requestBody?.content?.['application/json']?.schema;
    if (body) {
      lines.push(`Request body (${op.requestBody.required === true ? 'required' : 'optional'}): **${schemaLabel(body)}**`);
      lines.push('');
    }
    // responses
    const rows = Object.entries(op.responses ?? {})
      .map(([code, res]) => {
        let label = '—';
        const ref = res.content?.['application/json']?.schema ?? res.content?.['text/csv']?.schema ?? res.content?.['application/pdf']?.schema;
        label = schemaLabel(ref);
        return `| \`${code}\` | ${esc(res.description ?? '')} | ${label} |`;
      })
      .join('\n');
    lines.push('| Status | Description | Schema |');
    lines.push('|--------|-------------|--------|');
    lines.push(rows);
    lines.push('');
  }
}

const md = lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== md) {
    console.error('[generate-api-docs] docs/API.md is STALE — run `bun run docs:api` and commit both files.');
    process.exit(1);
  }
  console.log('[generate-api-docs] docs/API.md is in sync with openapi/openapi.yaml');
  process.exit(0);
}

fs.writeFileSync(OUT, md);
console.log(`[generate-api-docs] wrote ${OUT} (${md.split('\n').length} lines)`);

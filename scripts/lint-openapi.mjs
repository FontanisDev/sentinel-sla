#!/usr/bin/env node
// Sentinel-SLA — OpenAPI document lint (validated in CI with an
// OpenAPI linter). Two independent layers, both must pass:
//
//   1. Official OpenAPI 3.0 JSON-Schema validation
//      (@seriousme/openapi-schema-validator) — structural conformance.
//   2. Spectral with the Sentinel ruleset (openapi/spectral.yaml) — house
//      rules on top of spectral:oas (docs present, unique operationIds,
//      401 envelope, spec version pinned to the release version).
//
// Wired as `bun run lint:spec` and into .github/workflows/ci.yml.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SPEC = path.join(ROOT, 'openapi', 'openapi.yaml');

let failed = false;

// ── layer 1: official JSON-Schema ──
const { Validator } = await import('@seriousme/openapi-schema-validator');
const v = new Validator();
const res = await v.validate(fs.readFileSync(SPEC, 'utf8'));
if (res.valid) {
  console.log('[lint-openapi] official OpenAPI 3.0 JSON-Schema: VALID');
} else {
  failed = true;
  console.error('[lint-openapi] official OpenAPI 3.0 JSON-Schema: INVALID');
  console.error(JSON.stringify(res.errors, null, 2).slice(0, 4000));
}

// ── layer 2: spectral ──
const spectral = spawnSync(
  process.execPath,
  [path.join(ROOT, 'node_modules', '@stoplight', 'spectral-cli', 'dist', 'index.js'), 'lint', '-r', path.join(ROOT, 'openapi', 'spectral.yaml'), '-f', 'text', SPEC],
  { stdio: 'inherit' },
);
if (spectral.status === 0) {
  console.log('[lint-openapi] spectral: 0 errors, 0 warnings');
} else {
  failed = true;
  console.error(`[lint-openapi] spectral exited ${spectral.status}`);
}

process.exit(failed ? 1 : 0);

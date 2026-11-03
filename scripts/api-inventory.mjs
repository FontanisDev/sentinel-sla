#!/usr/bin/env node
// Walk src/app/api/**/route.ts and print: route, methods, guard calls, zod schemas, response envelope keys.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name === 'route.ts') out.push(p);
  }
  return out;
}
const files = walk(path.join(ROOT, 'src/app/api')).sort();
for (const f of files) {
  const rel = path.relative(path.join(ROOT, 'src/app/api'), f).replace(/\/route\.ts$/, '') || '/';
  const apiPath = '/' + rel.replace(/\[(\w+)\]/g, '{$1}').replace(/^\/$/, '');
  const src = fs.readFileSync(f, 'utf8');
  const methods = [...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Z]+)/g)].map(m => m[1]);
  const guards = [...src.matchAll(/require(?:Role|User)\(\s*req[^,)]*,?\s*'?(\w+)?'?\s*\)/g)].map(m => m[1] ?? 'user');
  const zods = [...src.matchAll(/(\w+Schema)\./g)].map(m => m[1]);
  const envKeys = [...src.matchAll(/NextResponse\.json\(\s*\{([^}]{0,120})/gs)].map(m => m[1].split(/[,:]/)[0].trim());
  console.log(`### ${apiPath} [${methods.join(',')}] guards=${guards.join('|') || 'PUBLIC'} zod=${zods.join(',') || '-'} env={${envKeys.join(',')}}`);
}

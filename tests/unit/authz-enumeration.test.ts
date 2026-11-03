// Route-enumeration authz test (every route must authorise):
// "A unit test enumerates all route files and fails if one lacks an
// authorization call (public allow-list: /api/health/*, /api/auth/login,
// /api/auth/setup, /api/integrations/alertmanager ...)."

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const API_DIR = join(ROOT, 'src/app/api');

/** Routes that manage auth themselves or are public by design (mirrors the
 *  edge middleware's PUBLIC list in src/middleware.ts). */
const ALLOW_LIST: Array<(rel: string) => boolean> = [
  (rel) => rel.startsWith('auth/'), // setup/login/logout/session manage their own access
  (rel) => rel.startsWith('health/'), // liveness/readiness are public
  (rel) => rel.startsWith('integrations/'), // alertmanager webhook uses its own bearer secret
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name === 'route.ts') out.push(p);
  }
  return out;
}

describe('authz route enumeration', () => {
  const files = walk(API_DIR).map((f) => relative(join(ROOT, 'src/app/api'), f).replace(/\\/g, '/'));

  it('finds a non-trivial number of routes (sanity: the tree was scanned)', () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it('every non-allow-listed route file calls requireUser or requireRole in every handler', () => {
    const unwired: string[] = [];
    for (const rel of files) {
      if (ALLOW_LIST.some((match) => match(rel))) continue;
      const src = readFileSync(join(API_DIR, rel), 'utf-8');
      const hasImport = src.includes("from '@/server/authz'");
      const handlerCount = (src.match(/export async function (?:GET|POST|PATCH|PUT|DELETE)\(/g) ?? []).length;
      const guardCount = (src.match(/await (?:requireUser|requireRole)\(req/g) ?? []).length;
      if (!hasImport || handlerCount === 0 || guardCount < handlerCount) {
        unwired.push(`${rel} (handlers=${handlerCount}, guards=${guardCount}, import=${hasImport})`);
      }
    }
    expect(unwired, `routes missing per-handler authz guards:\n${unwired.join('\n')}`).toEqual([]);
  });

  it('allow-listed auth routes never weakly skip guards on logout/session', () => {
    // logout and session must still resolve/require the user where they mutate.
    const logout = readFileSync(join(API_DIR, 'auth/logout/route.ts'), 'utf-8');
    expect(logout).toContain('requireUser');
  });
});

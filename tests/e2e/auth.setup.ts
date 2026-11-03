// Journey-suite session bootstrap (runs once before the browser projects).
//
// The 10 core journeys need three authenticated roles with PERSISTED sessions,
// because the login rate limiter (10 / 5 min) would trip if every journey
// performed its own UI login. This setup project logs in via the API exactly
// three times and saves storage states that the journey tests reuse:
//
//   .playwright-auth/owner.json     — the bootstrap owner from .env.test
//   .playwright-auth/exec-fa.json   — executive with locale 'fa' (journey 6)
//   .playwright-auth/viewer.json    — viewer (journey 8, least privilege)
//
// Sessions are cookies; they are NEVER committed (.playwright-auth/ is
// gitignored — same rule as .env / tokens).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

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

// Password policy: ≥ 12 chars, not a single repeated character, and it must
// not contain the trivial list words ("sentinel" itself is on that list —
// avoided here).
const E2E_PASSWORD = 'E2E-Vault-2026-Fire!';

const EXEC_FA_EMAIL = 'e2e-exec-fa@sentinel.test';
const VIEWER_EMAIL = 'e2e-viewer@sentinel.test';

/** Wait out the login 429 throttle once, then assert the retry succeeded. */
async function loginOrThrottle(
  ctx: import('@playwright/test').APIRequestContext,
  email: string,
  password: string,
) {
  const res = await ctx.post('/api/auth/login', { data: { email, password } });
  if (res.status() === 429) {
    // the limiter is 10 / 5 min — wait out the whole window, then retry
    await new Promise((r) => setTimeout(r, 5 * 60_000));
    const retry = await ctx.post('/api/auth/login', { data: { email, password } });
    expect(retry.status(), `login for ${email} after 429 retry`).toBe(200);
    return retry;
  }
  expect(res.status(), `login for ${email}`).toBe(200);
  return res;
}

/** Reuse a saved session when it still authenticates — conserves the limiter. */
async function validState(baseURL: string | undefined, file: string): Promise<boolean> {
  try {
    const { readFileSync } = await import('node:fs');
    readFileSync(file); // throws when absent
    const { request: newRequest } = await import('@playwright/test');
    const probe = await newRequest.newContext({ baseURL, storageState: file });
    const res = await probe.get('/api/auth/session');
    await probe.dispose();
    return res.ok();
  } catch {
    return false;
  }
}

test('create the three journey sessions', async ({ playwright, baseURL }) => {
  test.setTimeout(420_000); // worst case: one 5-minute 429 window
  const env = loadEnvTest();
  const ownerEmail = process.env.E2E_OWNER_EMAIL ?? env.MATRIX_OWNER_EMAIL;
  const ownerPassword = process.env.E2E_OWNER_PASSWORD ?? env.MATRIX_OWNER_PASSWORD;
  test.skip(!ownerEmail || !ownerPassword, 'no owner credentials (.env.test missing)');

  // 1) owner — straight API login, cookies captured (skipped when a saved
  // session still authenticates, so repeated rounds never stress the limiter)
  if (await validState(baseURL, '.playwright-auth/owner.json')) {
    const owner = await playwright.request.newContext({
      baseURL,
      storageState: '.playwright-auth/owner.json',
    });

    // 2) executive with Persian locale — recreated idempotently so the
    // membership is always present (a scoped executive without a client sees
    // honest 403s, which would empty the money home)
    const tenants = await owner.get('/api/tenants');
    const tenantList = (await tenants.json()) as Array<{ id: string }>;
    const membershipTenant = tenantList[0]?.id ?? null;

    const users = await owner.get('/api/users');
    const userList = (await users.json()) as Array<{ id: string; email: string }>;
    const execRow = userList.find((u) => u.email === EXEC_FA_EMAIL);
    if (execRow) await owner.delete(`/api/users/${execRow.id}`);

    const execRes = await owner.post('/api/users', {
      data: {
        name: 'E2E Executive FA',
        email: EXEC_FA_EMAIL,
        password: E2E_PASSWORD,
        role: 'executive',
        locale: 'fa',
        memberships: membershipTenant ? [{ tenantId: membershipTenant, role: 'executive' }] : [],
      },
    });
    expect([201]).toContain(execRes.status());

    const execC = await playwright.request.newContext({ baseURL });
    await loginOrThrottle(execC, EXEC_FA_EMAIL, E2E_PASSWORD);
    await execC.storageState({ path: '.playwright-auth/exec-fa.json' });

    // 3) viewer — least privilege for journey 8
    const viewerRes = await owner.post('/api/users', {
      data: {
        name: 'E2E Viewer',
        email: VIEWER_EMAIL,
        password: E2E_PASSWORD,
        role: 'viewer',
        locale: 'en',
        memberships: [],
      },
    });
    expect([201, 409]).toContain(viewerRes.status());

    if (!(await validState(baseURL, '.playwright-auth/viewer.json'))) {
      const viewerC = await playwright.request.newContext({ baseURL });
      await loginOrThrottle(viewerC, VIEWER_EMAIL, E2E_PASSWORD);
      await viewerC.storageState({ path: '.playwright-auth/viewer.json' });
    }

    // sanity: the saved owner state actually authenticates
    expect(await validState(baseURL, '.playwright-auth/owner.json')).toBe(true);
    return;
  }

  const owner = await playwright.request.newContext({ baseURL });
  await loginOrThrottle(owner, ownerEmail!, ownerPassword!);
  await owner.storageState({ path: '.playwright-auth/owner.json' });

  // the executive is scoped to their client (tenant memberships) — without a
  // membership the tenant-scoped data APIs answer 403 and the money home is
  // empty. Scope them to the first seeded client.
  const tenants = await owner.get('/api/tenants');
  const tenantList = (await tenants.json()) as Array<{ id: string }>;
  const membershipTenant = tenantList[0]?.id ?? null;

  // 2) executive with Persian locale — recreated idempotently so the
  // membership is always present
  const execOld = await owner.get('/api/users');
  const execRow = ((await execOld.json()) as Array<{ id: string; email: string }>).find(
    (u) => u.email === EXEC_FA_EMAIL,
  );
  if (execRow) await owner.delete(`/api/users/${execRow.id}`);

  const execRes = await owner.post('/api/users', {
    data: {
      name: 'E2E Executive FA',
      email: EXEC_FA_EMAIL,
      password: E2E_PASSWORD,
      role: 'executive',
      locale: 'fa',
      memberships: membershipTenant ? [{ tenantId: membershipTenant, role: 'executive' }] : [],
    },
  });
  expect([201]).toContain(execRes.status());

  const execC = await playwright.request.newContext({ baseURL });
  await loginOrThrottle(execC, EXEC_FA_EMAIL, E2E_PASSWORD);
  await execC.storageState({ path: '.playwright-auth/exec-fa.json' });

  // 3) viewer — least privilege for journey 8
  const viewerRes = await owner.post('/api/users', {
    data: {
      name: 'E2E Viewer',
      email: VIEWER_EMAIL,
      password: E2E_PASSWORD,
      role: 'viewer',
      locale: 'en',
      memberships: [],
    },
  });
  expect([201, 409]).toContain(viewerRes.status());

  const viewerC = await playwright.request.newContext({ baseURL });
  await loginOrThrottle(viewerC, VIEWER_EMAIL, E2E_PASSWORD);
  await viewerC.storageState({ path: '.playwright-auth/viewer.json' });

  // sanity: the saved owner state actually authenticates
  const probe = await playwright.request.newContext({
    baseURL,
    storageState: '.playwright-auth/owner.json',
  });
  expect((await probe.get('/api/auth/session')).status()).toBe(200);
});

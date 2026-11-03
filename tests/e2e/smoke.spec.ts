// Smoke test: the dashboard boots and renders the product shell.
// Every page sits behind auth, so the
// smoke signs in first (credentials from the UNTRACKED .env.test / env —
// never committed) and then asserts the money promise (Tomans) is visible.
// The full journeys live in journeys.spec.ts.

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

test('home page renders the Sentinel-SLA shell with live KPIs', async ({ page }) => {
  const env = loadEnvTest();
  const email = process.env.E2E_OWNER_EMAIL ?? env.MATRIX_OWNER_EMAIL;
  const password = process.env.E2E_OWNER_PASSWORD ?? env.MATRIX_OWNER_PASSWORD;

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/Sentinel/i);

  // Auth floor: anonymous users land on the sign-in page.
  if (page.url().includes('/login')) {
    test.skip(!email || !password, 'no E2E credentials available (.env.test missing) — login page boot verified');
    await page.getByLabel(/email/i).fill(email!);
    await page.getByLabel(/password/i).fill(password!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 15_000 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }

  // The KPI strip renders money in Tomans — the product's core promise.
  await expect(page.getByText(/Toman|T\b|\u062A/).first()).toBeVisible({
    timeout: 15_000,
  });
});

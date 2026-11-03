import { defineConfig, devices } from '@playwright/test';

// e2e wiring → the 10 core journeys (Chromium + Firefox).
// workers=1 + fullyParallel=false: the journeys are a serial narrative over a
// shared engine/DB (tenant onboarded in J2 fails in J3, resolves in J5), and
// the fleet simulation state must stay deterministic.
const PORT = Number(process.env.E2E_PORT ?? 3000);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    // session bootstrap for the journey suite (3 API logins, storage states
    // saved to .playwright-auth/ — never committed)
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      dependencies: ['setup'],
    },
  ],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: 'bun run dev',
        url: `http://localhost:${PORT}`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});

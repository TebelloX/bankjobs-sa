import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4322',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Tests run against the production build — the deployed site is static,
    // so the dev server is not representative. Port 4322, NOT astro's default
    // 4321: with reuseExistingServer, 4321 would silently reuse a running
    // `pnpm dev` server, whose dev-toolbar <h1>s break strict locators (bitten
    // by this — tests flaked whenever a dev server happened to be up).
    command: 'pnpm build && pnpm --filter @bankjobs/site exec astro preview --port 4322',
    url: 'http://localhost:4322',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

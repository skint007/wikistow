import { defineConfig, devices } from '@playwright/test';

// The desktop app (`vp pack` first) and the built web app (`vp -C apps/web
// build`) against the web tests' server, on ports of their own so both suites
// can run at once. The browser half of a sign-in runs in Chromium.
const port = Number(process.env['E2E_PORT'] ?? 3200);
process.env['E2E_PORT'] = String(port);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  reporter: process.env['CI'] ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node ../web/e2e/serve.ts',
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 60_000,
  },
});

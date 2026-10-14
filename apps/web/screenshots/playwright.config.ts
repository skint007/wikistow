import { defineConfig, devices } from '@playwright/test';

// Pictures for pull requests, not tests, so outside the e2e run and CI:
// `pnpm screenshots` in apps/web, which sets SCREENSHOTS=1. The same built
// app and server as the e2e tests (`vp build` first), on E2E_PORT and the
// two ports after it. The pictures land in apps/web/screenshots/*.png.
const port = Number(process.env['E2E_PORT'] ?? 3100);

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/serve.ts',
    cwd: '..',
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 60_000,
  },
});

import { defineConfig, devices } from '@playwright/test';

// Runs against the built app (`vp build` first) served by the real server.
// E2E_PORT moves the app off 3100, control off 3101, and loopback SMTP off 3102.
// Control uses E2E_PORT + 1; SMTP uses E2E_PORT + 2.
const port = Number(process.env['E2E_PORT'] ?? 3100);

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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/serve.ts',
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 60_000,
  },
});

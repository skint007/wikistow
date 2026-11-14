import { defineConfig, devices } from '@playwright/test';

// Runs against the built app (`vp build` first) served by the real server.
// E2E_PORT moves the app off 3100, control off 3101, and loopback SMTP off 3102.
// Control uses E2E_PORT + 1; SMTP uses E2E_PORT + 2.
const port = Number(process.env['E2E_PORT'] ?? 3100);
// Live editing's tests run against a server of their own, over HTTPS with
// HTTP/2, which browsers need to join a live session (ADR 0015 decision
// 10), on the ports ten above: the app, control and SMTP.
const livePort = port + 10;
const LIVE = /live-[a-z-]+\.spec\.ts/;
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

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
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: LIVE },
    {
      name: 'live',
      testMatch: LIVE,
      // Where the fixtures reach this server's control port (e2e/fixtures.ts).
      metadata: { control: `http://127.0.0.1:${livePort + 1}` },
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `https://localhost:${livePort}`,
        // The server's certificate is one it made for the run.
        ignoreHTTPSErrors: true,
      },
    },
  ],
  webServer: [
    {
      command: 'node e2e/serve.ts',
      url: `http://localhost:${port}/api/health`,
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 60_000,
      // SIGTERM, so the server drops its database (e2e/serve.ts). Unset,
      // Playwright SIGKILLs it and the database is left behind.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
    },
    {
      command: 'node e2e/serve.ts',
      env: { ...env, E2E_PORT: String(livePort), E2E_TLS: '1' },
      url: `https://localhost:${livePort}/api/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
    },
  ],
});

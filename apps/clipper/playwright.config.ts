import { defineConfig } from '@playwright/test';

// The extension's tests (e2e/clipper.spec.ts): its tests' build
// (`pnpm build` first) in Chromium, against a fake native host. Each test
// starts a browser of its own, with its own profile.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  reporter: process.env['CI'] ? 'line' : 'list',
  timeout: 60_000,
  use: { trace: 'retain-on-failure' },
});

import { defineConfig } from '@playwright/test';

// The stores' pictures, not tests, so outside the e2e run and CI (the
// store listing, docs/web-clipper-store-listing.md). After a build:
//
//   ./node_modules/.bin/playwright test -c screenshots
//
// in apps/clipper. They land in docs/screenshots/clipper.
export default defineConfig({
  testDir: '.',
  outputDir: '../test-results/screenshots',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
});

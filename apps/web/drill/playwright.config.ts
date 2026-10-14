import { defineConfig, devices } from '@playwright/test';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DRILL_STATE, WIKISTOW_URL } from './drill';

// The restore drill against a running installation (deploy/test-instance/README.md):
// `seed` fills a fresh one and records it in DRILL_STATE; `check` proves a
// restored copy of it still works. No server is started here.
//
// The pages hold passwords, passphrases and recovery keys, so nothing that
// captures them is kept: no traces, screenshots or videos, no HTML report,
// and Playwright's own files (the page snapshot it writes on a failure) go
// beside the state file, not into the repo. A directory made for the state
// only its owner can open; one that exists, such as $HOME, is left as it is.
const stateDir = dirname(DRILL_STATE);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
// The snapshots aren't redacted, so they go in a directory of the drill's own,
// always private, whatever the state file's directory is. Playwright empties
// and remakes `outputDir` each run, so the private one is its parent.
const output = join(stateDir, 'drill-output');
mkdirSync(output, { recursive: true, mode: 0o700 });
chmodSync(output, 0o700);

export default defineConfig({
  testDir: '.',
  outputDir: join(output, 'test-results'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Room to wait out sign-in's limit of five a minute (drill.ts, signInAs).
  timeout: 180_000,
  reporter: 'list',
  use: {
    baseURL: WIKISTOW_URL,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  expect: { timeout: 15_000 },
  projects: [
    { name: 'seed', testMatch: 'seed.spec.ts', use: { ...devices['Desktop Chrome'] } },
    { name: 'check', testMatch: 'check.spec.ts', use: { ...devices['Desktop Chrome'] } },
  ],
});

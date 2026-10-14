import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
import { playwright } from 'vite-plus/test/browser-playwright';

export default defineConfig({
  fmt: {
    ignorePatterns: [
      '**/dist/**',
      'wikistow/**',
      '*.md',
      'packages/client/test/vectors.json',
      '**/drizzle/meta/**',
      '**/routeTree.gen.ts',
      // A copy of the design file, kept byte-identical.
      'packages/ui/src/styles/theme.css',
      // HTML as Word puts it on the clipboard, for the paste tests.
      'packages/ui/test/word-paste.html',
    ],
    singleQuote: true,
  },
  lint: {
    ignorePatterns: ['**/dist/**', '**/routeTree.gen.ts'],
    plugins: ['typescript'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'typescript/no-explicit-any': 'error',
      'no-console': 'error',
    },
  },
  test: {
    // The integration run drops its databases at the end; give that room.
    teardownTimeout: 300_000,
    projects: [
      {
        test: { name: 'client', root: 'packages/client', include: ['test/**/*.test.ts'] },
      },
      {
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/test/**/*.test.ts'],
          exclude: ['packages/client/**', '**/*.integration.test.ts', '**/node_modules/**'],
          // The CLI's tests write its private files, each synced to disk,
          // which on a runner shared with other pipelines can take seconds.
          testTimeout: 30_000,
        },
      },
      {
        // Real Postgres: `docker compose up -d db` locally, a service in CI.
        test: {
          name: 'integration',
          include: ['{apps,packages}/*/test/**/*.integration.test.ts'],
          globalSetup: ['packages/server/test/global-setup.ts'],
          // Some tests start the server and the backup and restore scripts as
          // processes of their own, which on a runner shared with other
          // pipelines can take more than 20 seconds together.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        // The tree and sharing benchmarks, run only when asked for, with
        // WIKISTOW_BENCH naming the file for their timings (wikistow/benchmarks).
        test: {
          name: 'bench',
          include: ['apps/server/bench/*.ts'],
          globalSetup: ['packages/server/test/global-setup.ts'],
          hookTimeout: 60_000,
        },
      },
      {
        // The protocol must behave identically in the browser, so the shared
        // vectors also run in Chromium.
        test: {
          name: 'client-browser',
          root: 'packages/client',
          include: ['test/vectors.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        // The editor surfaces, mounted for real: what they give back is the
        // page's exact bytes. And the Markdown worker, which takes the plain
        // build of the entity decoder, as the app does (apps/web/vite.config.ts).
        resolve: {
          alias: {
            '@': fileURLToPath(new URL('packages/ui/src', import.meta.url)),
            'decode-named-character-reference': createRequire(
              fileURLToPath(new URL('packages/ui/package.json', import.meta.url)),
            ).resolve('decode-named-character-reference'),
          },
        },
        test: {
          name: 'ui-browser',
          root: 'packages/ui',
          include: ['test/**/*.browser.test.tsx'],
          // CI runs several pipelines on one runner, and there the first load
          // of the visual editor alone can take over 10 seconds. A poll still
          // ends as soon as it matches, so this only slows a failing test.
          testTimeout: 60_000,
          expect: { poll: { timeout: 30_000 } },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});

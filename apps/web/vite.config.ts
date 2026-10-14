import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ui = (path: string) => fileURLToPath(new URL(`../../packages/ui/${path}`, import.meta.url));

// The Markdown parser decodes `&amp;` and the like with a package whose
// build for pages asks `document`, which the Markdown worker hasn't. Every
// bundle takes its plain build, with its own table, so the worker loads.
const entities = createRequire(ui('package.json')).resolve('decode-named-character-reference');

// What the account menu shows as the running version: the package version
// and the commit built, as `0.0.0+5b9e5ec4`. Releases are told apart by
// commit (the image tag is the same 8 characters). CI names the commit; a
// checkout, as the Arch package builds from, asks git. The image and the
// desktop app ship this build as it is.
const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const commit = (): string => {
  if (process.env['CI_COMMIT_SHA']) return process.env['CI_COMMIT_SHA'];
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
};

// A plain object: the router plugin's Vite types differ from Vite+'s, so
// defineConfig's checking can't compare them.
export default {
  plugins: [
    // Routes live in the shared UI package so the desktop app can reuse them.
    tanstackRouter({
      target: 'react',
      routesDirectory: ui('src/routes'),
      generatedRouteTree: ui('src/routeTree.gen.ts'),
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  define: { __APP_VERSION__: JSON.stringify(`${version}+${commit().slice(0, 8)}`) },
  resolve: { alias: { '@': ui('src'), 'decode-named-character-reference': entities } },
  // The API runs separately in development (`pnpm --filter @wikistow/server-app dev`).
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: { outDir: 'dist', sourcemap: true },
  // The vault worker imports libsodium; ES modules let it share chunks.
  worker: { format: 'es' },
};

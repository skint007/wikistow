import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_FONTS } from '../../packages/server/src/public-links/fonts.ts';
import { REACT_FILES } from '../../packages/ui/src/workshop/library.ts';

const ui = (path: string) => fileURLToPath(new URL(`../../packages/ui/${path}`, import.meta.url));

// The Markdown parser decodes `&amp;` and the like with a package whose
// build for pages asks `document`, which the Markdown worker hasn't. Every
// bundle takes its plain build, with its own table, so the worker loads.
const entities = createRequire(ui('package.json')).resolve('decode-named-character-reference');

// What the account menu shows as the running version. A release build
// shows the release version, as `0.2.0`: WIKISTOW_RELEASE names it, and it
// must be the one in package.json (`node scripts/version.ts`). Any other
// build adds the commit it was built from, as `0.2.0+5b9e5ec4`, the same 8
// characters as the image's `sha-` tag. CI names the commit; a checkout asks
// git. The image and the desktop app ship this build as it is.
const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const release = process.env['WIKISTOW_RELEASE'] || undefined;
if (release !== undefined && release !== version) {
  throw new Error(`WIKISTOW_RELEASE is ${release}, but package.json says ${version}`);
}
const commit = (): string => {
  if (process.env['GITHUB_SHA']) return process.env['GITHUB_SHA'];
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
};

const SDK = fileURLToPath(new URL('../../packages/plugin-sdk/', import.meta.url));
/** A package's folder, as resolved from the folder holding `from`, a package.json. */
const packageDir = (name: string, from: string) =>
  dirname(createRequire(from).resolve(`${name}/package.json`));

/**
 * `virtual:workshop-library`: what a workshop build may import, read in at
 * build time (`packages/ui/src/workshop/library.ts`). The SDK's sources,
 * and React as the SDK resolves it, the version plugins are written
 * against. Only the workshop's build worker imports it.
 */
async function workshopLibrary() {
  const files: Record<string, string> = {};
  for (const name of await readdir(join(SDK, 'src'))) {
    // Its command-line build is Node's, never a plugin's.
    if (name === 'build.ts') continue;
    files[`plugin-sdk/${name}`] = await readFile(join(SDK, 'src', name), 'utf8');
  }
  const reactDom = packageDir('react-dom', join(SDK, 'package.json'));
  const packages = [
    ['react', packageDir('react', join(SDK, 'package.json')), REACT_FILES.react],
    ['react-dom', reactDom, REACT_FILES['react-dom']],
    ['scheduler', packageDir('scheduler', join(reactDom, 'package.json')), REACT_FILES.scheduler],
  ] as const;
  for (const [name, folder, names] of packages) {
    for (const file of names) {
      files[`${name}/${file}`] = await readFile(join(folder, 'cjs', file), 'utf8');
    }
  }
  return files;
}

const LIBRARY = 'virtual:workshop-library';
const library = {
  name: 'workshop-library',
  resolveId: (id: string) => (id === LIBRARY ? `\0${LIBRARY}` : null),
  load: async (id: string) =>
    id === `\0${LIBRARY}` ? `export default ${JSON.stringify(await workshopLibrary())};` : null,
};

/**
 * The fonts a public page loads, which the server serves from this build
 * (`PAGE_FONTS`), written under `/fonts/` by names that don't change, as
 * the page's one stylesheet names them.
 */
const publicPageFonts = {
  name: 'public-page-fonts',
  apply: 'build' as const,
  async generateBundle(this: {
    emitFile: (file: { type: 'asset'; fileName: string; source: Uint8Array }) => string;
  }) {
    const resolve = createRequire(ui('package.json')).resolve;
    for (const { file } of PAGE_FONTS) {
      const source = await readFile(resolve(`@fontsource-variable/nunito/files/${file}`));
      this.emitFile({ type: 'asset', fileName: `fonts/${file}`, source });
    }
  },
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
    // For the dev server; a build bundles workers with `worker.plugins`.
    library,
    publicPageFonts,
  ],
  define: { __APP_VERSION__: JSON.stringify(release ?? `${version}+${commit().slice(0, 8)}`) },
  resolve: { alias: { '@': ui('src'), 'decode-named-character-reference': entities } },
  // The API runs separately in development (`pnpm --filter @wikistow/server-app dev`).
  // Library plugins' files are the server's too (ADR 0002).
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/plugins/': 'http://127.0.0.1:3000' } },
  build: { outDir: 'dist', sourcemap: true },
  // The vault worker imports libsodium; ES modules let it share chunks.
  worker: { format: 'es', plugins: () => [library] },
};

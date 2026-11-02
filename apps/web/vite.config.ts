import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIAGRAM_HOST_PAGE,
  DIAGRAM_HOST_SCRIPT,
  DIAGRAM_LIBRARY,
} from '../../packages/contracts/src/security.ts';
import { MATH_FONT, PAGE_FONTS } from '../../packages/server/src/public-links/fonts.ts';
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
 * (`PAGE_FONTS`, `MATH_FONT`), written under `/fonts/` by names that don't change, as
 * the page's one stylesheet names them.
 */
const publicPageFonts = {
  name: 'public-page-fonts',
  apply: 'build' as const,
  async generateBundle(this: {
    emitFile: (file: { type: 'asset'; fileName: string; source: Uint8Array }) => string;
  }) {
    const resolve = createRequire(ui('package.json')).resolve;
    const files = [
      ...PAGE_FONTS.map(({ file }) => `@fontsource-variable/nunito/files/${file}`),
      `@fontsource/noto-sans-math/files/${MATH_FONT}`,
    ];
    for (const path of files) {
      const source = await readFile(resolve(path));
      this.emitFile({ type: 'asset', fileName: `fonts/${basename(path)}`, source });
    }
  },
};

/**
 * Mermaid's own single-file build, which the diagram host frame loads as a
 * classic script (ADR 0010): a module script or `import()` from the
 * frame's opaque origin would be a cross-origin request. Written under
 * `/assets/mermaid/` by its hash, so it is cached for good, with the host
 * page naming it. The dev server serves both from here.
 */
const mermaidFile = createRequire(fileURLToPath(import.meta.url)).resolve(
  'mermaid/dist/mermaid.min.js',
);
const hostPage = (library: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>WikiStow diagram host</title>
    <script src="${library}"></script>
    <script src="${DIAGRAM_HOST_SCRIPT}"></script>
  </head>
  <body></body>
</html>
`;
const diagramLibrary = {
  name: 'diagram-library',
  configureServer(server: {
    middlewares: {
      use: (path: string, handle: (req: unknown, res: ServerResponse) => void) => void;
    };
  }) {
    const library = `${DIAGRAM_LIBRARY}dev.js`;
    server.middlewares.use(library, (_req, res) => {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(readFileSync(mermaidFile));
    });
    server.middlewares.use(DIAGRAM_HOST_PAGE, (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(hostPage(library));
    });
  },
  async generateBundle(this: {
    emitFile: (file: { type: 'asset'; fileName: string; source: Uint8Array | string }) => string;
  }) {
    const source = await readFile(mermaidFile);
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
    const library = `${DIAGRAM_LIBRARY}${hash}.js`;
    this.emitFile({ type: 'asset', fileName: library.slice(1), source });
    this.emitFile({
      type: 'asset',
      fileName: DIAGRAM_HOST_PAGE.slice(1),
      source: hostPage(library),
    });
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
    diagramLibrary,
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

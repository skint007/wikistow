import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite-plus';
import {
  DIAGRAM_FILES,
  PLUGIN_HOST_PAGE,
  PLUGIN_HOST_SCRIPT,
} from '../../packages/contracts/src/security.ts';
import { MATH_FONT, PAGE_FONTS } from '../../packages/server/src/public-links/fonts.ts';
import { REACT_FILES } from '../../packages/ui/src/workshop/library.ts';
import { meaningFile, meaningModel, meaningModule } from './meaning.ts';

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
 * The diagram host frame's files (ADR 0010), under `DIAGRAM_FILES` by their
 * hashes: Mermaid's own single-file build, which the frame loads as a
 * classic script (a module script or `import()` from the frame's opaque
 * origin would be a cross-origin request), the frame's script
 * `diagram/host.js`, and the page loading both, which the app frames as
 * `__DIAGRAM_HOST__`. All are cached for good, so once loaded the frame
 * loads offline from the browser's cache. A sandboxed frame's requests
 * never go through the service worker, so its cache can't serve them
 * (#333). The dev server serves them from here.
 */
const hashed = (name: string, extension: string, source: Uint8Array | string) =>
  `${DIAGRAM_FILES}${name}-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.${extension}`;
const diagramFiles = () => {
  const mermaid = readFileSync(
    createRequire(fileURLToPath(import.meta.url)).resolve('mermaid/dist/mermaid.min.js'),
  );
  const script = readFileSync(new URL('diagram/host.js', import.meta.url));
  const library = hashed('mermaid', 'js', mermaid);
  const hostScript = hashed('host', 'js', script);
  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>WikiStow diagram host</title>
    <script src="${library}"></script>
    <script src="${hostScript}"></script>
  </head>
  <body></body>
</html>
`;
  const host = hashed('host', 'html', page);
  const files = new Map<string, Uint8Array | string>([
    [library, mermaid],
    [hostScript, script],
    [host, page],
  ]);
  return { host, files };
};
const diagram = diagramFiles();
const diagramFrame = {
  name: 'diagram-frame',
  configureServer(server: {
    middlewares: {
      use: (path: string, handle: (req: unknown, res: ServerResponse) => void) => void;
    };
  }) {
    for (const [path, source] of diagram.files) {
      server.middlewares.use(path, (_req, res) => {
        res.setHeader('Content-Type', path.endsWith('.html') ? 'text/html' : 'text/javascript');
        res.end(source);
      });
    }
  },
  generateBundle(this: {
    emitFile: (file: { type: 'asset'; fileName: string; source: Uint8Array | string }) => string;
  }) {
    for (const [path, source] of diagram.files) {
      this.emitFile({ type: 'asset', fileName: path.slice(1), source });
    }
  },
};

/**
 * The service worker, `/sw.js` (ADR 0009, decision 6), written once the
 * build is on disk: `sw/sw.ts` with the files it keeps named before it.
 * It keeps the files at the top of the build but the plugin frame's own
 * and ONNX Runtime's notices,
 * and everything under `/assets/` but source maps, Brotli copies,
 * Workshop's esbuild, which only an online Workshop loads, the model's
 * files, which only someone who turns on search by meaning loads and the
 * embedding worker keeps itself (ADR 0016, decision 3), and the diagram
 * frame's files. The
 * frame's opaque origin is never the worker's, so the worker only fetches
 * those once, into the browser's own cache, where the frame finds them
 * (`warm`). Its cache is named by a hash of the files it keeps, so each
 * build that changes one installs again.
 */
// ONNX Runtime's notices, 330 KB, which only someone reading them needs.
const LEFT_TO_SERVER = new Set([
  PLUGIN_HOST_PAGE,
  PLUGIN_HOST_SCRIPT,
  '/third-party-notices-onnxruntime.txt',
]);
/** The largest file the service worker keeps; the largest bundle is about 1 MB. */
const SHELL_FILE_LIMIT = 4 * 1024 * 1024;
const appShell = () => {
  let outDir = '';
  return {
    name: 'app-shell',
    apply: 'build' as const,
    configResolved(config: { build: { outDir: string }; root: string }) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files: string[] = [];
      for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const file = `/${relative(outDir, join(entry.parentPath, entry.name)).replaceAll(sep, '/')}`;
        const top = !file.slice(1).includes('/');
        const kept = top
          ? !LEFT_TO_SERVER.has(file) && file !== '/sw.js'
          : file.startsWith('/assets/') &&
            !file.startsWith(DIAGRAM_FILES) &&
            !meaningFile(file) &&
            !file.endsWith('.map') &&
            !file.endsWith('.br') &&
            !/\/esbuild-[^/]*\.wasm$/.test(file);
        if (kept) files.push(file);
      }
      files.sort();
      const hash = createHash('sha256');
      for (const file of files) {
        const bytes = await readFile(join(outDir, file));
        // Every visitor downloads what it keeps, so a large file left in by
        // mistake (a model's, a runtime's WebAssembly) fails the build.
        if (bytes.byteLength > SHELL_FILE_LIMIT) {
          throw new Error(`The service worker would keep ${file}, of ${bytes.byteLength} bytes`);
        }
        hash.update(file).update(bytes);
      }
      const shell = {
        cache: `wikistow-app-${hash.digest('hex').slice(0, 16)}`,
        files,
        warm: [...diagram.files.keys()].sort(),
      };
      const { code } = await transformWithOxc(
        await readFile(new URL('sw/sw.ts', import.meta.url), 'utf8'),
        'sw.ts',
        { lang: 'ts' },
      );
      // The type-only export that makes `sw.ts` a module to the type checker
      // comes out as `export {};`, which a worker's classic script can't hold.
      const script = code.replace(/^export \{\};\n?/m, '');
      if (/^(import|export)\b/m.test(script)) throw new Error('sw/sw.ts must not import or export');
      await writeFile(join(outDir, 'sw.js'), `const SHELL = ${JSON.stringify(shell)};\n${script}`);
    },
  };
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
    meaningModule,
    meaningModel,
    publicPageFonts,
    diagramFrame,
    appShell(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(release ?? `${version}+${commit().slice(0, 8)}`),
    __DIAGRAM_HOST__: JSON.stringify(diagram.host),
  },
  resolve: { alias: { '@': ui('src'), 'decode-named-character-reference': entities } },
  // The API runs separately in development (`pnpm --filter @wikistow/server-app dev`).
  // Library plugins' files are the server's too (ADR 0002).
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/plugins/': 'http://127.0.0.1:3000' } },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      // The embedder is an entry of its own until the app uses it (ADR 0016,
      // step 4), so the build has its worker, which the browser tests run.
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        embedder: ui('src/meaning/embedder.ts'),
      },
    },
  },
  // The vault worker imports libsodium; ES modules let it share chunks.
  worker: { format: 'es', plugins: () => [library, meaningModule] },
};

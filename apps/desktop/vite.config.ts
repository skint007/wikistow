import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
import type { PackUserConfig } from 'vite-plus/pack';
import { REACT_FILES } from './src/workshop/library.ts';

// `vp pack` builds the main process as ES modules for Electron's own Node,
// and the preload on its own as CommonJS, which sandboxed preloads require.
// The pages are the web app's build (`apps/web/dist`), unchanged.
const bundle = (entry: Record<string, string>, format: 'esm' | 'cjs'): PackUserConfig => ({
  entry,
  format,
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  // Both builds write here at once, so neither clears it.
  clean: false,
  deps: { neverBundle: ['electron'], alwaysBundle: [/^(?!electron$).*/], onlyBundle: false },
});

const SDK = fileURLToPath(new URL('../../packages/plugin-sdk/', import.meta.url));
const require = createRequire(import.meta.url);
/** A package's folder, as resolved from the folder holding `from`, a package.json. */
const packageDir = (name: string, from: string) =>
  dirname(createRequire(from).resolve(`${name}/package.json`));

/**
 * `virtual:workshop-library`: what a workshop build may import, read in at
 * pack time (`src/workshop/library.ts`). The SDK's sources, and React as
 * the SDK resolves it, the version plugins are written against.
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

export default defineConfig({
  pack: [
    {
      ...bundle({ main: 'src/main.ts', 'workshop-build': 'src/workshop/build-worker.ts' }, 'esm'),
      plugins: [
        {
          name: 'workshop-library',
          resolveId: (id: string) => (id === LIBRARY ? `\0${LIBRARY}` : null),
          load: async (id: string) =>
            id === `\0${LIBRARY}`
              ? `export default ${JSON.stringify(await workshopLibrary())};`
              : null,
        },
      ],
      // The bundler's WebAssembly, which the build worker reads beside it.
      copy: [{ from: require.resolve('esbuild-wasm/esbuild.wasm'), to: 'dist' }],
    },
    bundle({ preload: 'src/preload.ts' }, 'cjs'),
  ],
});

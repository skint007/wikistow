import { defineConfig } from 'vite-plus';
import type { PackUserConfig } from 'vite-plus/pack';

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

export default defineConfig({
  pack: [bundle({ main: 'src/main.ts' }, 'esm'), bundle({ preload: 'src/preload.ts' }, 'cjs')],
});

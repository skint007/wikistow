import { defineConfig } from 'vite-plus';

// Bundled standalone, dependencies included, so the image needs no node_modules.
const bundle = (entry: Record<string, string>) => ({
  entry,
  platform: 'node' as const,
  format: 'esm' as const,
  target: 'node26',
  outDir: 'dist',
  deps: { alwaysBundle: [/.*/], onlyBundle: false as const },
  sourcemap: true,
});

// `vp pack` bundles the server and the migration runner. The worker that
// renders public pages is bundled on its own, beside the server's files,
// where the server looks for it (`createRenderer`), so it shares no chunk
// with them.
export default defineConfig({
  pack: [
    bundle({ server: 'src/main.ts', migrate: 'src/migrate.ts' }),
    bundle({ 'render-worker': '../../packages/server/src/public-links/render-worker.ts' }),
  ],
});

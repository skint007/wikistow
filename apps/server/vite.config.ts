import { defineConfig } from 'vite-plus';

// `vp pack` bundles the server and the migration runner into standalone files,
// dependencies included, so the image needs no node_modules.
export default defineConfig({
  pack: {
    entry: { server: 'src/main.ts', migrate: 'src/migrate.ts' },
    platform: 'node',
    format: 'esm',
    target: 'node26',
    outDir: 'dist',
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    sourcemap: true,
  },
});

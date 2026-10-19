import { defineConfig } from 'vite-plus';

// `vp pack` bundles the CLI into one file, dependencies included, so it runs
// with nothing but Node: `node dist/wikistow.mjs`. The release builds its
// binaries from that file (`scripts/binaries.sh`).
export default defineConfig({
  pack: {
    entry: { wikistow: 'src/main.ts' },
    platform: 'node',
    format: 'esm',
    target: 'node26',
    outDir: 'dist',
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    // Only the CLI's own tests build with this on (`test/support/cli.ts`).
    env: { WIKISTOW_TEST_TRUST_ANY_SECRET_TOOL: '' },
  },
});

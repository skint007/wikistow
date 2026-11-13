// Pack the desktop app into one `out/app.asar`, as the system Electron runs
// it: `electron44 /usr/lib/wikistow-desktop/app.asar`. The .deb and .rpm
// run it on their own Electron (scripts/linux-packages.sh). Run after
// `vp pack` here and `vp build` in apps/web:
//
//   node scripts/asar.ts
import { createPackage } from '@electron/asar';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const stage = await mkdtemp(join(tmpdir(), 'wikistow-desktop-'));
try {
  const { productName, version } = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
  // Only what the app loads: its bundles, the web build (with the
  // workshop's bundler, the search model and their WebAssembly) and the
  // window icons, the beta's included (src/install.ts). Not source maps,
  // nor the Brotli copies the server sends browsers, as the app reads its
  // files from disk (ADR 0016, decision 3).
  const loaded = {
    recursive: true,
    filter: (source: string) => !source.endsWith('.map') && !source.endsWith('.br'),
  };
  await cp(join(here, 'dist'), join(stage, 'dist'), loaded);
  await cp(join(here, '../web/dist'), join(stage, 'web'), loaded);
  for (const icon of ['wikistow-desktop.png', 'wikistow-desktop-beta.png']) {
    await cp(join(here, 'packaging', icon), join(stage, 'packaging', icon));
  }
  await writeFile(
    join(stage, 'package.json'),
    JSON.stringify({
      name: 'wikistow-desktop',
      productName,
      version,
      type: 'module',
      main: 'dist/main.mjs',
    }),
  );
  await createPackage(stage, join(here, 'out/app.asar'));
} finally {
  await rm(stage, { recursive: true, force: true });
}

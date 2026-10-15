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
  // Only what the app loads: its bundles (with the workshop's bundler and
  // its WebAssembly), the web build and the icon.
  const noMaps = { recursive: true, filter: (source: string) => !source.endsWith('.map') };
  await cp(join(here, 'dist'), join(stage, 'dist'), noMaps);
  await cp(join(here, '../web/dist'), join(stage, 'web'), noMaps);
  await cp(
    join(here, 'packaging/wikistow-desktop.png'),
    join(stage, 'packaging/wikistow-desktop.png'),
  );
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

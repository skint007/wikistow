// Lays out each browser's build around the scripts `vp pack` made
// (vite.config.ts): its manifest, the scripts, the popup's page and the
// icons, in dist/chrome and dist/firefox, each zipped beside it as the
// stores take it. And dist/chrome-test, for the tests alone, and
// dist/chrome-keyed when asked (scripts/builds.ts, which says how).
//
//   node scripts/assemble.ts
//
// The zips' files are in a fixed order with a fixed time, so a build can
// be compared byte for byte (scripts/zip.ts).
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builds, chromeId } from './builds.ts';
import { files, writeZip } from './zip.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  version: string;
};

// An old keyed build, never one from another key.
await rm(join(dist, 'chrome-keyed'), { recursive: true, force: true });
for (const build of builds(version, process.env)) {
  const out = join(dist, build.name);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const script of ['background', 'capture', 'area', 'popup']) {
    await cp(join(dist, 'scripts', `${script}.iife.js`), join(out, `${script}.js`));
  }
  await cp(join(root, 'src', 'popup', 'popup.html'), join(out, 'popup.html'));
  await cp(join(root, 'src', 'popup', 'popup.css'), join(out, 'popup.css'));
  await cp(join(root, 'icons'), join(out, 'icons'), { recursive: true });
  // The extension's licence, and Readability's, which capture.js bundles.
  await cp(join(root, '..', '..', 'LICENSE'), join(out, 'LICENSE'));
  await cp(join(root, 'THIRD-PARTY-NOTICES.txt'), join(out, 'THIRD-PARTY-NOTICES.txt'));
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(build.manifest, null, 2)}\n`);
  if (build.name === 'chrome-keyed' && build.manifest.key) {
    process.stdout.write(`dist/${build.name} has the ID ${chromeId(build.manifest.key)}\n`);
  }
  if (!build.zip) continue;
  await writeZip(
    join(dist, `wikistow-clipper-${version}-${build.name}.zip`),
    out,
    await files(out),
  );
}
process.stdout.write(`Built the clipper ${version} in ${relative(process.cwd(), dist)}\n`);

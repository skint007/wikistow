// Lays out each browser's build around the scripts `vp pack` made
// (vite.config.ts): its manifest, the scripts, the popup's page and the
// icons, in dist/chrome and dist/firefox, each zipped beside it as the
// stores take it. And dist/chrome-test, for the tests alone (src/manifest.ts).
//
//   node scripts/assemble.ts
//
// CLIPPER_FIREFOX_ID names Firefox's add-on ID, which Mozilla Add-ons fixes
// at the first upload (ADR 0017, step 7). Until then a build names a
// placeholder no app trusts. The zips' files are in a fixed order with a
// fixed time, so a build can be compared byte for byte.
import { zipSync } from 'fflate';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_KEY } from '../e2e/test-key.ts';
import { manifest, type ManifestOptions, type Target } from '../src/manifest.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  version: string;
};
const firefoxId = process.env['CLIPPER_FIREFOX_ID'] || 'web-clipper-dev@wikistow.invalid';

const builds: { name: string; target: Target; options: ManifestOptions; zip: boolean }[] = [
  { name: 'chrome', target: 'chrome', options: { version }, zip: true },
  { name: 'firefox', target: 'firefox', options: { version, firefoxId }, zip: true },
  {
    name: 'chrome-test',
    target: 'chrome',
    options: { version, test: { key: TEST_KEY, hosts: ['http://127.0.0.1/*'] } },
    zip: false,
  },
];

async function files(folder: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(relative(folder, join(entry.parentPath, entry.name)));
  }
  return found.sort();
}

// SOURCE_DATE_EPOCH, or the earliest day a zip can hold. A zip keeps a
// time without its zone, which fflate reads from the Date as local time:
// so the Date is made of the UTC time's parts, read the same in any zone.
const utc = new Date(Number(process.env['SOURCE_DATE_EPOCH'] ?? 315_532_800) * 1000);
const mtime = new Date(
  utc.getUTCFullYear(),
  utc.getUTCMonth(),
  utc.getUTCDate(),
  utc.getUTCHours(),
  utc.getUTCMinutes(),
  utc.getUTCSeconds(),
);
for (const build of builds) {
  const out = join(dist, build.name);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const script of ['background', 'capture', 'popup']) {
    await cp(join(dist, 'scripts', `${script}.iife.js`), join(out, `${script}.js`));
  }
  await cp(join(root, 'src', 'popup', 'popup.html'), join(out, 'popup.html'));
  await cp(join(root, 'src', 'popup', 'popup.css'), join(out, 'popup.css'));
  await cp(join(root, 'icons'), join(out, 'icons'), { recursive: true });
  // The extension's licence, and Readability's, which capture.js bundles.
  await cp(join(root, '..', '..', 'LICENSE'), join(out, 'LICENSE'));
  await cp(join(root, 'THIRD-PARTY-NOTICES.txt'), join(out, 'THIRD-PARTY-NOTICES.txt'));
  await writeFile(
    join(out, 'manifest.json'),
    `${JSON.stringify(manifest(build.target, build.options), null, 2)}\n`,
  );
  if (!build.zip) continue;
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const path of await files(out)) {
    entries[path.split('\\').join('/')] = [await readFile(join(out, path)), { mtime }];
  }
  await writeFile(join(dist, `wikistow-clipper-${version}-${build.name}.zip`), zipSync(entries));
}
process.stdout.write(`Built the clipper ${version} in ${relative(process.cwd(), dist)}\n`);

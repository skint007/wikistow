// Builds the source zip as Mozilla's reviewers do, and checks it gives
// dist/firefox file for file, byte for byte. It unpacks the zip in a new
// folder, runs the commands in its README's `sh` block there, and
// compares that folder's apps/clipper/dist/firefox with this one's.
//
//   node scripts/check-source.ts
//
// Run after scripts/assemble.ts and scripts/source.ts. It needs pnpm, and
// reaches npm's registry, or pnpm's store, for the install.
import { unzipSync } from 'fflate';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { files } from './zip.ts';

const clipper = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(join(clipper, 'package.json'), 'utf8')) as {
  version: string;
};
const zip = join(clipper, 'dist', `wikistow-clipper-${version}-source.zip`);
const folder = await mkdtemp(join(process.env['RUNNER_TEMP'] || tmpdir(), 'clipper-source-'));
try {
  for (const [path, bytes] of Object.entries(unzipSync(await readFile(zip)))) {
    if (path.endsWith('/')) continue;
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), bytes);
  }
  const readme = await readFile(join(folder, 'README.md'), 'utf8');
  const block = /```sh\n([\s\S]*?)```/.exec(readme)?.[1];
  if (!block) throw new Error('The source README has no sh block to build with');
  // As a reviewer runs it: in a shell, from the unpacked folder, with none
  // of this build's settings.
  const env = { ...process.env };
  delete env['CLIPPER_FIREFOX_ID'];
  delete env['CLIPPER_CHROME_KEY'];
  const run = spawnSync('bash', ['-euo', 'pipefail', '-c', block], {
    cwd: folder,
    env,
    stdio: 'inherit',
  });
  if (run.status !== 0) throw new Error(`Building the source failed (${run.status ?? run.signal})`);

  const ours = join(clipper, 'dist', 'firefox');
  const theirs = join(folder, 'apps', 'clipper', 'dist', 'firefox');
  const [want, got] = [await files(ours), await files(theirs)];
  const differ = [...new Set([...want, ...got])].filter(
    (path) => !want.includes(path) || !got.includes(path),
  );
  for (const path of want.filter((path) => got.includes(path))) {
    const [a, b] = [await readFile(join(ours, path)), await readFile(join(theirs, path))];
    if (!a.equals(b)) differ.push(path);
  }
  if (differ.length > 0) {
    throw new Error(`The source builds other files than dist/firefox: ${differ.sort().join(', ')}`);
  }
  process.stdout.write(`The source zip builds dist/firefox exactly, ${want.length} files\n`);
} finally {
  await rm(folder, { recursive: true, force: true });
}

// The release version. WikiStow has one, kept in every workspace
// package.json: the account menu shows the web app's, the desktop app's goes
// into its app.asar, and the CLI prints its own. The AUR packages take the
// version of the release they are published for (.github/workflows/aur.yml).
//
//   node scripts/version.ts         prints it, and fails if any disagree
//   node scripts/version.ts 0.3.0   sets it everywhere
//
// A release tag is `v` and this version (docs/releasing.md).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const packages = ['package.json'];
for (const group of ['apps', 'packages']) {
  for (const name of (await readdir(join(root, group))).sort()) {
    packages.push(`${group}/${name}/package.json`);
  }
}

const wanted = process.argv[2];
if (wanted !== undefined) {
  if (!SEMVER.test(wanted)) throw new Error(`Not a version: ${wanted}`);
  for (const path of packages) {
    const json = JSON.parse(await readFile(join(root, path), 'utf8')) as Record<string, unknown>;
    // Keep `version` beside `name`, where npm puts it.
    const { name, version: _, ...rest } = json;
    await writeFile(
      join(root, path),
      `${JSON.stringify({ name, version: wanted, ...rest }, null, 2)}\n`,
    );
  }
}

const found = new Map<string, string>();
for (const path of packages) {
  const { version } = JSON.parse(await readFile(join(root, path), 'utf8')) as { version?: string };
  found.set(path, String(version));
}

const version = found.get('package.json') ?? '';
if (!SEMVER.test(version) || [...found.values()].some((v) => v !== version)) {
  const list = [...found].map(([path, v]) => `  ${path}: ${v}`).join('\n');
  process.stderr.write(
    `The versions must agree, as \`node scripts/version.ts <version>\` sets them:\n${list}\n`,
  );
  process.exit(1);
}
process.stdout.write(`${version}\n`);

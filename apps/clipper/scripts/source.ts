// The source zip Mozilla Add-ons takes with each version, which its
// reviewers build into the same files (ADR 0017, decision 8): this
// folder, the workspace's root files and lockfile, and a README saying
// how. Run after scripts/assemble.ts, with the same CLIPPER_FIREFOX_ID:
//
//   node scripts/source.ts
//
// It writes dist/wikistow-clipper-<version>-source.zip. Only the clipper
// and the root's files go in, not the rest of WikiStow: pnpm installs a
// workspace that has only some of the lockfile's projects, and the build
// reads nothing else. scripts/check-source.ts builds it and compares.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIREFOX_PLACEHOLDER } from './builds.ts';
import { files, writeZip } from './zip.ts';

const clipper = fileURLToPath(new URL('..', import.meta.url));
const workspace = join(clipper, '..', '..');

/** The root's files the install and the build read. */
const ROOT = [
  '.node-version',
  'LICENSE',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
];
/** What the clipper's folder holds that isn't its source. */
const SKIP = ['dist', 'node_modules', 'test-results', 'playwright-report'];

/**
 * The clipper's files: those git tracks, so nothing a person has lying
 * in the folder goes in a public upload, or, where there's no git, as in
 * CI's container and its clean checkout, every file but those in SKIP.
 */
async function clipperFiles() {
  const git = spawnSync('git', ['ls-files', '-z', '--', '.'], { cwd: clipper, encoding: 'utf8' });
  if (git.status === 0 && git.stdout) {
    // Not one deleted here and not yet committed.
    return git.stdout
      .split('\0')
      .filter((path) => path && existsSync(join(clipper, path)))
      .sort();
  }
  return files(clipper, SKIP);
}

/** The commands that build it, from the source's root, which scripts/check-source.ts runs from the README. */
function buildCommands(firefoxId: string) {
  return [
    'pnpm install --frozen-lockfile',
    './node_modules/.bin/vp -C apps/clipper pack',
    `CLIPPER_FIREFOX_ID=${firefoxId} node apps/clipper/scripts/assemble.ts`,
  ];
}

type About = {
  version: string;
  firefoxId: string;
  pnpm: string;
  node: string;
  readability: string;
};

function readme({ version, firefoxId, pnpm, node, readability }: About) {
  return `# WikiStow Web Clipper ${version}, its source

This is the source of the WikiStow Web Clipper ${version}, the add-on \`${firefoxId}\`, from https://github.com/skint007/wikistow (\`apps/clipper\`). It builds the add-on's files unminified, with Vite+ (\`vp pack\`, which bundles with Rolldown) and a script that writes the manifest.

## What it needs

- **Node.js ${node}**, not Node 24: the workspace asks for it (\`engines\`), and the build's scripts are TypeScript, which Node runs as it is. From https://nodejs.org/en/download, or \`nvm install ${node}\`.
- **pnpm ${pnpm}**, not npm: the lockfile is pnpm's (\`pnpm-lock.yaml\`). Install it with \`npm install -g pnpm@${pnpm}\`.
- A network connection for the install. Nothing is fetched during the build itself.

Nothing in the build depends on the system or the processor, so Ubuntu 24.04 on ARM64 builds the same files. WikiStow's CI builds it from this zip on Linux on x64 and compares the files.

## Building it

From this folder:

\`\`\`sh
${buildCommands(firefoxId).join('\n')}
\`\`\`

The add-on's files are then in \`apps/clipper/dist/firefox\`, byte for byte the files of the version uploaded, \`wikistow-clipper-${version}-firefox.zip\`. The build writes that zip too, in \`apps/clipper/dist\`.

## What's where

- \`apps/clipper/src\`: the add-on's TypeScript, its popup and its manifest (\`src/manifest.ts\`).
- \`apps/clipper/vite.config.ts\`: one bundle per script, unminified.
- \`apps/clipper/scripts/assemble.ts\`: lays out each browser's build and writes its \`manifest.json\`.
- \`capture.js\` bundles Mozilla's Readability ${readability} from npm, unchanged (\`THIRD-PARTY-NOTICES.txt\`).
- \`apps/clipper/README.md\` says more, and \`docs/adr/0017-web-clipper.md\` in the repository says why it asks for each permission.
`;
}

const { version, devDependencies } = JSON.parse(
  await readFile(join(clipper, 'package.json'), 'utf8'),
) as { version: string; devDependencies: Record<string, string> };
const firefoxId = process.env['CLIPPER_FIREFOX_ID'] || FIREFOX_PLACEHOLDER;
const root = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')) as {
  packageManager: string;
};
const pnpm = root.packageManager.replace(/^pnpm@/, '');
const node = (await readFile(join(workspace, '.node-version'), 'utf8')).trim();
const paths = [...ROOT, ...(await clipperFiles()).map((path) => `apps/clipper/${path}`)];
const zip = join(clipper, 'dist', `wikistow-clipper-${version}-source.zip`);
await writeZip(zip, workspace, paths, {
  'README.md': new TextEncoder().encode(
    readme({
      version,
      firefoxId,
      pnpm,
      node,
      readability: devDependencies['@mozilla/readability']!,
    }),
  ),
});
process.stdout.write(`Wrote ${zip}, ${paths.length + 1} files\n`);

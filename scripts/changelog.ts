// Checks CHANGELOG.md, and writes a release's GitHub notes from its entry
// (docs/releasing.md#the-changelog).
//
//   node scripts/changelog.ts               checks every entry, and that the newest is this version
//   node scripts/changelog.ts --tags        also checks them against the v* tags
//   node scripts/changelog.ts notes v0.6.0  checks, then prints that release's notes
//
// CI's `check` job runs the first. A checkout there may have no tags, so the
// release's `verify` job runs the second, with the whole history, and
// `github-release` publishes the third.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseChangelog,
  REPOSITORY,
  type Changelog,
  type Release,
} from '../packages/ui/src/whats-new/changelog.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const [command, argument] = process.argv.slice(2);

/** Semantic version precedence: a prerelease comes before its release. */
function compare(a: string, b: string): number {
  const split = (version: string) => {
    const dash = version.indexOf('-');
    const core = dash < 0 ? version : version.slice(0, dash);
    return {
      core: core.split('.').map(Number),
      pre: dash < 0 ? [] : version.slice(dash + 1).split('.'),
    };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const difference = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (difference !== 0) return difference;
  }
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  const numeric = /^\d+$/;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (numeric.test(p) && numeric.test(q)) return Number(p) - Number(q);
    if (numeric.test(p) !== numeric.test(q)) return numeric.test(p) ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const isDay = (date: string) => {
  const time = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(date);
};
// Shown as plain text in the app, which links nothing.
const LINK = /\]\(|(?:^|[\s(])#\d/;

/** What's wrong with the entries, given the version every package.json carries. */
function problems({ releases }: Changelog, version: string): string[] {
  const found: string[] = [];
  if (releases[0]?.version !== version)
    found.push(
      `package.json says ${version}, but the newest entry is ${releases[0]?.version ?? 'missing'}. The version change adds its entry.`,
    );
  for (const [index, release] of releases.entries()) {
    const name = release.version;
    const older = releases[index + 1];
    if (older && compare(name, older.version) <= 0)
      found.push(`${name} comes before ${older.version}: newest first, each version once`);
    if (!isDay(release.date)) found.push(`${name}: ${release.date} isn't a day`);
    if (release.highlights.length === 0) found.push(`${name} has no highlights`);
    if (!release.changes) found.push(`${name} has no changes`);
    for (const { items } of release.highlights)
      for (const item of items.filter((i) => LINK.test(i)))
        found.push(`${name}: links and pull requests go under Changes, not highlights: "${item}"`);
  }
  return found;
}

/**
 * What the tags say against the entries: every tag in this history has one,
 * every entry has a tag, apart from the version being prepared, and each is
 * dated the day, in UTC, its tag was made.
 */
function tagProblems({ releases }: Changelog, version: string): string[] {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const tagged = new Map(
    git('for-each-ref', '--format=%(refname:short) %(creatordate:unix)', 'refs/tags/v*').map(
      (line) => {
        const [tag = '', time = ''] = line.split(' ');
        return [tag.slice(1), new Date(Number(time) * 1000).toISOString().slice(0, 10)];
      },
    ),
  );
  const found: string[] = [];
  for (const tag of git('tag', '--merged', 'HEAD', '--list', 'v*'))
    if (!releases.some((r) => `v${r.version}` === tag))
      found.push(`${tag} is released, but has no entry`);
  for (const { version: name, date } of releases) {
    const day = tagged.get(name);
    if (day === undefined && name !== version)
      found.push(`${name} has an entry, but no tag v${name}`);
    if (day !== undefined && day !== date)
      found.push(`v${name} was tagged on ${day} (UTC), but its entry says ${date}`);
  }
  if (tagged.size === 0)
    found.push('There are no v* tags here: fetch them with `git fetch --tags`');
  return found;
}

/**
 * A release's GitHub notes: its highlights, its technical notes a heading
 * level up, and its changes since the release before. A stable release
 * counts from the stable release before it, so a candidate in between
 * doesn't hide what it brought.
 */
function notes(release: Release, releases: Release[]): string {
  const older = releases.slice(releases.indexOf(release) + 1);
  const previous = release.prerelease ? older[0] : older.find((r) => !r.prerelease);
  let fenced = false;
  const changes = release.changes.split('\n').map((line) => {
    if (line.startsWith('```')) fenced = !fenced;
    return !fenced && /^#{4,} /.test(line) ? line.slice(1) : line;
  });
  return [
    '## Highlights',
    '',
    ...release.highlights.flatMap(({ category, items }) => [
      `### ${category}`,
      '',
      ...items.map((item) => `- ${item}`),
      '',
    ]),
    '## Changes',
    '',
    ...changes,
    '',
    previous
      ? `**Full changes:** ${REPOSITORY}/compare/v${previous.version}...v${release.version}`
      : `**Source:** ${REPOSITORY}/tree/v${release.version}`,
    '',
  ].join('\n');
}

function fail(lines: string[]): never {
  process.stderr.write(
    `CHANGELOG.md (docs/releasing.md#the-changelog):\n${lines.map((l) => `  ${l}\n`).join('')}`,
  );
  process.exit(1);
}

const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
  .then(parseChangelog)
  .catch((error: unknown) => fail([error instanceof Error ? error.message : String(error)]));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  version: string;
};
const found = problems(changelog, version);
if (command === '--tags') found.push(...tagProblems(changelog, version));
if (found.length > 0) fail(found);

if (command === 'notes') {
  const wanted = argument?.replace(/^v/, '');
  const release = changelog.releases.find((r) => r.version === wanted);
  if (!release)
    fail([`There is no entry for ${argument ?? 'a version: name one, as notes v0.6.0'}`]);
  process.stdout.write(notes(release, changelog.releases));
} else if (command !== undefined && command !== '--tags') {
  fail([`Unknown command ${command}: use --tags, or notes <version>`]);
} else {
  process.stdout.write(`${changelog.releases.length} releases, the newest ${version}\n`);
}

// Reads CHANGELOG.md, the one record of what each release changed. The app's
// What's new page shows each release's highlights, and the release workflow
// publishes its GitHub notes from the same entry (scripts/changelog.ts). It
// runs in the app and in Node, so it imports nothing. docs/releasing.md
// describes the format.

/** Where releases, tags and pull requests live. */
export const REPOSITORY = 'https://github.com/skint007/wikistow';

/** The kinds of highlight, in the order the app and the release notes show them. */
export const CATEGORIES = [
  'Upgrade notes',
  'Features',
  'Fixes',
  'Optimizations',
  'UI polish',
  'Maintenance',
] as const;

export type Category = (typeof CATEGORIES)[number];

/** A release's short notes for people, by kind. Kinds with no items aren't listed. */
export type Highlights = { category: Category; items: string[] }[];

export type Release = {
  version: string;
  /** The day it was tagged, as YYYY-MM-DD in UTC. */
  date: string;
  prerelease: boolean;
  highlights: Highlights;
  /** The technical notes: Markdown, published as they are. */
  changes: string;
};

export type Changelog = {
  /** What has merged since the newest release, if the file has the section. */
  unreleased: { highlights: Highlights; changes: string } | null;
  /** Newest first, as the file lists them. */
  releases: Release[];
};

const UNRELEASED = '## Unreleased';
const RELEASE = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) - (\d{4}-\d{2}-\d{2})$/;

type Entry = {
  heading: { version: string; date: string } | null;
  highlights: Highlights;
  changes: string[];
  sections: Set<string>;
};

/**
 * The entries of `text`, in the file's order. Throws, naming the line, when
 * the file doesn't follow the format; whether entries are complete and in
 * order is the release check's to say.
 */
export function parseChangelog(text: string): Changelog {
  const changelog: Changelog = { unreleased: null, releases: [] };
  let entry: Entry | null = null;
  let section: 'highlights' | 'changes' | null = null;
  let kind: Highlights[number] | null = null;
  let fenced = false;

  const finish = () => {
    if (!entry) return;
    const highlights = entry.highlights
      .filter((h) => h.items.length > 0)
      .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
    const changes = entry.changes.join('\n').trim();
    if (entry.heading) {
      const { version, date } = entry.heading;
      changelog.releases.push({
        version,
        date,
        prerelease: version.includes('-'),
        highlights,
        changes,
      });
    } else changelog.unreleased = { highlights, changes };
  };

  for (const [index, line] of text.split('\n').entries()) {
    const problem = (message: string) => new Error(`CHANGELOG.md line ${index + 1}: ${message}`);
    // Code in the technical notes may hold lines that look like headings.
    if (section === 'changes' && line.startsWith('```')) fenced = !fenced;
    if (fenced) {
      entry?.changes.push(line);
      continue;
    }

    if (line.startsWith('## ')) {
      finish();
      const [, version, date] = RELEASE.exec(line) ?? [];
      const heading = version && date ? { version, date } : null;
      if (!heading && line !== UNRELEASED)
        throw problem('A release starts "## <version> - <YYYY-MM-DD>", or "## Unreleased"');
      if (!heading && (changelog.unreleased || changelog.releases.length > 0))
        throw problem('"## Unreleased" comes once, before every release');
      entry = { heading, highlights: [], changes: [], sections: new Set() };
      section = null;
      kind = null;
      continue;
    }
    // The title and introduction, before the first entry.
    if (!entry) continue;

    if (line.startsWith('### ')) {
      const name = line.slice(4).trim();
      if (name !== 'Highlights' && name !== 'Changes')
        throw problem('An entry has only "### Highlights" and "### Changes"');
      if (entry.sections.has(name)) throw problem(`"### ${name}" comes once in an entry`);
      entry.sections.add(name);
      section = name === 'Highlights' ? 'highlights' : 'changes';
      kind = null;
      continue;
    }
    if (section === 'changes') {
      entry.changes.push(line);
      continue;
    }
    if (line.trim() === '') continue;
    if (section === 'highlights' && line.startsWith('#### ')) {
      const name = line.slice(5).trim();
      const category = CATEGORIES.find((c) => c === name);
      if (!category) throw problem(`Highlights go under one of: ${CATEGORIES.join(', ')}`);
      if (entry.highlights.some((h) => h.category === category))
        throw problem(`"#### ${category}" comes once in an entry`);
      kind = { category, items: [] };
      entry.highlights.push(kind);
      continue;
    }
    if (kind && line.startsWith('- ')) {
      kind.items.push(line.slice(2).trim());
      continue;
    }
    throw problem(
      section === 'highlights'
        ? 'Each highlight is one line starting with "- ", under a heading such as "#### Features"'
        : 'Notes go under "### Highlights" or "### Changes"',
    );
  }
  if (fenced) throw new Error('CHANGELOG.md: a code block in the technical notes never ends');
  finish();
  return changelog;
}

import { describe, expect, it } from 'vite-plus/test';
import {
  importFromOf,
  noteLinks,
  pageIndex,
  pagesTitled,
  readJoplinExport,
  readObsidianVault,
  rewriteNote,
  wikilinkTarget,
  type ImportFile,
  type ImportSource,
} from '../src/index.ts';

const file = (path: string, text: string): ImportFile => {
  const bytes = new TextEncoder().encode(text);
  return { path, size: bytes.length, read: async () => bytes };
};

const ROUTER = '68a98a6ae3eb4f158f073f8d0286c139';
const WIFI = '6a11c08830f542c4806d6fb72ade8d91';
const PNG = 'e8660759c1e54c689a16fa4cddcd99b3';
const HOME = '51e099ee205e42818eca852090211548';
const TAG = '18d66bb4b5ea434d99d5dd973e0f0451';

// Items as Joplin 3.7.1 serializes them, trimmed to the properties read.
const props = (lines: Record<string, string>) =>
  Object.entries(lines)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
const JEX = [
  file(
    `${HOME}.md`,
    `Home\n\n${props({ id: HOME, parent_id: '', deleted_time: '0', type_: '2' })}`,
  ),
  file(
    `${ROUTER}.md`,
    `Router setup\n\n![router.png](:/${PNG})\n\n| a | b |\n| - | - |\n| [the wifi](:/${WIFI}#x) | \`[x](:/${WIFI})\` |\n\n${props(
      {
        id: ROUTER,
        parent_id: HOME,
        user_created_time: '2026-10-24T05:23:04.898Z',
        user_updated_time: '2026-10-24T05:23:09.211Z',
        is_todo: '1',
        todo_completed: '0',
        todo_due: '1793534400000',
        markup_language: '1',
        deleted_time: '0',
        type_: '1',
      },
    )}`,
  ),
  file(
    `${WIFI}.md`,
    `Wi-Fi passwords\n\n<img src=":/${PNG}" width="120"/>\n\n${props({
      id: WIFI,
      parent_id: HOME,
      source_url: 'line\\none',
      deleted_time: '0',
      type_: '1',
    })}`,
  ),
  file(`${PNG}.md`, `router.png\n\n${props({ id: PNG, mime: 'image/png', type_: '4' })}`),
  file(`${TAG}.md`, `home\n\n${props({ id: TAG, type_: '5' })}`),
  file('0123456789abcdef0123456789abcdef.md', props({ note_id: ROUTER, tag_id: TAG, type_: '6' })),
  file(`resources/${PNG}.png`, 'png bytes'),
];

/** Each note of `source` rewritten, its pages named by key, attachments by file. */
function rewritten(source: ImportSource) {
  const folders = new Map(source.folders.map((f) => [f.key, f]));
  const above = (key: string | null): string[] => {
    const folder = key === null ? undefined : folders.get(key);
    return folder ? [...above(folder.parent), folder.name] : [];
  };
  const pages = source.notes.map((note) => ({
    id: note.key,
    title: note.title,
    folders: above(note.parent),
  }));
  const index = pageIndex(pages);
  return source.notes.map((note) =>
    rewriteNote(note, noteLinks(note, source), {
      wikilink: (key) => {
        const page = pages.find((p) => p.id === key);
        const target = page && wikilinkTarget(page, pages, index);
        return page && target ? { target, title: page.title } : undefined;
      },
      attachment: (key) => ({ id: `id-of-${source.files.get(key)?.name}`, alone: true }),
      resolves: (target, key) => {
        const found = pagesTitled(target, pages, index);
        return found.length === 1 && (key === null || found[0] === key);
      },
    }),
  );
}

describe('a JEX', () => {
  it('becomes notebooks and notes, with the Markdown export’s front matter and rewritten links', async () => {
    const joplin = await readJoplinExport(JEX);
    expect(joplin.format).toBe('jex');
    expect(joplin.folders).toEqual([{ key: HOME, parent: null, name: 'Home' }]);
    expect(joplin.notes.map((n) => [n.path, n.parent])).toEqual([
      ['Home/Router setup', HOME],
      ['Home/Wi-Fi passwords', HOME],
    ]);
    const [router, wifi] = rewritten(joplin);
    // A link in a table keeps its text behind an escaped bar; code is left alone.
    expect(router?.markdown).toBe(
      [
        '---',
        'title: Router setup',
        'updated: 2026-10-24 05:23:09Z',
        'created: 2026-10-24 05:23:04Z',
        'completed?: no',
        'due: 2026-11-01 12:00:00Z',
        'tags:',
        '  - home',
        '---',
        '',
        '![router.png](attachment:id-of-router.png)',
        '',
        '| a | b |',
        '| - | - |',
        `| [[Wi-Fi passwords\\|the wifi]] | \`[x](:/${WIFI})\` |`,
      ].join('\n'),
    );
    // Escaped line breaks in values come back; HTML attributes name attachments too.
    expect(wifi?.markdown).toBe(
      '---\ntitle: Wi-Fi passwords\nsource: |-\n  line\n  one\n---\n\n<img src="attachment:id-of-router.png" width="120"/>',
    );
  });
});

describe('a Markdown + Front Matter export', () => {
  it('reads titles from front matter, and names a page by its folder where titles repeat', async () => {
    const joplin = await readJoplinExport([
      file('Home/README.md', '---\ntitle: README\n---\n\nHome.'),
      file('Work/README.md', '---\ntitle: README\n---\n\nWork.'),
      file(
        'Work/Plan.md',
        '---\ntitle: "Plan: 2026"\n---\n\nSee [README](../Home/README.md), [](../Work/README.md), [gone](../Gone.md) and [file](../_resources/a%20b.pdf).',
      ),
      file('_resources/a b.pdf', 'pdf'),
    ]);
    expect(joplin.format).toBe('markdown');
    expect(joplin.notes.map((n) => n.title)).toEqual(['README', 'Plan: 2026', 'README']);
    const plan = rewritten(joplin)[1];
    expect(plan).toEqual({
      markdown:
        '---\ntitle: "Plan: 2026"\n---\n\nSee [[Home/README|README]], [[Work/README|README]], [gone](../Gone.md) and [file](attachment:id-of-a b.pdf).',
      unresolved: ['../Gone.md'],
    });
  });
});

// A vault as Obsidian 1.15.0 keeps one, its links resolved there as here:
// two notes named README, files under assets/, a canvas no note names.
const VAULT = [
  file('.obsidian/app.json', '{}'),
  file('.trash/Old.md', 'Deleted.'),
  file(
    'Home.md',
    `---
tags:
  - home
  - start
aliases: [Start page]
rating: 4
---
# Home

A #inline-tag and ==a highlight== and %%a comment%%.

> [!note] Callout title
> Kept as written.

- Path form: [[Recipes/Soup]]
- Bare name: [[Soup]]
- With .md: [[Notes.md]]
- Shared name: [[README]] and [[Archive/README]]
- Heading and text: [[Soup#Method|how to make it]]
- Block reference: [[Soup#^step1]]
- Page embed: ![[Soup]]
- Missing: [[Missing note]] and ![[gone.png]]
- Markdown link: [the soup](Recipes/Soup.md) and [notes](./Notes.md)
- File link: [[doc.pdf]] and [[doc.pdf|the doc]]

![[photo.png]]
![[assets/photo.png]]
![[photo.png|300]]
![[photo.png|300x200]]
![](assets/photo.png)
![](assets/my%20photo.png)
[the pdf](<assets/doc.pdf>)
![[doc.pdf]]

| Note | Picture |
| --- | --- |
| [[Soup\\|soup]] | ![[photo.png\\|100]] |

\`[[Soup]]\` in code stays.
`,
  ),
  file(
    'Recipes/Soup.md',
    `# Soup

## Method

Boil water. ^step1

See [[README]] and ![[my photo.png]].
`,
  ),
  file('Projects/README.md', '# Projects README\n\nBack [[Home]].\n'),
  file('Archive/README.md', '# Archive README\n\nOld [[Home|home page]].\n'),
  file('Notes.md', 'Plain notes. [[Recipes/Soup.md|soup]]\n'),
  file('Board.canvas', '{"nodes":[],"edges":[]}'),
  file('assets/photo.png', 'png'),
  file('assets/my photo.png', 'png'),
  file('assets/doc.pdf', 'pdf'),
  file('unused.png', 'png'),
];

describe('an Obsidian vault', () => {
  it('is told apart from a Joplin export, or not at all', async () => {
    expect(await importFromOf(VAULT)).toBe('obsidian');
    expect(await importFromOf(VAULT.filter((f) => !f.path.startsWith('.obsidian/')))).toBeNull();
    expect(await importFromOf(JEX)).toBe('joplin');
  });

  it('names a colour plugin’s styled text and highlights by the nearest theme colour', async () => {
    const note = [
      '---',
      'note: <span style="color: #ff0000">kept</span>',
      '---',
      'A <span style="color:#e03e2d">red</span>, <span style="color: rgb(46, 125, 50);">green</span> and <span style=\'color: #1e88e5\'>blue</span> word, ==highlighted==.',
      '<mark style="background: #FFF3A3A6;">yellow</mark> <mark style="background-color: #FF5582A6">red</mark> <mark style="background: #ABF7F7A6;">cyan</mark> <span style="color: purple">named</span>',
      '',
      '<span style="color: #888888">grey</span> <span style="color: red; font-weight: bold">two rules</span> <font color="#ff0000">font</font> <span style="background: #ff0000">a span’s background</span>',
      '',
      '`<span style="color: #ff0000">code</span>`',
      '',
    ].join('\n');
    const vault = await readObsidianVault([
      file('.obsidian/app.json', '{}'),
      file('Colours.md', note),
    ]);
    expect(vault.notes[0]?.markdown).toBe(
      note
        .replace('<span style="color:#e03e2d">', '<span data-color="red">')
        .replace('<span style="color: rgb(46, 125, 50);">', '<span data-color="green">')
        .replace("<span style='color: #1e88e5'>", '<span data-color="blue">')
        .replace('<mark style="background: #FFF3A3A6;">', '<mark data-color="yellow">')
        .replace('<mark style="background-color: #FF5582A6">', '<mark data-color="red">')
        .replace('<mark style="background: #ABF7F7A6;">', '<mark data-color="blue">')
        .replace('<span style="color: purple">', '<span data-color="purple">'),
    );
  });

  it('becomes folders and notes titled by name, its links rewritten only where they must be', async () => {
    const vault = await readObsidianVault(VAULT);
    expect(vault.folders.map((f) => f.key)).toEqual(['Archive', 'Projects', 'Recipes']);
    expect(vault.notes.map((n) => [n.path, n.title])).toEqual([
      ['Archive/README.md', 'README'],
      ['Home.md', 'Home'],
      ['Notes.md', 'Notes'],
      ['Projects/README.md', 'README'],
      ['Recipes/Soup.md', 'Soup'],
    ]);
    expect([...vault.files.keys()]).toEqual([
      'Board.canvas',
      'assets/doc.pdf',
      'assets/my photo.png',
      'assets/photo.png',
      'unused.png',
    ]);
    const [, home, notes, , soup] = rewritten(vault);
    // Only what wouldn't name its page or file as written changes; front matter stays.
    const changed = (markdown: string, changes: [string, string][]) =>
      changes.reduce((text, [from, to]) => text.replace(from, to), markdown);
    expect(home).toEqual({
      markdown: changed(vault.notes[1]?.markdown ?? '', [
        ['[[Notes.md]]', '[[Notes]]'],
        ['[[README]]', '[[Archive/README|README]]'],
        ['[the soup](Recipes/Soup.md)', '[[Soup|the soup]]'],
        ['[notes](./Notes.md)', '[[Notes|notes]]'],
        ['[[doc.pdf]]', '[doc.pdf](attachment:id-of-doc.pdf)'],
        ['[[doc.pdf|the doc]]', '[the doc](attachment:id-of-doc.pdf)'],
        ['![[assets/photo.png]]', '![[photo.png]]'],
        ['(assets/photo.png)', '(attachment:id-of-photo.png)'],
        ['(assets/my%20photo.png)', '(attachment:id-of-my photo.png)'],
        ['<assets/doc.pdf>', '<attachment:id-of-doc.pdf>'],
      ]),
      unresolved: ['![[gone.png]]', '[[Missing note]]'],
    });
    expect(notes?.markdown).toBe('Plain notes. [[Soup|soup]]\n');
    expect(soup).toEqual({
      markdown: changed(vault.notes[4]?.markdown ?? '', [
        ['[[README]]', '[[Archive/README|README]]'],
      ]),
      unresolved: [],
    });
  });
});

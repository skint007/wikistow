import { describe, expect, it } from 'vite-plus/test';
import {
  noteLinks,
  pageIndex,
  readJoplinExport,
  rewriteNote,
  wikilinkTarget,
  type ImportFile,
  type JoplinExport,
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

/** Each note of `joplin` rewritten, its pages named by key, attachments by resource. */
function rewritten(joplin: JoplinExport) {
  const names = new Map(joplin.notebooks.map((n) => [n.key, n.name]));
  const pages = joplin.notes.map((note) => ({
    id: note.key,
    title: note.title,
    folders: note.parent === null ? [] : [names.get(note.parent) ?? ''],
  }));
  const index = pageIndex(pages);
  return joplin.notes.map((note) =>
    rewriteNote(note, noteLinks(note, joplin.target), {
      wikilink: (key) => {
        const page = pages.find((p) => p.id === key);
        const target = page && wikilinkTarget(page, pages, index);
        return page && target ? { target, title: page.title } : undefined;
      },
      attachment: (key) => `id-of-${joplin.resources.get(key)?.name}`,
    }),
  );
}

describe('a JEX', () => {
  it('becomes notebooks and notes, with the Markdown export’s front matter and rewritten links', async () => {
    const joplin = await readJoplinExport(JEX);
    expect(joplin.format).toBe('jex');
    expect(joplin.notebooks).toEqual([{ key: HOME, parent: null, name: 'Home' }]);
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

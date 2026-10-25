// A page index derived change by change (`PageIndex.with`) against one
// built afresh from the same pages: they must hold, list and find the same.
import { describe, expect, it } from 'vite-plus/test';
import {
  FolderId,
  indexedContent,
  PageId,
  RevisionId,
  searchOperations,
  SpaceId,
  type IndexedText,
} from '../src/index.ts';
import { cpuTime } from './support/timing.ts';

const { PageIndex } = searchOperations;
type PageIndex = InstanceType<typeof PageIndex>;
type SearchPage = searchOperations.SearchPage;

/** mulberry32: the same seed, the same changes. */
function random(seed: number) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  return { next, int, pick };
}
type Random = ReturnType<typeof random>;

// Few words and titles, so pages share terms, prefixes and titles, and hits tie.
const WORDS = ['soup', 'sour', 'bean', 'bread', 'pie', 'apple', 'apricot', 'cook', 'time', 'café'];
const TITLES = ['Soup', 'Bean soup', 'Bread', 'Notes', 'Apple pie', 'Notes'];
const TAGS = ['soup', 'Soup', '#bread', 'pie'];
const QUERIES = [
  'so',
  'soup',
  'bean so',
  'ap',
  'cafe',
  'notes',
  'b',
  'tag:soup',
  'servings:2',
  'tag:bread bre',
  'cook time',
];

const SPACES = ['home', 'work', 'shared'].map((id) => SpaceId.parse(id));
const FOLDERS = ['recipes', 'soups', 'notes'].map((id) => FolderId.parse(id));

/** A page as the world holds it: where it is, and its version. */
type Page = { doc: SearchPage; content: IndexedText };

/** The pages this person can open, as `indexSpaces` would read them now. */
type World = Map<string, Page>;

const keyOf = (doc: SearchPage) => `${doc.spaceId}/${doc.pageId}`;
let revisions = 0;

function content(r: Random): IndexedText {
  const words = Array.from({ length: 1 + r.int(12) }, () => r.pick(WORDS)).join(' ');
  const tags = Array.from({ length: r.int(3) }, () => r.pick(TAGS));
  const block = [
    tags.length > 0 ? `tags: [${tags.join(', ')}]` : '',
    r.int(2) ? `servings: ${1 + r.int(3)}` : '',
    r.int(3) ? '' : 'Cook time: 30',
  ].filter(Boolean);
  const markdown = block.length > 0 ? `---\n${block.join('\n')}\n---\n${words}` : words;
  return { title: r.pick(TITLES), ...indexedContent(markdown) };
}

function placed(r: Random, spaceId: SpaceId, pageId: PageId): SearchPage {
  const depth = r.int(3);
  const folderIds = FOLDERS.slice(0, depth);
  return {
    spaceId,
    pageId,
    revisionId: RevisionId.parse(`r${++revisions}`),
    parentId: folderIds.at(-1) ?? null,
    folderIds,
    path: [spaceId, ...folderIds],
    draft: r.int(2) === 0,
    unpublished: false,
  };
}

function newPage(r: Random, world: World): Page {
  const doc = placed(r, r.pick(SPACES), PageId.parse(`p${world.size}-${revisions}`));
  return { doc, content: content(r) };
}

function fresh(world: World): PageIndex {
  const index = new PageIndex();
  for (const { doc, content } of world.values()) index.addText(doc, content);
  return index;
}

/** Everything a reader of an index can see of it. */
function seen(index: PageIndex) {
  const scopes = SPACES.flatMap((spaceId) => [
    { spaceId },
    { spaceId, folderId: null },
    ...FOLDERS.flatMap((folderId) => [
      { spaceId, folderId },
      { spaceId, folderId, nested: true },
    ]),
    ...TAGS.map((tag) => ({ spaceId, tag })),
  ]);
  return {
    size: index.size,
    pages: index
      .pages()
      .map(({ doc, title, text, properties }) => ({ doc, title, text, properties }))
      .sort((a, b) => (keyOf(a.doc) < keyOf(b.doc) ? -1 : 1)),
    lists: scopes.map((scope) => index.list(scope)),
    keys: scopes.map((scope) => index.keys(scope)),
    found: QUERIES.map((query) =>
      index.search(query, { limit: 7 }).map(({ doc, score, title, snippet }) => ({
        doc,
        score,
        title,
        snippet: snippet(),
      })),
    ),
    pageOf: index
      .pages()
      .map(({ doc }) => doc)
      .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1))
      .map((doc) => index.page(doc.spaceId, doc.pageId)),
  };
}

/**
 * One random change to `world`, and how the index follows it: the pages
 * given, and the spaces listed again, as `updateIndex` gives them.
 */
function change(r: Random, world: World, index: PageIndex) {
  const pages = [...world.values()];
  const any = pages.length > 0 ? r.pick(pages) : null;
  const relist = (spaceId: SpaceId) => ({
    pages: [...world.values()]
      .filter(({ doc }) => doc.spaceId === spaceId)
      // A version the index holds needs no content.
      .map(({ doc, content }) =>
        index.page(doc.spaceId, doc.pageId)?.revisionId === doc.revisionId
          ? ([doc] as const)
          : ([doc, content] as const),
      ),
    spaces: [spaceId],
  });
  switch (r.int(9)) {
    case 0:
    case 1: {
      // This person's own save: a new version of one page, given alone.
      if (!any) break;
      const saved = { ...any.doc, revisionId: RevisionId.parse(`r${++revisions}`), draft: true };
      const written = content(r);
      world.set(keyOf(saved), { doc: saved, content: written });
      return { pages: [[saved, written] as const], spaces: [] };
    }
    case 2: {
      // Someone else's edit, heard of for its space.
      if (!any) break;
      const saved = { ...any.doc, revisionId: RevisionId.parse(`r${++revisions}`) };
      world.set(keyOf(saved), { doc: saved, content: content(r) });
      return relist(saved.spaceId);
    }
    case 3: {
      // A page moved, or published: the same version, elsewhere or labelled anew.
      if (!any) break;
      const moved = {
        ...placed(r, any.doc.spaceId, any.doc.pageId),
        revisionId: any.doc.revisionId,
      };
      world.set(keyOf(moved), { doc: moved, content: any.content });
      return relist(moved.spaceId);
    }
    case 4: {
      // Deleted, unpublished, moved out of a share, or access to it lost.
      if (!any) break;
      world.delete(keyOf(any.doc));
      return relist(any.doc.spaceId);
    }
    case 5: {
      const added = newPage(r, world);
      world.set(keyOf(added.doc), added);
      return relist(added.doc.spaceId);
    }
    case 6: {
      // A space deleted, or this person's access to it lost.
      const spaceId = r.pick(SPACES);
      for (const [key, { doc }] of world) if (doc.spaceId === spaceId) world.delete(key);
      return relist(spaceId);
    }
    case 7: {
      // A folder renamed: every page under it is somewhere new by name.
      const folder = r.pick(FOLDERS);
      const name = `${folder}-${++revisions}`;
      for (const [key, page] of world) {
        const at = page.doc.folderIds.indexOf(folder);
        if (at < 0) continue;
        const path = [...page.doc.path];
        path[at + 1] = name;
        world.set(key, { ...page, doc: { ...page.doc, path } });
      }
      return { ...relist(SPACES[0] as SpaceId), all: true };
    }
    default:
      // Nothing changed, but a space is listed again: the echo of a save.
      return relist(r.pick(SPACES));
  }
  return relist(r.pick(SPACES));
}

describe('a page index derived change by change', () => {
  it('holds, lists and finds what one built afresh does, whatever the changes', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = random(seed);
      const world: World = new Map();
      for (let i = 0; i < 20 + r.int(30); i++) {
        const page = newPage(r, world);
        world.set(keyOf(page.doc), page);
      }
      let index = fresh(world);
      for (let step = 0; step < 300; step++) {
        const before = index;
        const was = seen(before);
        const { pages, spaces, all } = { all: false, ...change(r, world, index) };
        if (all) {
          index = index.with(
            [...world.values()].map(({ doc, content }) => [doc, content] as const),
            { spaces: 'all' },
          );
        } else {
          index = index.with(pages, { spaces });
        }
        const context = `seed ${seed}, step ${step}`;
        expect(seen(index), context).toEqual(seen(fresh(world)));
        // The index derived from is as it was.
        expect(seen(before), context).toEqual(was);
      }
    }
  });

  it('is the same index when nothing changed, and keeps what didn’t change as it was', () => {
    const r = random(7);
    const world: World = new Map();
    for (let i = 0; i < 10; i++) {
      const page = newPage(r, world);
      world.set(keyOf(page.doc), page);
    }
    const index = fresh(world);
    const all = [...world.values()].map(({ doc }) => [doc] as const);
    expect(index.with(all, { spaces: 'all' })).toBe(index);
    expect(index.with([])).toBe(index);
    const [first, second] = [...world.values()];
    if (!first || !second) throw new Error('No pages');
    const kept = index.page(second.doc.spaceId, second.doc.pageId);
    const saved = { ...first.doc, revisionId: RevisionId.parse('saved') };
    const next = index.with([[saved, { title: 'Saved', text: 'new words' }]]);
    expect(next).not.toBe(index);
    expect(next.page(second.doc.spaceId, second.doc.pageId)).toBe(kept);
    expect(next.page(saved.spaceId, saved.pageId)?.title).toBe('Saved');
    expect(index.page(saved.spaceId, saved.pageId)?.revisionId).toBe(first.doc.revisionId);
  });

  it('needs the content of a version it doesn’t hold, and can’t be added to once derived', () => {
    const r = random(3);
    const world: World = new Map();
    const page = newPage(r, world);
    world.set(keyOf(page.doc), page);
    const index = fresh(world);
    const other = { ...page.doc, revisionId: RevisionId.parse('other') };
    expect(() => index.with([[other]])).toThrow(/content is needed/);
    // A page moved keeps the content it had.
    const moved = { ...page.doc, parentId: null, folderIds: [], path: [] };
    expect(index.with([[moved]]).page(moved.spaceId, moved.pageId)?.title).toBe(page.content.title);
    expect(() => index.addText(other, { title: 'x', text: 'x' })).toThrow(/doesn’t change/);
  });

  it('drops a page whose access was lost, a space too, from every read', () => {
    const r = random(11);
    const world: World = new Map();
    for (let i = 0; i < 30; i++) {
      const page = newPage(r, world);
      world.set(keyOf(page.doc), page);
    }
    const secret = {
      doc: placed(r, SPACES[0] as SpaceId, PageId.parse('secret')),
      content: { title: 'Secret plan', text: 'unreadablezebra soup', properties: [] },
    };
    world.set(keyOf(secret.doc), secret);
    let index = fresh(world);
    // A few saves of its own first, so the page lost sits beside pages
    // added since the index compacted.
    for (const page of [...world.values()].slice(0, 5)) {
      const saved = { ...page.doc, revisionId: RevisionId.parse(`${page.doc.revisionId}-s`) };
      world.set(keyOf(saved), { doc: saved, content: page.content });
      index = index.with([[saved, page.content]]);
    }
    expect(index.search('unreadablezebra')).toHaveLength(1);
    world.delete(keyOf(secret.doc));
    const relisted = (spaceId: SpaceId) =>
      [...world.values()]
        .filter(({ doc }) => doc.spaceId === spaceId)
        .map(({ doc, content }) => [doc, content] as const);
    index = index.with(relisted(secret.doc.spaceId), { spaces: [secret.doc.spaceId] });
    expect(index.search('unreadablezebra')).toEqual([]);
    expect(index.search('secret')).toEqual([]);
    expect(index.page(secret.doc.spaceId, secret.doc.pageId)).toBeUndefined();
    expect(index.pages().some(({ doc }) => doc.pageId === 'secret')).toBe(false);
    expect(index.list({ spaceId: secret.doc.spaceId }).map(({ pageId }) => pageId)).not.toContain(
      'secret',
    );
    // The whole space, as when it is deleted or shared no more.
    const gone = SPACES[1] as SpaceId;
    index = index.with([], { spaces: [gone] });
    expect(index.list({ spaceId: gone })).toEqual([]);
    expect(index.pages().some(({ doc }) => doc.spaceId === gone)).toBe(false);
    for (const [key, { doc }] of world) if (doc.spaceId === gone) world.delete(key);
    expect(seen(index)).toEqual(seen(fresh(world)));
  });

  it('says when an index holds less than before, and not when a version only moves on', () => {
    const r = random(13);
    const world: World = new Map();
    const page = newPage(r, world);
    world.set(keyOf(page.doc), page);
    const draft = { ...page.doc, draft: true };
    const index = fresh(new Map([[keyOf(draft), { doc: draft, content: page.content }]]));
    const more = newPage(r, world);
    const { narrowed } = searchOperations;
    expect(narrowed(index, index.with([[more.doc, more.content]]))).toBe(false);
    // A save: the draft moves on.
    const saved = { ...draft, revisionId: RevisionId.parse('saved') };
    expect(narrowed(index, index.with([[saved, page.content]]))).toBe(false);
    // Made a reader: the publication stands in for the draft.
    const read = { ...draft, revisionId: RevisionId.parse('published'), draft: false };
    expect(narrowed(index, index.with([[read, page.content]]))).toBe(true);
    // Gone.
    expect(narrowed(index, index.with([], { spaces: [draft.spaceId] }))).toBe(true);
  });

  it('takes time for what changed, not for every page held', () => {
    const r = random(5);
    const world: World = new Map();
    const words = Array.from({ length: 3000 }, (_, i) => `word${i}`);
    for (let i = 0; i < 4000; i++) {
      const doc = placed(r, r.pick(SPACES), PageId.parse(`p${i}`));
      const text = Array.from({ length: 150 }, () => r.pick(words)).join(' ');
      world.set(keyOf(doc), { doc, content: { title: `Page ${i}`, text } });
    }
    const built = cpuTime(() => fresh(world));
    let index = built.value;
    index.list({ spaceId: SPACES[0] as SpaceId });
    index.search('word1');
    // Two hundred saves of a page, as autosaves make them, one at a time.
    const pages = [...world.values()];
    const saves = cpuTime(() => {
      for (let i = 0; i < 200; i++) {
        const { doc, content } = r.pick(pages);
        const saved = { ...doc, revisionId: RevisionId.parse(`s${i}`) };
        index = index.with([[saved, { ...content, text: `${content.text} word${i}` }]]);
        index.list({ spaceId: saved.spaceId });
      }
      return index;
    });
    expect(saves.value.size).toBe(4000);
    // A full rebuild per save would take 200 times as long as one.
    expect(saves.ms).toBeLessThan(built.ms * 10);
    // A space listed again with nothing changed is next to nothing.
    const echo = [...world.values()]
      .filter(({ doc }) => doc.spaceId === SPACES[2])
      .map(({ doc }) => [doc] as const);
    const fresher = fresh(world);
    fresher.list({ spaceId: SPACES[0] as SpaceId });
    const unchanged = cpuTime(() => fresher.with(echo, { spaces: [SPACES[2] as SpaceId] }));
    expect(unchanged.value).toBe(fresher);
    expect(unchanged.ms).toBeLessThan(built.ms / 20);
  });
});

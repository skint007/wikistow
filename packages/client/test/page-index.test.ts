import { describe, expect, it } from 'vite-plus/test';
import { sealOnDevice } from '../src/device-seal.ts';
import { canonical, utf8 } from '../src/encoding.ts';
import {
  FolderId,
  generateIdentity,
  IdentityId,
  InstallationId,
  PageId,
  RevisionId,
  searchOperations,
  SpaceId,
  type ClientContext,
} from '../src/index.ts';

const { PageIndex, keptPages, openKept, sealKept } = searchOperations;

const home = SpaceId.parse('home');
const work = SpaceId.parse('work');
const recipes = FolderId.parse('recipes');
const soups = FolderId.parse('soups');

/** A page in `spaceId`, in the folders `folderIds`, outermost first. */
function page(
  spaceId: SpaceId,
  id: string,
  folderIds: FolderId[],
  markdown: string,
): [searchOperations.SearchPage, { title: string; markdown: string }] {
  return [
    {
      spaceId,
      pageId: PageId.parse(id),
      revisionId: RevisionId.parse(`${id}-r1`),
      parentId: folderIds.at(-1) ?? null,
      folderIds,
      path: folderIds,
      draft: false,
      unpublished: false,
    },
    { title: id, markdown },
  ];
}

function indexOf(...pages: ReturnType<typeof page>[]) {
  const index = new PageIndex();
  for (const [doc, content] of pages) index.add(doc, content);
  return index;
}

const ids = (entries: readonly { pageId: string }[]) => entries.map(({ pageId }) => pageId);

describe('a page index', () => {
  const index = indexOf(
    page(home, 'readme', [], 'No properties.'),
    page(home, 'bean-soup', [recipes, soups], '---\ntags: [soup]\ncook_time: 40\n---\n'),
    page(home, 'bread', [recipes], '---\nCook time: 30\nservings: 2\ntags: bread\n---\n'),
    page(home, 'pie', [recipes], '---\nservings: 6\ntags: [Soup]\n---\n'),
    page(work, 'notes', [], '---\ntags: soup\n---\n'),
  );

  it('finds a page it holds, with its title and properties', () => {
    expect(index.page(home, PageId.parse('bread'))).toMatchObject({
      spaceId: home,
      pageId: 'bread',
      revisionId: 'bread-r1',
      parentId: recipes,
      title: 'bread',
      properties: [
        { key: 'Cook time', type: 'number', value: 30 },
        { key: 'servings', type: 'number', value: 2 },
        { key: 'tags', type: 'text', value: 'bread' },
      ],
    });
    expect(index.page(work, PageId.parse('bread'))).toBeUndefined();
    expect(index.page(home, PageId.parse('gone'))).toBeUndefined();
  });

  it('lists a space’s pages, those directly in a folder or under it, and those with a tag', () => {
    // By title, whatever order the tree lists them in.
    expect(ids(index.list({ spaceId: home }))).toEqual(['bean-soup', 'bread', 'pie', 'readme']);
    expect(ids(index.list({ spaceId: home, folderId: null }))).toEqual(['readme']);
    expect(ids(index.list({ spaceId: home, folderId: recipes }))).toEqual(['bread', 'pie']);
    expect(ids(index.list({ spaceId: home, folderId: recipes, nested: true }))).toEqual([
      'bean-soup',
      'bread',
      'pie',
    ]);
    expect(ids(index.list({ spaceId: home, folderId: null, nested: true }))).toHaveLength(4);
    expect(ids(index.list({ spaceId: home, tag: 'soup' }))).toEqual(['bean-soup', 'pie']);
    expect(ids(index.list({ spaceId: home, folderId: recipes, tag: 'soup' }))).toEqual(['pie']);
    expect(ids(index.list({ spaceId: work, tag: 'soup' }))).toEqual(['notes']);
    expect(index.list({ spaceId: SpaceId.parse('other') })).toEqual([]);
  });

  it('gives the keys pages use, each once as first written, in the order they appear', () => {
    expect(index.keys({ spaceId: home, folderId: recipes })).toEqual([
      'Cook time',
      'servings',
      'tags',
    ]);
    // `cook_time` and `Cook time` are one key, as a reference reads them.
    expect(index.keys({ spaceId: home, folderId: recipes, nested: true })).toEqual([
      'tags',
      'cook_time',
      'servings',
    ]);
    expect(index.keys({ spaceId: home, folderId: null })).toEqual([]);
  });

  it('lists pages with the same title by ID', () => {
    const same = new PageIndex();
    for (const id of ['c', 'a', 'b']) {
      const [doc] = page(home, id, [], '');
      same.add(doc, { title: 'Notes', markdown: '' });
    }
    expect(ids(same.list({ spaceId: home }))).toEqual(['a', 'b', 'c']);
  });

  it('lists pages added after it was read', () => {
    const growing = indexOf(page(home, 'one', [], '---\na: 1\n---\n'));
    expect(ids(growing.list({ spaceId: home }))).toEqual(['one']);
    growing.add(...page(home, 'two', [], '---\nb: 2\n---\n'));
    expect(ids(growing.list({ spaceId: home }))).toEqual(['one', 'two']);
    expect(growing.page(home, PageId.parse('two'))?.title).toBe('two');
    expect(growing.keys({ spaceId: home })).toEqual(['a', 'b']);
  });
});

describe('the pages linking to a page', () => {
  /** A page whose links are given as the index keeps them, titled `title`. */
  const linking = (
    id: string,
    links: { key: string; pageId: string | null }[],
    { title = id, folderIds = [] }: { title?: string; folderIds?: FolderId[] } = {},
  ) => {
    const [doc] = page(home, id, folderIds, '');
    return [doc, { title, text: '', links }] as const;
  };
  const index = new PageIndex();
  for (const [doc, content] of [
    // A link to itself isn't listed.
    linking('router', [{ key: 'router', pageId: null }]),
    linking('by-title', [{ key: 'router', pageId: null }]),
    // Its table entry follows a rename.
    linking('renamed', [{ key: 'old router', pageId: 'router' }]),
    linking('twin-1', [], { title: 'Twin', folderIds: [recipes] }),
    linking('twin-2', [], { title: 'Twin', folderIds: [soups] }),
    // Ambiguous: only an entry counts.
    linking('unpicked', [{ key: 'twin', pageId: null }]),
    linking('picked', [{ key: 'twin', pageId: 'twin-2' }]),
    linking('in-folder', [{ key: 'soups/twin', pageId: null }]),
    // Missing, and an entry for a page this index doesn't hold.
    linking('nowhere', [
      { key: 'later', pageId: null },
      { key: 'router', pageId: 'hidden' },
    ]),
    linking('elsewhere', []),
  ])
    index.addText(doc, content);
  const linksTo = (from: searchOperations.PageIndex, id: string) =>
    ids(from.linksTo(home, PageId.parse(id)));

  it('resolves each link as the reader does', () => {
    expect(linksTo(index, 'router')).toEqual(['by-title', 'nowhere', 'renamed']);
    expect(linksTo(index, 'twin-2')).toEqual(['in-folder', 'picked']);
    expect(linksTo(index, 'twin-1')).toEqual([]);
    expect(index.linksTo(work, PageId.parse('router'))).toEqual([]);
  });

  it('follows the pages it holds as it changes', () => {
    // Read first, so the new index is read from this one's lists.
    expect(linksTo(index, 'router')).toHaveLength(3);
    const [laterDoc, later] = linking('later-page', [], { title: 'Later' });
    const [byTitle] = linking('by-title', []);
    const next = index.with([
      [laterDoc, later],
      [
        { ...byTitle, revisionId: RevisionId.parse('by-title-r2') },
        { title: 'by-title', text: '' },
      ],
    ]);
    expect(linksTo(next, 'later-page')).toEqual(['nowhere']);
    expect(linksTo(next, 'router')).toEqual(['nowhere', 'renamed']);
    // The index it came from is as it was.
    expect(linksTo(index, 'router')).toEqual(['by-title', 'nowhere', 'renamed']);
  });
});

describe('a kept index', () => {
  const installationId = InstallationId.parse('test-installation');
  const identity = generateIdentity({ id: IdentityId.parse('alice'), kind: 'human' });
  const ctx = { installationId, identity } as unknown as ClientContext;
  const kept = keptPages(
    indexOf(page(home, 'bean-soup', [recipes], '---\ntags: [soup, [hot]]\nservings: 4\n---\nB')),
  );

  it('keeps each page’s headings', () => {
    const [entry] = keptPages(
      indexOf(page(home, 'soup', [], 'Intro\n\n# Method\n\nBoil.')),
    ).values();
    expect(entry?.headings).toEqual([6]);
    const sealed = sealKept(ctx, keptPages(indexOf(page(home, 'soup', [], '# A\n\nb'))), '1.0.0');
    expect([...(openKept(ctx, sealed, '1.0.0')?.values() ?? [])][0]?.headings).toEqual([0]);
    // And as an index derived from another takes a page, or keeps one.
    const [doc] = page(home, 'stew', [], '');
    const next = indexOf(page(home, 'soup', [], '# A\n\nb')).with([
      [doc, { title: 'Stew', text: 'Intro\nMethod', headings: [6] }],
    ]);
    expect(next.pages().map(({ headings }) => headings)).toEqual([[0], [6]]);
  });

  it('keeps each page’s properties, for its person and build', () => {
    expect([...kept.values()][0]?.properties).toEqual([
      { key: 'tags', type: 'list', value: ['soup', ['hot']] },
      { key: 'servings', type: 'number', value: 4 },
    ]);
    const sealed = sealKept(ctx, kept, '1.0.0');
    expect(openKept(ctx, sealed, '1.0.0')).toEqual(kept);
    expect(openKept(ctx, sealed, '1.0.1')).toBeNull();
  });

  it('keeps when each version was saved, or that it isn’t known', () => {
    const [doc, content] = page(home, 'bread', [], 'B');
    const index = new PageIndex();
    index.addText(doc, { title: content.title, text: 'B', updated: '2026-11-13T09:30:00.000Z' });
    index.addText(
      { ...doc, pageId: PageId.parse('pie'), revisionId: RevisionId.parse('pie-r1') },
      {
        title: 'pie',
        text: 'P',
      },
    );
    const times = keptPages(index);
    expect([...times.values()].map(({ updated }) => updated)).toEqual([
      '2026-11-13T09:30:00.000Z',
      null,
    ]);
    expect(openKept(ctx, sealKept(ctx, times, '1.0.0'), '1.0.0')).toEqual(times);
  });

  it('opens as nothing when kept before headings, properties, links or times were, even by the same build', () => {
    // As `sealKept` seals, with the rows an earlier build wrote.
    const seal = (rows: unknown[][]) =>
      sealOnDevice(
        identity,
        'search-index-key/v1',
        canonical('search-index/v1', [installationId, identity.public.id, '1.0.0']),
        utf8(JSON.stringify(rows)),
      );
    const row = ['bean-soup-r1', home, 'bean-soup', 'Bean soup', 'text'];
    expect(openKept(ctx, seal([[...row, [0], [], [], null]]), '1.0.0')?.size).toBe(1);
    expect(openKept(ctx, seal([[...row, [0], [], []]]), '1.0.0')).toBeNull();
    expect(openKept(ctx, seal([[...row, [], []]]), '1.0.0')).toBeNull();
    expect(openKept(ctx, seal([[...row, []]]), '1.0.0')).toBeNull();
    expect(openKept(ctx, seal([row]), '1.0.0')).toBeNull();
    expect(openKept(ctx, seal([[...row, [-1], [], [], null]]), '1.0.0')).toBeNull();
    expect(
      openKept(ctx, seal([[...row, [], [{ key: 'a', type: 'map', value: 1 }], [], null]]), '1.0.0'),
    ).toBeNull();
  });
});

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

describe('a kept index', () => {
  const installationId = InstallationId.parse('test-installation');
  const identity = generateIdentity({ id: IdentityId.parse('alice'), kind: 'human' });
  const ctx = { installationId, identity } as unknown as ClientContext;
  const kept = keptPages(
    indexOf(page(home, 'bean-soup', [recipes], '---\ntags: [soup, [hot]]\nservings: 4\n---\nB')),
  );

  it('keeps each page’s properties, for its person and build', () => {
    expect([...kept.values()][0]?.properties).toEqual([
      { key: 'tags', type: 'list', value: ['soup', ['hot']] },
      { key: 'servings', type: 'number', value: 4 },
    ]);
    const sealed = sealKept(ctx, kept, '1.0.0');
    expect(openKept(ctx, sealed, '1.0.0')).toEqual(kept);
    expect(openKept(ctx, sealed, '1.0.1')).toBeNull();
  });

  it('opens as nothing when kept before properties were, even by the same build', () => {
    // As `sealKept` seals, with the rows an earlier build wrote.
    const seal = (rows: unknown[][]) =>
      sealOnDevice(
        identity,
        'search-index-key/v1',
        canonical('search-index/v1', [installationId, identity.public.id, '1.0.0']),
        utf8(JSON.stringify(rows)),
      );
    const row = ['bean-soup-r1', home, 'bean-soup', 'Bean soup', 'text'];
    expect(openKept(ctx, seal([[...row, []]]), '1.0.0')?.size).toBe(1);
    expect(openKept(ctx, seal([row]), '1.0.0')).toBeNull();
    expect(
      openKept(ctx, seal([[...row, [{ key: 'a', type: 'map', value: 1 }]]]), '1.0.0'),
    ).toBeNull();
  });
});

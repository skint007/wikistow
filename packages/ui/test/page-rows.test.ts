import {
  FolderId,
  PageId,
  RevisionId,
  searchOperations,
  SpaceId,
  type PropertyData,
} from '@wikistow/client';
import { PluginError } from '@wikistow/plugin-sdk';
import { describe, expect, it } from 'vite-plus/test';
import {
  indexChanges,
  pageRows,
  queryRows,
  readableSpace,
  readPluginQuery,
} from '../src/plugins/page-rows.ts';

// What `host.pages.index` and `host.pages.query` give a plugin (#401),
// from the person's search index and the app's tree.

const spaceId = SpaceId.parse('s-home');
const recipes = FolderId.parse('f-recipes');
const soups = FolderId.parse('f-soups');
const diary = FolderId.parse('f-diary');

type Page = [id: string, title: string, properties: PropertyData[], folderIds: FolderId[]];

const docOf = ([id, , , folderIds]: Page, revision = 1): searchOperations.SearchPage => ({
  spaceId,
  pageId: PageId.parse(id),
  revisionId: RevisionId.parse(`r-${id}-${revision}`),
  parentId: folderIds.at(-1) ?? null,
  folderIds,
  path: folderIds.map((folder) => folder.slice(2)),
  draft: false,
  unpublished: false,
});

function indexOf(pages: Page[]) {
  const index = new searchOperations.PageIndex();
  for (const page of pages)
    index.addText(docOf(page), { title: page[1], text: '', properties: page[2] });
  return index;
}

const PAGES: Page[] = [
  [
    'p-bread',
    'Garlic bread',
    [
      { key: 'Tags', type: 'list', value: ['#Bread', 'quick', 'bread', 2] },
      { key: 'servings', type: 'number', value: 4 },
      { key: 'tried', type: 'boolean', value: true },
    ],
    [recipes],
  ],
  [
    'p-soup',
    'Tomato soup',
    [
      { key: 'tag', type: 'text', value: 'soup' },
      { key: 'tags', type: 'list', value: ['tomato'] },
      { key: 'servings', type: 'number', value: 6 },
      { key: 'tried', type: 'boolean', value: true },
    ],
    [recipes, soups],
  ],
  ['p-tart', 'Lemon tart', [{ key: 'tried', type: 'boolean', value: false }], [recipes]],
  ['p-secret', 'Secret', [{ key: 'tried', type: 'boolean', value: true }], [diary]],
  ['p-gone', 'Gone', [], [recipes]],
];

const TREE = {
  folders: [
    { id: recipes, parentId: null, name: 'Recipes' },
    { id: soups, parentId: recipes, name: 'Soups' },
    { id: diary, parentId: null, name: 'Diary' },
  ],
  // `p-gone` is in the index, but no longer in the tree.
  pages: PAGES.filter(([id]) => id !== 'p-gone').map(([id, , , folderIds]) => ({
    id,
    parentId: folderIds.at(-1) ?? null,
  })),
};

const INDEX = indexOf(PAGES);

/** What a plugin given `granted` (folder IDs) can read: those folders, and what is under them. */
const grantedTo = (granted: string[]) => {
  const parents = new Map<string, string | null>([
    ...TREE.folders.map(({ id, parentId }) => [id, parentId] as const),
    ...PAGES.map((page) => [page[0], page[3].at(-1) ?? null] as const),
  ]);
  return (nodeId: string) => {
    for (let id: string | null = nodeId; id !== null; id = parents.get(id) ?? null)
      if (granted.includes(id)) return true;
    return false;
  };
};

const recipesOnly = readableSpace(INDEX.list({ spaceId }), TREE, grantedTo([recipes]));
const soupsOnly = readableSpace(INDEX.list({ spaceId }), TREE, grantedTo([soups]));

describe('a space’s rows', () => {
  it('lists the pages the plugin can read in the tree, by title, each with its properties', () => {
    const rows = pageRows(recipesOnly);
    expect(rows.map(({ title }) => title)).toEqual(['Garlic bread', 'Lemon tart', 'Tomato soup']);
    expect(rows[0]).toEqual({
      page: { spaceId, pageId: 'p-bread' },
      title: 'Garlic bread',
      folderId: recipes,
      path: ['Recipes'],
      tags: ['Bread', 'quick', '2'],
      properties: { Tags: ['#Bread', 'quick', 'bread', 2], servings: 4, tried: true },
      revision: 'r-p-bread-1',
      draft: false,
    });
    // Obsidian's older `tag` too, as `from: #tag` finds it.
    expect(rows[2]?.tags).toEqual(['tomato', 'soup']);
    expect(rows[2]?.path).toEqual(['Recipes', 'Soups']);
  });

  it('names no folder the plugin can’t read', () => {
    const [soup] = pageRows(soupsOnly);
    expect(soup).toMatchObject({ title: 'Tomato soup', folderId: soups, path: ['Soups'] });
    expect(pageRows(soupsOnly)).toHaveLength(1);
  });

  it('leaves out a copy unpublished where it is, and puts each page where the tree has it', () => {
    const index = indexOf([PAGES[0] as Page]);
    const copy = docOf(['p-copy', 'Copy', [], [recipes]]);
    index.addText({ ...copy, unpublished: true }, { title: 'Copy', text: '' });
    const space = readableSpace(
      index.list({ spaceId }),
      {
        folders: TREE.folders,
        // The tree has the bread in Soups now, before the index does.
        pages: [
          { id: 'p-bread', parentId: soups },
          { id: 'p-copy', parentId: recipes },
        ],
      },
      grantedTo([recipes]),
    );
    expect(pageRows(space)).toMatchObject([
      { title: 'Garlic bread', folderId: soups, path: ['Recipes', 'Soups'] },
    ]);
  });

  it('gives a property’s list as a copy', () => {
    const tags = pageRows(recipesOnly)[0]?.properties['Tags'];
    if (!Array.isArray(tags)) throw new Error('No tags');
    (tags as unknown[]).push('changed');
    expect(pageRows(recipesOnly)[0]?.properties['Tags']).toEqual(['#Bread', 'quick', 'bread', 2]);
  });
});

describe('a query', () => {
  const run = (query: Parameters<typeof readPluginQuery>[0], space = recipesOnly) =>
    queryRows(readPluginQuery(query), space);

  it('lists what a query block would, among the pages the plugin can read', () => {
    const result = run({ spaceId, where: 'tried = true', sort: 'servings desc', limit: 1 });
    expect(result.total).toBe(2);
    expect(result.rows.map(({ title }) => title)).toEqual(['Tomato soup']);
    expect(run({ spaceId, from: 'Recipes/Soups' }).rows.map(({ title }) => title)).toEqual([
      'Tomato soup',
    ]);
    expect(run({ spaceId, from: '#bread' }).rows.map(({ title }) => title)).toEqual([
      'Garlic bread',
    ]);
    // The whole space, as far as it can read.
    expect(run({ spaceId }).total).toBe(3);
  });

  it('finds a folder only among those the plugin can read', () => {
    expect(() => run({ spaceId, from: 'Diary' })).toThrow('No folder here is at Diary.');
    // Its granted folder is the top of what it sees.
    expect(run({ spaceId, from: 'Soups' }, soupsOnly).total).toBe(1);
  });

  it('refuses a query that doesn’t read, saying why as the block would', () => {
    const refused = (query: Parameters<typeof readPluginQuery>[0], message: string) => {
      let error: unknown;
      try {
        readPluginQuery(query);
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(PluginError);
      expect(error).toMatchObject({ code: 'invalid', message });
    };
    refused(
      { spaceId, where: 'tried' },
      '“tried” isn’t a condition: a property name, then =, !=, <, <=, >, >= or has, then a value.',
    );
    refused({ spaceId, where: 'tried = true\nlimit: 2' }, 'where is one line of text');
    refused({ spaceId, sort: 4 as unknown as string }, 'sort is one line of text');
    refused({ spaceId, limit: 501 }, 'limit is a whole number from 1 to 500');
    refused({ spaceId, limit: 1.5 }, 'limit is a whole number from 1 to 500');
    refused({ spaceId, from: '' }, 'from: takes a folder’s path, or a #tag.');
  });
});

describe('what changed in the index', () => {
  it('names the pages whose rows may differ, where they are and were', () => {
    expect(indexChanges(INDEX, INDEX)).toEqual([]);
    const [bread, soup, , secret] = PAGES as [Page, Page, Page, Page];
    // The bread changed, the soup moved to the diary, the secret went.
    const next = INDEX.with(
      [
        [docOf(bread, 2), { title: 'Garlic bread', text: '' }],
        [docOf([soup[0], soup[1], soup[2], [diary]]), { title: 'Tomato soup', text: '' }],
        ...PAGES.filter((page) => ![bread, soup, secret].includes(page)).map(
          (page) => [docOf(page)] as const,
        ),
      ],
      { spaces: [spaceId] },
    );
    expect(indexChanges(INDEX, next)).toEqual(
      expect.arrayContaining([
        { spaceId, folderIds: [recipes] },
        { spaceId, folderIds: [diary] },
        { spaceId, folderIds: [recipes, soups] },
      ]),
    );
    expect(indexChanges(INDEX, next)).toHaveLength(4);
    // The first index: every page.
    expect(indexChanges(undefined, INDEX)).toHaveLength(PAGES.length);
  });
});

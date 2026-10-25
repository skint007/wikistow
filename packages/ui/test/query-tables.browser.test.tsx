import {
  FolderId,
  PageId,
  RevisionId,
  searchOperations,
  SpaceId,
  type ClientContext,
  type PropertyData,
} from '@wikistow/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, createRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { searchIndexKey, treeQuery } from '../src/data/queries.ts';
import { PageEditor } from '../src/page/editor/page-editor.tsx';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';
import { Markdown } from '../src/page/markdown.tsx';
import { QueryTable } from '../src/page/query-table.tsx';
import '@milkdown/kit/prose/view/style/prosemirror.css';

// Query tables (`wikistow-query`, ADR 0006 decision 7) as the reader and
// the visual editor show them: from the viewer's own search index.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const spaceId = SpaceId.parse('s-home');
const ctx = {} as ClientContext;
const recipes = FolderId.parse('f-recipes');

function indexOf(pages: [string, string, PropertyData[], FolderId | null][]) {
  const index = new searchOperations.PageIndex();
  for (const [id, title, properties, parentId] of pages) {
    index.addText(
      {
        spaceId,
        pageId: PageId.parse(id),
        revisionId: RevisionId.parse(`r-${id}`),
        parentId,
        folderIds: parentId ? [parentId] : [],
        path: [],
        draft: false,
        unpublished: false,
      },
      { title, text: '', properties },
    );
  }
  return index;
}

const INDEX = indexOf([
  [
    'p-bread',
    'Garlic bread',
    [
      { key: 'tried', type: 'boolean', value: true },
      { key: 'servings', type: 'number', value: 4 },
      { key: 'last_made', type: 'date', value: '2026-10-12' },
      { key: 'evil', type: 'text', value: '<img src=x onerror=alert(1)>' },
    ],
    recipes,
  ],
  [
    'p-soup',
    'Tomato soup',
    [
      { key: 'tried', type: 'boolean', value: true },
      { key: 'servings', type: 'number', value: 6 },
      { key: 'last_made', type: 'date', value: '2026-09-01' },
    ],
    recipes,
  ],
  ['p-tart', 'Lemon tart', [{ key: 'tried', type: 'boolean', value: false }], recipes],
  ['p-elsewhere', 'Elsewhere', [{ key: 'tried', type: 'boolean', value: true }], null],
]);

const TREE = {
  folders: [
    {
      id: recipes,
      parentId: null,
      metadata: { opened: { kind: 'current', metadata: { name: 'Recipes' } } },
    },
  ],
  pages: [],
  shares: [],
  space: null,
};

const PAGES = [
  { id: 'p-bread', title: 'Garlic bread', folders: ['Recipes'] },
  { id: 'p-soup', title: 'Tomato soup', folders: ['Recipes'] },
];

const EXAMPLE = [
  '```wikistow-query',
  'from: Recipes',
  'where: tried = true, servings >= 2',
  'show: servings, last_made, evil',
  'sort: last_made desc',
  '```',
].join('\n');

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  window.localStorage.clear();
});

/** A query client holding `index` as the viewer's, if given, and the space's tree. */
function client(index?: searchOperations.PageIndex) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (index) queries.setQueryData(searchIndexKey, index);
  queries.setQueryData(treeQuery(ctx, spaceId).queryKey, TREE as never);
  return queries;
}

async function mount(node: ReactNode, queries: QueryClient) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const rootRoute = createRootRoute({ component: () => node });
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/s/$spaceId/p/$pageId' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queries}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

const read = (source: string, queries: QueryClient) =>
  mount(
    <Markdown
      source={source}
      attachments={{
        ctx,
        page: { spaceId, pageId: PageId.parse('p-self') },
        audience: 'published',
        attachments: [],
      }}
      pages={PAGES}
      links={new Map()}
      editing={null}
    />,
    queries,
  );

const cells = (container: HTMLElement) =>
  [...container.querySelectorAll('.query-table tr')].map((row) =>
    [...row.querySelectorAll('th, td')].map((cell) => cell.textContent),
  );

describe('a query table in the reader', () => {
  it('lists the pages the query names, each page a link and each value as the rows show it', async () => {
    const container = await read(`Before\n\n${EXAMPLE}\n\nAfter\n`, client(INDEX));
    await expect.poll(() => cells(container).length).toBe(3);
    expect(cells(container)).toEqual([
      ['Page', 'Servings', 'Last made', 'Evil'],
      ['Garlic bread', '4', 'Oct 12, 2026', '<img src=x onerror=alert(1)>'],
      ['Tomato soup', '6', 'Sep 1, 2026', ''],
    ]);
    expect(container.querySelector('.query-table a[href="/s/s-home/p/p-soup"]')?.textContent).toBe(
      'Tomato soup',
    );
    expect(container.querySelector('.query-table img')).toBeNull();
    expect(container.querySelector('.query-table figcaption')?.textContent).toBe('2 pages.');
    // The block itself isn't shown.
    expect(container.querySelector('.page-body pre')).toBeNull();
  });

  it('updates without a reload when the index does', async () => {
    const queries = client(INDEX);
    const container = await read(EXAMPLE, queries);
    await expect.poll(() => cells(container).length).toBe(3);
    const changed = indexOf([
      [
        'p-tart',
        'Lemon tart',
        [
          { key: 'tried', type: 'boolean', value: true },
          { key: 'servings', type: 'number', value: 8 },
        ],
        recipes,
      ],
    ]);
    act(() => void queries.setQueryData(searchIndexKey, changed));
    await expect
      .poll(() => cells(container))
      .toEqual([
        ['Page', 'Servings', 'Last made', 'Evil'],
        ['Lemon tart', '8', '', ''],
      ]);
  });

  it('says so while the index is building', async () => {
    const container = await read(EXAMPLE, client());
    await expect
      .poll(() => container.querySelector('[role=status]')?.textContent ?? '')
      .toMatch(/^(Building the search index for this table…|This table can’t be shown)/);
  });

  it('shows a block that doesn’t read, or names no folder, as code with one line saying why', async () => {
    const container = await read(
      '```wikistow-query\nwhere: servings\n```\n\n```wikistow-query\nfrom: Desserts\n```\n',
      client(INDEX),
    );
    await expect.poll(() => container.querySelectorAll('.query-table-error').length).toBe(2);
    expect([...container.querySelectorAll('.page-body pre')].map((pre) => pre.textContent)).toEqual(
      ['where: servings\n', 'from: Desserts\n'],
    );
    expect([...container.querySelectorAll('.query-table-error')].map((p) => p.textContent)).toEqual(
      [
        '“servings” isn’t a condition: a property name, then =, !=, <, <=, >, >= or has, then a value.',
        'No folder here is at Desserts.',
      ],
    );
  });

  it('leaves a Dataview block as code', async () => {
    const container = await read(
      '```dataview\nTABLE servings FROM "Recipes"\n```\n',
      client(INDEX),
    );
    await expect
      .poll(() => container.querySelector('.page-body pre')?.textContent)
      .toBe('TABLE servings FROM "Recipes"\n');
    expect(container.querySelector('.query-table')).toBeNull();
  });
});

const links: LinkAssist = {
  pages: PAGES,
  targets: () => null,
  selfId: 'p-self',
  table: new Map(),
  headings: async () => [],
  ownHeadings: async () => [],
  create: () => {},
  pick: () => {},
  choose: () => {},
};

describe('a query block in the visual editor', () => {
  it('stays code, written as it was, with its table under it', async () => {
    window.localStorage.setItem('wikistow.editor', 'visual');
    const ref = createRef<EditorSurfaceHandle>();
    const page = `Intro\n\n${EXAMPLE}\n\nOutro\n`;
    const container = await mount(
      <PageEditor
        ref={ref}
        initial={page}
        onChange={() => {}}
        status={null}
        links={links}
        attachments={{ list: [], url: async () => null }}
        onFiles={() => {}}
        queryTable={(source) => (
          <QueryTable
            source={source}
            scope={{ ctx, spaceId, pageId: 'p-self', pages: PAGES, editor: true }}
            failed={(error) => <p className="query-table-error">{error}</p>}
          />
        )}
      />,
      client(INDEX),
    );
    await expect.poll(() => container.querySelector('#page-visual')).not.toBeNull();
    await expect
      .poll(() => container.querySelectorAll('#page-visual .query-result tr').length)
      .toBe(3);
    expect(container.querySelector('#page-visual pre')?.textContent).toContain('from: Recipes');
    expect(ref.current?.read()).toBe(page);
  });
});

import {
  newPayload,
  propertyData,
  RevisionId,
  searchOperations,
  splitFrontmatter,
  type ClientContext,
  type FolderId,
  type PageId,
  type SpaceId,
  type UnlockedVault,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { page, userEvent } from 'vite-plus/test/browser/context';
import { afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import { revisionQuery, searchProgressKey, treeQuery } from '../src/data/queries.ts';
import { FolderView } from '../src/folder/folder-view.tsx';
import type { SaveProperty } from '../src/folder/use-cell-edits.ts';
import { PLAIN, vaultStore } from '../src/vault/store.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// A folder's view, mounted for real on a cache holding its tree, the search
// index and each draft: what it lists, the layout and columns it keeps, and
// what a cell's edit saves, with a test standing in for the server.

// The server never answers, so an index rebuilt after an edit is still
// building behind the one shown, and a refetched tree keeps the one cached.
const ctx = {
  installationId: 'install',
  identity: { boxSecretKey: new Uint8Array(32) },
  revisions: { generation: 0 },
  api: { call: () => new Promise(() => {}) },
} as unknown as ClientContext;
vaultStore.unlock(ctx, { accountId: 'account' } as unknown as UnlockedVault);

const SPACE = 'kitchen-space' as SpaceId;
const RECIPES = 'recipes-folder' as FolderId;
const rev = (n: number) => RevisionId.parse(`01J${String(n).padStart(23, '0')}`);

type Page = { id: PageId; title: string; markdown: string; revision: RevisionId; draft?: boolean };

const SOUP: Page = {
  id: 'soup' as PageId,
  title: 'Tomato soup',
  markdown: '---\nservings: 4 # people\ntags: [soup, winter]\n---\nSimmer.',
  revision: rev(1),
  draft: true,
};
const BREAD: Page = {
  id: 'bread' as PageId,
  title: 'Garlic bread',
  markdown: '---\nCook_Time: 25\nnotes: |\n  Fresh garlic.\n---\nBake.',
  revision: rev(2),
};
const SALAD: Page = { id: 'salad' as PageId, title: 'Salad', markdown: 'Toss.', revision: rev(3) };

const named = (name: string) => ({
  head: 'head',
  opened: { kind: 'current', metadata: { name, extensions: {} } },
});

function treeOf(pages: Page[], role: 'reader' | 'editor') {
  return {
    space: { role, canPublish: false, metadata: named('Kitchen') },
    shares: [],
    folders: [{ id: RECIPES, parentId: null, metadata: named('Recipes') }],
    pages: pages.map((page) => ({
      id: page.id,
      parentId: RECIPES,
      title: page.title,
      emoji: null,
      icon: null,
      symbol: null,
      draftHead: role === 'reader' ? null : page.revision,
      publishedHead: page.revision,
      draftChanges: page.draft ?? false,
    })),
  };
}

function indexOf(pages: Page[]) {
  const index = new searchOperations.PageIndex();
  for (const page of pages) {
    index.addText(
      {
        spaceId: SPACE,
        pageId: page.id,
        revisionId: page.revision,
        parentId: RECIPES,
        folderIds: [RECIPES],
        path: ['Kitchen', 'Recipes'],
        draft: page.draft ?? false,
        unpublished: false,
      },
      {
        title: page.title,
        text: '',
        properties: propertyData(splitFrontmatter(page.markdown).frontmatter),
      },
    );
  }
  return index;
}

// Wide, where a folder opens as a table unless the person chose the list.
beforeAll(() => page.viewport(1280, 800));

let cleanup = () => {};
afterEach(() => {
  cleanup();
  // As another tab clearing it would, so the choices this tab holds go too.
  localStorage.clear();
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
});

/** The folder's view over `pages`, as a reader or an editor, and the paths it navigates to. */
async function mount(
  pages: Page[],
  {
    role = 'editor',
    save,
    index = indexOf(pages),
  }: {
    role?: 'reader' | 'editor';
    save?: SaveProperty;
    index?: searchOperations.PageIndex | null;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(treeQuery(ctx, SPACE).queryKey, treeOf(pages, role) as never);
  if (index) queryClient.setQueryData([PLAIN, 'search-index'], index);
  for (const page of pages) {
    queryClient.setQueryData(
      revisionQuery(ctx, { spaceId: SPACE, pageId: page.id }, 'draft', page.revision).queryKey,
      {
        opened: {
          kind: 'current',
          payload: newPayload({ title: page.title, markdown: page.markdown }),
        },
      } as never,
    );
  }
  const rootRoute = createRootRoute();
  const folder = createRoute({
    getParentRoute: () => rootRoute,
    path: '/s/$spaceId/f/$folderId',
    component: () => <FolderView spaceId={SPACE} folderId={RECIPES} save={save} />,
  });
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/s/$spaceId/p/$pageId',
    component: () => <p>A page</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([folder, pageRoute]),
    history: createMemoryHistory({ initialEntries: [`/s/${SPACE}/f/${RECIPES}`] }),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  await expect.poll(() => container.querySelector('h1')?.textContent).toBe('Recipes');
  return { container, router, queryClient };
}

const headings = (container: HTMLElement) =>
  [...container.querySelectorAll('thead th')].map((th) => th.textContent);
const rowOf = (container: HTMLElement, title: string) => {
  const row = [...container.querySelectorAll('tbody tr')].find((tr) =>
    tr.querySelector('th')?.textContent?.includes(title),
  );
  if (!row) throw new Error(`No row ${title}`);
  return row as HTMLElement;
};
const cellsOf = (row: HTMLElement) => [...row.querySelectorAll('td')].map((td) => td.textContent);
const button = (container: ParentNode, name: string | RegExp) => {
  const found = [
    ...container.querySelectorAll<HTMLElement>('button, [role=menuitemcheckbox]'),
  ].find((element) => {
    const text = element.getAttribute('aria-label') ?? element.textContent ?? '';
    return typeof name === 'string' ? text === name : name.test(text);
  });
  if (!found) throw new Error(`No button ${String(name)}`);
  return found;
};

/** A save that answers as the server would, recording what it was asked. */
function server(answer: (call: Parameters<SaveProperty>[0]) => ReturnType<SaveProperty>) {
  const calls: Parameters<SaveProperty>[0][] = [];
  const save: SaveProperty = (input) => {
    calls.push(input);
    return answer(input);
  };
  return { calls, save };
}

const written = (markdown: string, n: number) =>
  Promise.resolve({
    ok: true as const,
    written: { revisionId: rev(n), payload: newPayload({ title: '', markdown }) } as never,
  });

describe('a folder’s view', () => {
  it('tables its pages’ values under their keys in first-seen order, and keeps the layout and hidden columns', async () => {
    const { container } = await mount([SOUP, BREAD, SALAD], { role: 'reader' });
    expect(headings(container)).toEqual(['Title', 'Cook Time', 'Notes', 'Servings', 'Tags']);
    // By title: Garlic bread, Salad, Tomato soup.
    expect(cellsOf(rowOf(container, 'Tomato soup'))).toEqual(['–', '–', '4', 'soupwinter']);
    expect(container.querySelector('tbody input, tbody button')).toBeNull();

    await userEvent.click(button(container, /^Columns/));
    await userEvent.click(button(document, 'Notes'));
    await userEvent.keyboard('{Escape}');
    expect(headings(container)).toEqual(['Title', 'Cook Time', 'Servings', 'Tags']);
    // Kept as a tag: no property's name is stored in the clear.
    expect(Object.values(localStorage).join(' ').toLowerCase()).not.toContain('notes');
    await userEvent.click(button(container, 'List'));
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('ul[aria-label=Pages]')?.textContent).toContain('Servings4');

    // Kept on the device for the folder.
    cleanup();
    const again = await mount([SOUP, BREAD, SALAD], { role: 'reader' });
    expect(again.container.querySelector('table')).toBeNull();
    await userEvent.click(button(again.container, 'Table'));
    expect(headings(again.container)).toEqual(['Title', 'Cook Time', 'Servings', 'Tags']);
  });

  it('labels an editor’s drafts, and says how far the index has got while it builds', async () => {
    const { container } = await mount([SOUP, BREAD]);
    expect(rowOf(container, 'Tomato soup').querySelector('th')?.textContent).toContain('Draft');
    expect(rowOf(container, 'Garlic bread').querySelector('th')?.textContent).not.toContain(
      'Draft',
    );
    cleanup();
    const building = await mount([SOUP], { index: null });
    // As the build reads pages.
    await act(async () =>
      building.queryClient.setQueryData(searchProgressKey, { pages: 12, total: 40 }),
    );
    await expect.poll(() => building.container.textContent).toContain('12 of 40');
    expect(building.container.querySelector('table')).toBeNull();
  });

  it('saves a cell against the version it read, in the page’s own key, and shows what it wrote', async () => {
    const { calls, save } = server(() => written(SOUP.markdown.replace('4 #', '6 #'), 11));
    const { container } = await mount([SOUP, BREAD, SALAD], { save });
    await userEvent.click(button(container, /^Servings of Tomato soup: 4/));
    await userEvent.keyboard('{Control>}a{/Control}6{Enter}');
    expect(calls).toEqual([
      {
        page: { spaceId: SPACE, pageId: SOUP.id },
        basedOn: SOUP.revision,
        key: 'servings',
        value: 6,
      },
    ]);
    await expect.poll(() => cellsOf(rowOf(container, 'Tomato soup'))[2]).toBe('6');
    // The keyboard is back on the cell, as it is after a row's edit.
    await expect
      .poll(() => document.activeElement?.getAttribute('aria-label'))
      .toBe('Servings of Tomato soup: 6. Edit');

    // The page's own spelling of the key, and a page with no block gets one.
    await userEvent.click(button(container, /^Cook Time of Garlic bread: 25/));
    await userEvent.keyboard('{Control>}a{/Control}30{Enter}');
    await userEvent.click(button(container, /^Servings of Salad: empty/));
    await userEvent.keyboard('2{Enter}');
    expect(calls.slice(1).map(({ key, value }) => ({ key, value }))).toEqual([
      { key: 'Cook_Time', value: 30 },
      { key: 'servings', value: 2 },
    ]);
  });

  it('shows a conflict on the cell, keeping the value read, and opens the page for a value it can’t change', async () => {
    const { save } = server(() =>
      Promise.reject(new ApiError(409, 'stale-head', 'Someone saved since you loaded the page')),
    );
    const { container, router } = await mount([SOUP, BREAD], { save });
    await userEvent.click(button(container, /^Servings of Tomato soup: 4/));
    await userEvent.keyboard('{Control>}a{/Control}6{Enter}');
    const row = rowOf(container, 'Tomato soup');
    await expect
      .poll(() => row.querySelector('[role=alert]')?.textContent)
      .toContain('Not saved. This page changed since the table read it.');
    expect(row.querySelectorAll('td')[2]?.textContent).toMatch(/^4/);
    await userEvent.click(button(row, 'Dismiss'));
    expect(row.querySelector('[role=alert]')).toBeNull();

    // A block scalar can't change in place: its cell opens the draft.
    const notes = rowOf(container, 'Garlic bread')
      .querySelectorAll('td')[1]
      ?.querySelector('button');
    expect(notes?.getAttribute('aria-description')).toContain('Opens the page.');
    await userEvent.click(notes as HTMLElement);
    await expect
      .poll(() => router.state.location.href)
      .toBe(`/s/${SPACE}/p/${BREAD.id}?view=draft`);
  });
});

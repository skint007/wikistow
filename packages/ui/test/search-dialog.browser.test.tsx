import {
  FolderId,
  PageId,
  RevisionId,
  searchOperations,
  SpaceId,
  type ClientContext,
  type UnlockedVault,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vite-plus/test';
import { userEvent } from 'vite-plus/test/browser/context';
import { searchIndexQuery } from '../src/data/queries.ts';
import { SearchDialog } from '../src/shell/search-dialog.tsx';
import {
  filterQuery,
  linkedSearch,
  SearchLink,
  SearchOpener,
  takeHeldSearch,
  withoutSearchHash,
} from '../src/shell/search-link.tsx';
import { SEARCH_HELP } from '../src/shell/search-model.ts';
import { vaultStore } from '../src/vault/store.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Nothing here reaches a server: the index is in the cache already.
const ctx = {
  api: {
    call: async () => {
      throw new ApiError(0, 'network', 'No answer');
    },
  },
} as unknown as ClientContext;
vaultStore.unlock(ctx, {} as UnlockedVault);

const SPACE = SpaceId.parse('home');
const RECIPES = FolderId.parse('recipes');

/** An index of pages by title, each with its Markdown. */
function indexOf(pages: Record<string, string>) {
  const index = new searchOperations.PageIndex();
  for (const [title, markdown] of Object.entries(pages)) {
    const id = title.toLowerCase().replace(/\W+/g, '-');
    index.add(
      {
        spaceId: SPACE,
        pageId: PageId.parse(id),
        revisionId: RevisionId.parse(`${id}-r1`),
        parentId: RECIPES,
        folderIds: [RECIPES],
        path: ['Recipes'],
        draft: false,
        unpublished: false,
      },
      { title, markdown },
    );
  }
  return index;
}

const PAGES = {
  'Bean soup': '---\ntags: [soup, winter]\nstatus: tried\n---\nBeans and stock.',
  'Pea soup': '---\ntags: soup\nstatus: in progress\n---\nPeas, mint and stock.',
  Bread: '---\ntags: [bread]\n---\nFlour, stock of yeast.',
  'Soup notes': 'Soup without tags.',
};

let queryClient: QueryClient;
let cleanup = () => {};
afterEach(() => cleanup());

async function mount(
  query = '',
  ui = <SearchDialog ctx={ctx} open query={query} onOpenChange={() => {}} />,
) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(searchIndexQuery(ctx, queryClient).queryKey, indexOf(PAGES));
  // On a page, as the app has it, so links relative to it keep its address.
  const rootRoute = createRootRoute({ component: Outlet });
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/s/$spaceId/p/$pageId',
    component: () => ui,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: ['/s/home/p/bean-soup?view=draft'] }),
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
  return router;
}

const input = () => {
  const found = document.querySelector<HTMLInputElement>('input[aria-label="Search pages"]');
  if (!found) throw new Error('No search box');
  return found;
};
const type = (text: string) => act(() => userEvent.fill(input(), text));
const press = (key: string) =>
  act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
const titles = () =>
  [...document.querySelectorAll('[role="option"]')].map(
    (option) => option.querySelector('.font-extrabold')?.textContent,
  );
const status = () => document.querySelector('[role="status"]')?.textContent;
const active = () =>
  document.querySelector('[role="option"][aria-selected="true"] .font-extrabold')?.textContent;

it('says how to filter, and finds pages by tag and property, alone and with words', async () => {
  await mount();
  expect(status()).toBe(SEARCH_HELP);
  // A filter half typed has nothing to look for yet.
  await type('tag:');
  expect(status()).toBe(SEARCH_HELP);
  await type('tag:soup');
  await expect.poll(titles).toEqual(['Bean soup', 'Pea soup']);
  expect(status()).toBe('2 pages');
  await type('mint tag:soup');
  await expect.poll(titles).toEqual(['Pea soup']);
  await type('status:"in progress"');
  await expect.poll(titles).toEqual(['Pea soup']);
  await type('stock tag:bread');
  await expect.poll(titles).toEqual(['Bread']);
  await type('tag:nothing');
  await expect.poll(titles).toEqual([]);
  expect(status()).toBe('No pages match.');
});

it('shows a filter’s matching value in a filtered hit’s snippet', async () => {
  await mount('tag:winter');
  await expect.poll(titles).toEqual(['Bean soup']);
  const marks = [...document.querySelectorAll('[role="option"] mark')].map((m) => m.textContent);
  expect(marks).toEqual(['winter']);
});

it('opens with a link’s query, and keeps the hit chosen while the index rebuilds', async () => {
  await mount('tag:soup');
  expect(input().value).toBe('tag:soup');
  await expect.poll(titles).toEqual(['Bean soup', 'Pea soup']);
  await press('ArrowDown');
  expect(active()).toBe('Pea soup');
  // A page others change rebuilds the index: a new one, with a page more.
  await act(async () =>
    queryClient.setQueryData(
      searchIndexQuery(ctx, queryClient).queryKey,
      indexOf({ ...PAGES, 'Ale soup': '---\ntags: soup\n---\n' }),
    ),
  );
  await expect.poll(titles).toEqual(['Ale soup', 'Bean soup', 'Pea soup']);
  expect(active()).toBe('Pea soup');
  // A new query starts at its first hit.
  await type('tag:soup stock');
  await expect.poll(titles).toEqual(['Bean soup', 'Pea soup']);
  expect(active()).toBe('Bean soup');
});

it('links to a search, opening it where the page is without leaving', async () => {
  const opened: string[] = [];
  const router = await mount(
    '',
    <SearchOpener value={(query) => opened.push(query)}>
      <SearchLink query={filterQuery('status', 'in progress')}>in progress</SearchLink>
    </SearchOpener>,
  );
  const link = document.querySelector('a');
  if (!link) throw new Error('No link');
  // Its address opens search too, in another tab, on the same page, with
  // the query in the fragment, which the browser never sends.
  const href = new URL(link.href);
  expect(href.pathname).toBe('/s/home/p/bean-soup');
  expect(href.search).toBe('?view=draft');
  expect(linkedSearch(href.hash)).toBe('status:"in progress"');
  await act(async () => link.click());
  expect(opened).toEqual(['status:"in progress"']);
  expect(router.state.location.href).toBe('/s/home/p/bean-soup?view=draft');
});

it('gets a link’s query back as written, as the router reads its address', async () => {
  const queries = ['tag:soup', 'status:"in progress"', '"10:30" #x%20&y=1', 'ünï 日本'];
  const router = await mount(
    '',
    <>
      {queries.map((query) => (
        <SearchLink key={query} query={query}>
          {query}
        </SearchLink>
      ))}
    </>,
  );
  const read: (string | null)[] = [];
  for (const link of document.querySelectorAll('a')) {
    const { pathname, search, hash } = new URL(link.href);
    await act(() => router.navigate({ href: pathname + search + hash }));
    read.push(linkedSearch(router.state.location.hash));
  }
  expect(read).toEqual(queries);
  expect(linkedSearch('#ingredients')).toBeNull();
  expect(linkedSearch('')).toBeNull();
  expect(linkedSearch('#search=%E0%A4%A')).toBe('');
  // Nor does it stay in an address to return to.
  expect(withoutSearchHash('/s/home/p/x#search=discount:50%')).toBe('/s/home/p/x');
  takeHeldSearch();
});

it('holds a link’s search in memory while unlocking, not in the address', () => {
  const href = `/s/home/p/bean-soup?view=draft#search=${encodeURIComponent('tag:"in progress"')}`;
  expect(withoutSearchHash(href)).toBe('/s/home/p/bean-soup?view=draft');
  expect(takeHeldSearch()).toBe('tag:"in progress"');
  expect(takeHeldSearch()).toBeNull();
  // Any other address, a heading's too, goes back as it was.
  expect(withoutSearchHash('/s/home/p/bean-soup#method')).toBe('/s/home/p/bean-soup#method');
  expect(takeHeldSearch()).toBeNull();
  // Signing in may be someone else's: nothing is held for it, and what was goes.
  withoutSearchHash(href);
  expect(withoutSearchHash(href, { hold: false })).toBe('/s/home/p/bean-soup?view=draft');
  expect(takeHeldSearch()).toBeNull();
});

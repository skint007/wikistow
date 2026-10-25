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
import { act, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vite-plus/test';
import { userEvent } from 'vite-plus/test/browser/context';
import { searchIndexQuery } from '../src/data/queries.ts';
import { PropertiesBox, PropertiesEditor } from '../src/page/properties-box.tsx';
import type { LinkScope } from '../src/page/property-value.tsx';
import { SearchDialog } from '../src/shell/search-dialog.tsx';
import { linkedSearch, SearchOpener } from '../src/shell/search-link.tsx';
import { vaultStore } from '../src/vault/store.ts';

// The rows' tag pills open tag search over the page, on the published view
// and the draft's, where each pill's remove button and a value's field stay
// their own.

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

const PAGES = {
  'Bean soup': '---\ntags: [soup, winter]\n---\nBeans and stock.',
  'Pea soup': '---\nTags: soup\n---\nPeas and mint.',
  'Soup kitchen rota': '---\ntag: [soup kitchen]\n---\nMondays.',
  Bread: '---\ntags: [bread]\n---\nFlour.',
};

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

const scope: LinkScope = {
  spaceId: 'home',
  selfId: 'bean-soup',
  pages: [],
  links: new Map(),
  editor: true,
};

/** Search as the app shell opens it, from a link, over `children`. */
function WithSearch({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState<string | null>(null);
  return (
    <SearchOpener value={setQuery}>
      {children}
      <SearchDialog
        ctx={ctx}
        open={query !== null}
        query={query ?? ''}
        onOpenChange={(open) => {
          if (!open) setQuery(null);
        }}
      />
    </SearchOpener>
  );
}

let cleanup = () => {};
afterEach(() => cleanup());

/** `ui` on a page's draft, with search, its index loaded. */
async function mount(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(searchIndexQuery(ctx, queryClient).queryKey, indexOf(PAGES));
  const rootRoute = createRootRoute({ component: Outlet });
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/s/$spaceId/p/$pageId',
    component: () => <WithSearch>{ui}</WithSearch>,
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
  await expect.poll(() => container.querySelector('dl')).not.toBeNull();
  return { container, router };
}

/** The draft's rows over `initial`, keeping each block they hand back. */
function Draft({ initial, blocks }: { initial: string; blocks: string[] }) {
  const [block, setBlock] = useState(initial);
  return (
    <PropertiesEditor
      frontmatter={block}
      scope={scope}
      onChange={(next) => {
        blocks.push(next);
        setBlock(next);
      }}
      onRemove={() => {}}
      onInsert={() => {}}
    />
  );
}

const tagLink = (container: HTMLElement, text: string) => {
  const found = [...container.querySelectorAll<HTMLAnchorElement>('dd a')].find(
    (link) => link.textContent === text,
  );
  if (!found) throw new Error(`No link ${text}`);
  return found;
};
const links = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLAnchorElement>('dd a')].map((link) => link.textContent);
const searchBox = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Search pages"]')?.value;
const titles = () =>
  [...document.querySelectorAll('[role="option"]')].map(
    (option) => option.querySelector('.font-extrabold')?.textContent,
  );
const closeSearch = async () => {
  await userEvent.keyboard('{Escape}');
  await expect.poll(searchBox).toBeUndefined();
};

it('opens a tag’s search from its pill on the published view, staying on the page', async () => {
  const { container, router } = await mount(
    <PropertiesBox
      frontmatter={
        '---\nTags: [soup, "soup kitchen", [a, b]]\nTAG: winter\ncategory: [soup]\nnote: soup\n---\n'
      }
      scope={scope}
    />,
  );
  // The tags, whatever their key's case, and Obsidian's older `tag`, a tag
  // alone too; a list in the list isn't one tag, and other keys aren't tags.
  expect(links(container)).toEqual(['soup', 'soup kitchen', 'winter']);
  expect(linkedSearch(new URL(tagLink(container, 'soup kitchen').href).hash)).toBe(
    'tag:"soup kitchen"',
  );
  await userEvent.click(tagLink(container, 'soup'));
  await expect.poll(searchBox).toBe('tag:soup');
  await expect.poll(titles).toEqual(['Bean soup', 'Pea soup']);
  expect(router.state.location.href).toBe('/s/home/p/bean-soup?view=draft');
  await closeSearch();
  await userEvent.click(tagLink(container, 'soup kitchen'));
  await expect.poll(titles).toEqual(['Soup kitchen rota']);
});

it('opens a tag’s search from the draft’s pill, its remove button still removing it', async () => {
  const blocks: string[] = [];
  const { container } = await mount(
    <Draft initial={'---\ntags: [soup, winter]\n---\n'} blocks={blocks} />,
  );
  const soup = tagLink(container, 'soup');
  await userEvent.click(soup);
  await expect.poll(searchBox).toBe('tag:soup');
  await expect.poll(titles).toEqual(['Bean soup', 'Pea soup']);
  await closeSearch();
  expect(blocks).toEqual([]);
  // The keyboard goes from a tag to its own button, then on to the next tag.
  soup.focus();
  await userEvent.tab();
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove soup from Tags');
  await userEvent.tab();
  expect(document.activeElement?.textContent).toBe('winter');
  await userEvent.click(container.querySelector('[aria-label="Remove winter from Tags"]')!);
  expect(blocks.at(-1)).toBe('---\ntags: [soup]\n---\n');
  await expect.poll(searchBox).toBeUndefined();
});

it('opens a tag alone’s search from its pill on the draft, and its field beside it', async () => {
  const blocks: string[] = [];
  const { container } = await mount(<Draft initial={'---\ntags: soup\n---\n'} blocks={blocks} />);
  await userEvent.click(tagLink(container, 'soup'));
  await expect.poll(searchBox).toBe('tag:soup');
  await expect.poll(titles).toEqual(['Bean soup', 'Pea soup']);
  await closeSearch();
  expect(container.querySelector('input[aria-label="Tags"]')).toBeNull();
  await userEvent.click(container.querySelector('[aria-label="Tags: soup. Edit"]')!);
  const field = container.querySelector<HTMLInputElement>('input[aria-label="Tags"]');
  expect(field?.value).toBe('soup');
});

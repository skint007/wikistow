import {
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
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { searchIndexKey } from '../src/data/queries.ts';
import { PageEditor } from '../src/page/editor/page-editor.tsx';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';
import { Markdown } from '../src/page/markdown.tsx';
import { otherPages } from '../src/page/other-pages.ts';
import '@milkdown/kit/prose/view/style/prosemirror.css';

// References to other pages' values (`` `=[[Page]].key` ``, ADR 0006
// decision 5), as the reader and the editors show them: from the viewer's
// search index, and the same text as written for anything it doesn't hold.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const spaceId = SpaceId.parse('s-home');

/** An index holding `pages`, as a viewer's would: only those they can open, in the version they see. */
function indexOf(pages: Record<string, { title: string; properties: PropertyData[] }>) {
  const index = new searchOperations.PageIndex();
  for (const [id, { title, properties }] of Object.entries(pages)) {
    index.addText(
      {
        spaceId,
        pageId: PageId.parse(id),
        revisionId: RevisionId.parse(`r-${id}`),
        parentId: null,
        folderIds: [],
        path: [],
        draft: false,
        unpublished: false,
      },
      { title, text: '', properties },
    );
  }
  return index;
}

const BREAD: PropertyData[] = [
  { key: 'cook_time', type: 'number', value: 25 },
  { key: 'goes_with', type: 'wikilink', value: '[[Tomato soup]]' },
  { key: 'evil', type: 'text', value: '<img src=x onerror=alert(1)>' },
];

// The viewer's tree: Garlic bread and Tomato soup they can open; Secret
// they see in the tree, but the index doesn't hold (unpublished, say).
const PAGES = [
  { id: 'p-bread', title: 'Garlic bread', folders: [] },
  { id: 'p-soup', title: 'Tomato soup', folders: [] },
  { id: 'p-secret', title: 'Secret', folders: [] },
];

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  window.localStorage.clear();
});

async function mount(node: ReactNode, client = new QueryClient()) {
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
      <QueryClientProvider client={client}>
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

/** The reader over `source`, its viewer's index `index` (none built yet if undefined). */
async function read(
  source: string,
  {
    index,
    editing = false,
    links = new Map<string, string>(),
  }: {
    index?: searchOperations.PageIndex;
    editing?: boolean;
    links?: Map<string, string>;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (index) client.setQueryData(searchIndexKey, index);
  const container = await mount(
    <Markdown
      source={source}
      attachments={{
        ctx: {} as ClientContext,
        page: { spaceId, pageId: PageId.parse('p-self') },
        audience: 'published',
        attachments: [],
      }}
      pages={[...PAGES, { id: 'p-self', title: 'Notes', folders: [] }]}
      links={links}
      editing={editing ? { parentId: null, create: false } : null}
    />,
    client,
  );
  await expect.poll(() => container.querySelector('.page-body p')).not.toBeNull();
  return { container, client };
}

const paragraphs = (container: HTMLElement) =>
  [...container.querySelectorAll('.page-body p')].map((p) => p.textContent);

describe('another page’s value in the reader', () => {
  const index = indexOf({
    'p-bread': { title: 'Garlic bread', properties: BREAD },
    'p-soup': { title: 'Tomato soup', properties: [] },
  });

  it('shows the value from the viewer’s index, with a hint naming the property and page', async () => {
    const { container } = await read(
      'Bake `=[[Garlic bread]].cook_time` min, with `= [[garlic bread]]. goes with`.\n\nThen `=[[Garlic bread]].evil`.\n',
      { index },
    );
    expect(paragraphs(container)[0]).toBe('Bake 25 min, with Tomato soup.');
    const value = container.querySelector('[data-hint="cook_time · Garlic bread"]');
    expect(value?.textContent).toBe('25');
    expect(value?.className).toContain('decoration-dotted');
    expect(container.querySelector('a[href="/s/s-home/p/p-soup"]')?.textContent).toBe(
      'Tomato soup',
    );
    // Never HTML made from a value.
    expect(container.querySelector('.page-body img')).toBeNull();
    expect(paragraphs(container)[1]).toBe('Then <img src=x onerror=alert(1)>.');
  });

  it('follows the page through its link table entry, once renamed', async () => {
    const renamed = indexOf({ 'p-bread': { title: 'Cheesy bread', properties: BREAD } });
    const { container } = await read('Bake `=[[Old bread]].cook_time` min.\n', {
      index: renamed,
      links: new Map([['old bread', 'p-bread']]),
    });
    expect(paragraphs(container)[0]).toBe('Bake 25 min.');
    expect(container.querySelector('[data-hint="cook_time · Cheesy bread"]')).not.toBeNull();
  });

  it('updates without a reload when the index does', async () => {
    const { container, client } = await read('Bake `=[[Garlic bread]].cook_time` min.\n', {
      index,
    });
    expect(paragraphs(container)[0]).toBe('Bake 25 min.');
    const changed = indexOf({
      'p-bread': {
        title: 'Garlic bread',
        properties: [{ key: 'cook_time', type: 'number', value: 30 }],
      },
    });
    act(() => void client.setQueryData(searchIndexKey, changed));
    await expect.poll(() => paragraphs(container)[0]).toBe('Bake 30 min.');
  });

  it('shows a missing page, one the index doesn’t hold and a missing key alike to a reader: as written', async () => {
    const references = [
      '`=[[No such page]].cook_time`',
      '`=[[Secret]].cook_time`',
      '`=[[Garlic bread]].nothing`',
      '`=nothing`',
    ];
    const { container } = await read(`${references.join(' ')}\n`, { index });
    const codes = [...container.querySelectorAll('.page-body code')];
    expect(codes.map((code) => code.textContent)).toEqual(
      references.map((reference) => reference.slice(1, -1)),
    );
    // The same element each time, but for its text: nothing tells them apart.
    const shapes = codes.map((code) => code.outerHTML.replace(code.textContent ?? '', ''));
    expect(new Set(shapes).size).toBe(1);
    expect(codes[0]?.hasAttribute('data-hint')).toBe(false);

    // And the same before the index is built.
    const { container: unbuilt } = await read(`${references[0]}\n`);
    const code = unbuilt.querySelector('.page-body code');
    expect(code?.outerHTML.replace(code.textContent ?? '', '')).toBe(shapes[0]);
  });

  it('tells an editor whether the page or the name is missing, as their own tree and index say', async () => {
    const { container } = await read(
      '`=[[No such page]].cook_time` `=[[Secret]].cook_time` `=[[Garlic bread]].nothing`\n',
      { index, editing: true },
    );
    const hints = [...container.querySelectorAll('.page-body code')].map((code) =>
      code.getAttribute('data-hint'),
    );
    expect(hints).toEqual([
      'No page has this title',
      'No page has this title',
      'No property has this name',
    ]);
  });
});

const links: LinkAssist = {
  pages: PAGES,
  targets: () => new Set(PAGES.map((page) => page.id)),
  selfId: 'p-self',
  table: new Map(),
  headings: async () => [],
  ownHeadings: async () => [],
  create: () => {},
  pick: () => {},
  choose: () => {},
};

const others = otherPages(indexOf({ 'p-bread': { title: 'Garlic bread', properties: BREAD } }), {
  spaceId,
  selfId: 'p-self',
  pages: PAGES,
  links: new Map(),
  editor: true,
});

async function pageEditor(initial: string, mode: 'source' | 'visual') {
  window.localStorage.setItem('wikistow.editor', mode);
  const ref = createRef<EditorSurfaceHandle>();
  const container = await mount(
    <PageEditor
      ref={ref}
      initial={initial}
      onChange={() => {}}
      status={null}
      links={links}
      attachments={{ list: [], url: async () => null }}
      onFiles={() => {}}
      otherPages={others}
    />,
  );
  if (mode === 'visual') {
    await expect.poll(() => container.querySelector('#page-visual')).not.toBeNull();
  } else {
    await expect
      .poll(() =>
        [...container.querySelectorAll('div')].some((div) =>
          div.shadowRoot?.querySelector('.cm-editor'),
        ),
      )
      .toBe(true);
  }
  return { container, ref };
}

const sourceLabels = (container: HTMLElement) =>
  [...container.querySelectorAll('div')].flatMap((div) =>
    [...(div.shadowRoot?.querySelectorAll('.cm-completionLabel') ?? [])].map((l) => l.textContent),
  );

const visualOptions = (label: string) =>
  [...document.querySelectorAll(`[role=listbox][aria-label="${label}"] [role=option]`)].map(
    (option) => option.firstChild?.textContent,
  );

describe('another page’s value in the visual editor', () => {
  it('shows the value beside the code, and leaves the text as written', async () => {
    const page =
      'Bake `=[[Garlic bread]].cook_time` with `=[[Nowhere]].x` and `=[[Garlic bread]].y`.\n';
    const { container, ref } = await pageEditor(page, 'visual');
    const chip = () =>
      container.querySelector<HTMLElement>('#page-visual [data-hint="cook_time · Garlic bread"]');
    await expect.poll(() => chip()?.textContent).toBe('25');
    expect(
      container.querySelector('#page-visual [data-hint="No page has this title"]')?.textContent,
    ).toBe('=[[Nowhere]].x');
    expect(
      container.querySelector('#page-visual [data-hint="No property has this name"]')?.textContent,
    ).toBe('=[[Garlic bread]].y');
    expect(ref.current?.read()).toBe(page);
  });

  it('keeps a reference’s page typed in as text, then code', async () => {
    const { container, ref } = await pageEditor('Bake\n', 'visual');
    await userEvent.click(container.querySelector('#page-visual p')!);
    // `[[` is how user-event types one `[`.
    await userEvent.keyboard('{End} `=[[[[Garlic bread]].cook_time` min');
    await expect.poll(() => ref.current?.read()).toBe('Bake `=[[Garlic bread]].cook_time` min\n');
    expect(container.querySelector('#page-visual [data-wikilink]')).toBeNull();
  });
});

describe('completing a reference to another page’s value', () => {
  it('offers pages after `=[[, then that page’s keys, in the source editor', async () => {
    const { container, ref } = await pageEditor('Bake \n', 'source');
    act(() => ref.current?.focus());
    await userEvent.keyboard('{Control>}{End}{/Control}{ArrowUp}{End}`=[[[[Garl');
    await expect.poll(() => sourceLabels(container)).toEqual(['Garlic bread']);
    await userEvent.keyboard('{Enter}.co');
    await expect.poll(() => sourceLabels(container)).toEqual(['cook_time']);
    await userEvent.keyboard('{Enter} min');
    await expect.poll(() => ref.current?.read()).toBe('Bake `=[[Garlic bread]].cook_time` min\n');
  });

  it('does so in the visual editor, writing the page as text in the code', async () => {
    const { container, ref } = await pageEditor('Bake\n', 'visual');
    await userEvent.click(container.querySelector('#page-visual p')!);
    await userEvent.keyboard('{End} `=[[[[Garl');
    await expect.poll(() => visualOptions('Link to')).toEqual(['Garlic bread']);
    await userEvent.keyboard('{Enter}.co');
    await expect.poll(() => visualOptions('Property')).toEqual(['cook_time']);
    await userEvent.keyboard('{Enter} min');
    await expect.poll(() => ref.current?.read()).toBe('Bake `=[[Garlic bread]].cook_time` min\n');
    expect(container.querySelector('#page-visual [data-wikilink]')).toBeNull();
  });
});

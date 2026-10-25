import {
  readProperties,
  splitFrontmatter,
  type ClientContext,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vite-plus/test';
import { userEvent } from 'vite-plus/test/browser/context';
import type { LinkAssist } from '../src/page/editor/surface.ts';

// A link's hint in the desktop app, placed in Chromium: above the link,
// where the pointer resting on its line of text doesn't cover it. So is a
// wikilink's source, its hint in the visual editor, and any other hint on
// a link's text, in the reader and the editor: a missing or ambiguous
// wikilink's, a reference's in a link, a page link chip's and a tag's.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// As in the desktop app, which sets its bridge before the pages load.
window.wikistowDesktop = {} as NonNullable<Window['wikistowDesktop']>;
const { BodyLink } = await import('../src/page/body-link.tsx');
const { HintLayer } = await import('../src/components/ui/tooltip.tsx');
const { default: VisualSurface } = await import('../src/page/editor/visual/visual-surface.tsx');
const { Markdown } = await import('../src/page/markdown.tsx');
const { TagPill } = await import('../src/page/property-value.tsx');

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

/** `content` and the hint layer, well below the top of the window. */
async function render(content: ReactNode) {
  const container = document.createElement('div');
  container.style.padding = '200px 40px';
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        {content}
        <HintLayer />
      </>,
    ),
  );
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

/** The hint `element` shows once the pointer rests on it. */
async function hintOf(element: Element) {
  await userEvent.hover(element);
  await expect.poll(() => document.querySelector('[data-slot="tooltip-content"]')).not.toBeNull();
  return document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')!;
}

/** Where `hint` sits by `element`: above it, clear of the pointer resting on its line, or below. */
function side(hint: HTMLElement, element: Element) {
  const above = hint.getBoundingClientRect().bottom <= element.getBoundingClientRect().top;
  const below = hint.getBoundingClientRect().top >= element.getBoundingClientRect().bottom;
  expect(hint.dataset['side']).toBe(above ? 'top' : below ? 'bottom' : 'over');
  return hint.dataset['side'];
}

/** The hint the element `selector` finds shows, and its side. */
async function hinted(container: HTMLElement, selector: string) {
  const element = container.querySelector(selector);
  expect(element, selector).not.toBeNull();
  const hint = await hintOf(element!);
  const shown = { text: hint.textContent, side: side(hint, element!) };
  // Off it, so the next one's hint shows anew.
  await userEvent.unhover(element!);
  await expect.poll(() => document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  return shown;
}

// Two pages of one title, and none of another.
const PAGES = [
  { id: 'dal-1', title: 'Dal', folders: [] },
  { id: 'dal-2', title: 'Dal', folders: [] },
];
const MISSING_AND_AMBIGUOUS =
  'See [[Nowhere]] and [[Dal]], or [read [[Dal]]](https://example.com) first.\n';
// References in a link's text: a value found, and a name not found.
const REFERENCES_IN_LINK = '[Serves `=servings`, not `=nope`](https://example.com).\n';
const FRONTMATTER = '---\ngoes_with: "[[Nowhere]]"\nservings: 4\n---\n';

it('shows a link hint above the link', async () => {
  const container = await render(
    <p>
      See <BodyLink href="https://example.com/docs">the docs</BodyLink> first.
    </p>,
  );

  const link = container.querySelector('a')!;
  const hint = await hintOf(link);
  expect(hint.dataset['side']).toBe('top');
  expect(hint.getBoundingClientRect().bottom).toBeLessThanOrEqual(link.getBoundingClientRect().top);
});

it('shows a wikilink’s source above it in the visual editor', async () => {
  const links: LinkAssist = {
    pages: [{ id: 'plan', title: 'Plan', folders: [] }],
    targets: () => null,
    selfId: 'self',
    table: new Map(),
    headings: async () => [],
    ownHeadings: async () => [],
    create: () => {},
    pick: () => {},
    choose: () => {},
  };
  const container = await render(
    <VisualSurface
      initial={'See [[Plan|the plan]] first.\n'}
      onChange={() => {}}
      links={links}
      attachments={{ list: [], url: async () => '' }}
      onFiles={() => {}}
    />,
  );
  // The first loads Milkdown, which takes a while under load.
  await expect.poll(() => container.querySelector('[data-wikilink]')).not.toBeNull();

  const wikilink = container.querySelector('[data-wikilink]')!;
  const hint = await hintOf(wikilink);
  expect(hint.textContent).toBe('[[Plan|the plan]]');
  expect(hint.dataset['side']).toBe('top');
  expect(hint.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    wikilink.getBoundingClientRect().top,
  );
});

it('shows the hints on a link’s text above it in the reader', async () => {
  const node = (
    <>
      <Markdown
        source={`${FRONTMATTER}${MISSING_AND_AMBIGUOUS}\nWith \`=goes_with\`.\n\n${REFERENCES_IN_LINK}`}
        attachments={{
          ctx: {} as ClientContext,
          page: { spaceId: 's-home' as SpaceId, pageId: 'p-self' as PageId },
          audience: 'draft',
          attachments: [],
        }}
        pages={PAGES}
        links={new Map()}
        editing={{ parentId: null, create: true }}
      />
      <p className="tags">
        <TagPill query="tag:soup">soup</TagPill>
      </p>
    </>
  );
  const rootRoute = createRootRoute({ component: () => node });
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/s/$spaceId/p/$pageId' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
  });
  const container = await render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await expect.poll(() => container.querySelector('.page-body p')).not.toBeNull();

  expect(await hinted(container, '.page-body button')).toEqual({
    text: 'Create this page',
    side: 'top',
  });
  const ambiguous = { text: 'More than one page has this title', side: 'top' };
  expect(await hinted(container, '.page-body p > span[data-hint]')).toEqual(ambiguous);
  // In a Markdown link's text.
  expect(await hinted(container, '.page-body a [data-hint]')).toEqual(ambiguous);
  // A reference's page link chip, as a property row shows one. The
  // reference's own hint is on a link's text too.
  const chipped = '[data-hint="goes_with · property"]';
  expect(await hinted(container, `${chipped} [data-hint]`)).toEqual({
    text: 'No page has this title',
    side: 'top',
  });
  expect(container.querySelector<HTMLElement>(chipped)?.dataset['hintSide']).toBe('top');
  expect(await hinted(container, 'a [data-hint="servings · property"]')).toEqual({
    text: 'servings · property',
    side: 'top',
  });
  expect(await hinted(container, 'a code[data-hint]')).toEqual({
    text: 'No property has this name',
    side: 'top',
  });
  // A tag's pill, a link to its search.
  expect(await hinted(container, '.tags a')).toEqual({ text: 'Search tag:soup', side: 'top' });
});

it('shows the hints on a link’s text above it in the visual editor', async () => {
  const links: LinkAssist = {
    pages: PAGES,
    targets: () => null,
    selfId: 'self',
    table: new Map(),
    headings: async () => [],
    ownHeadings: async () => [],
    create: () => {},
    pick: () => {},
    choose: () => {},
  };
  const read = readProperties(splitFrontmatter(FRONTMATTER).frontmatter);
  const container = await render(
    <VisualSurface
      initial={`${MISSING_AND_AMBIGUOUS}\n${REFERENCES_IN_LINK}`}
      properties={read.ok ? read.properties : null}
      onChange={() => {}}
      links={links}
      attachments={{ list: [], url: async () => '' }}
      onFiles={() => {}}
    />,
  );
  await expect.poll(() => container.querySelectorAll('[data-wikilink]')).toHaveLength(3);

  expect(await hinted(container, '[data-wikilink="[[Nowhere]]"] > span')).toEqual({
    text: 'No page has this title yet',
    side: 'top',
  });
  // In a Markdown link's text, where the hint is on the text, as no button can be there.
  expect(await hinted(container, 'a [data-wikilink="[[Dal]]"] > span')).toEqual({
    text: 'More than one page has this title. Choose which page “Dal” means (Alt+Enter).',
    side: 'top',
  });
  // The chooser is a button, which keeps a button's side.
  expect(await hinted(container, '[data-wikilink="[[Dal]]"] > button')).toEqual({
    text: 'More than one page has this title. Choose which page “Dal” means (Alt+Enter).',
    side: 'bottom',
  });
  // References in a link's text: the value's chip, and a name not found.
  await expect
    .poll(() => container.querySelector('[data-hint="servings · property"]'))
    .not.toBeNull();
  expect(await hinted(container, '[data-hint="servings · property"]')).toEqual({
    text: 'servings · property',
    side: 'top',
  });
  expect(await hinted(container, '[data-hint="No property has this name"]')).toEqual({
    text: 'No property has this name',
    side: 'top',
  });
});

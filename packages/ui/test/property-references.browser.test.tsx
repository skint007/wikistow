import type { ClientContext, PageId, SpaceId } from '@wikistow/client';
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
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { Markdown } from '../src/page/markdown.tsx';

// References to the page's values in its body, as the reader draws them:
// the value as text or a link chip, never HTML made from it.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PAGE = `---
servings: 4
tags: [soup, bread]
created: 2026-10-12
goes_with: "[[Tomato soup]]"
empty:
evil: "<img src=x onerror=alert(1)> [x](javascript:alert(1)) *a* | \`b\`"
---
Serves \`=servings\`, tagged \`= this.tags\`, made \`=created\`, with \`=Goes With\`.

Then \`=evil\`, \`=nothing\`, \`=SUM(A1:A3)\` and [see \`=goes_with\`](https://example.com).

Empty: \`=empty\`.
`;

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

async function render(source: string, editing: boolean): Promise<HTMLElement> {
  const node: ReactNode = (
    <Markdown
      source={source}
      attachments={{
        ctx: {} as ClientContext,
        page: { spaceId: 's-home' as SpaceId, pageId: 'p-self' as PageId },
        audience: 'published',
        attachments: [],
      }}
      pages={[{ id: 'p-soup', title: 'Tomato soup', folders: [] }]}
      links={new Map()}
      editing={editing ? { parentId: null, create: false } : null}
    />
  );
  const rootRoute = createRootRoute({ component: () => node });
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/s/$spaceId/p/$pageId' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await expect.poll(() => container.querySelector('.page-body p')).not.toBeNull();
  return container;
}

const paragraphs = (container: HTMLElement) =>
  [...container.querySelectorAll('.page-body p')].map((p) => p.textContent);

describe('a reference to one of the page’s values', () => {
  it('shows the value, a list comma-separated and a date in the reader’s locale, with a hint', async () => {
    const container = await render(PAGE, false);
    expect(paragraphs(container)[0]).toBe(
      'Serves 4, tagged soup, bread, made Oct 12, 2026, with Tomato soup.',
    );
    const servings = [...container.querySelectorAll('[data-hint]')].find(
      (element) => element.textContent === '4',
    );
    expect(servings?.getAttribute('data-hint')).toBe('servings · property');
    expect(servings?.className).toContain('decoration-dotted');
    // A page link as a chip, but as text inside a link's own text.
    const chips = container.querySelectorAll<HTMLAnchorElement>(
      '.page-body a[href="/s/s-home/p/p-soup"]',
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe('Tomato soup');
    expect(container.querySelector('a[href="https://example.com"]')?.textContent).toBe(
      'see Tomato soup',
    );
    expect(paragraphs(container)[2]).toBe('Empty: –.');
  });

  it('makes no HTML from a value, only its text', async () => {
    const container = await render(PAGE, false);
    expect(container.querySelector('.page-body img')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.querySelector('.page-body em')).toBeNull();
    expect(paragraphs(container)[1]).toContain(
      'Then <img src=x onerror=alert(1)> [x](javascript:alert(1)) *a* | `b`,',
    );
  });

  it('shows a name no property has as written: inert code for readers, dashed for editors', async () => {
    const reader = await render(PAGE, false);
    const codes = [...reader.querySelectorAll('.page-body code')];
    expect(codes.map((code) => code.textContent)).toEqual(['=nothing', '=SUM(A1:A3)']);
    expect(codes[0]?.hasAttribute('data-hint')).toBe(false);
    expect(codes[0]?.className).toContain('text-muted-foreground');
    expect(codes[1]?.className).toBe('');

    const editor = await render(PAGE, true);
    const unknown = [...editor.querySelectorAll('.page-body code')][0];
    expect(unknown?.getAttribute('data-hint')).toBe('No property has this name');
    expect(unknown?.className).toContain('decoration-dashed');
  });

  it('shows every reference as written on a page with no properties to show', async () => {
    const container = await render('---\n- a list\n---\nServes `=servings`.\n', false);
    expect(paragraphs(container)).toEqual(['Serves =servings.']);
    expect(container.querySelector('.page-body code')?.textContent).toBe('=servings');
  });
});

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vite-plus/test';
import { userEvent } from 'vite-plus/test/browser/context';
import type { LinkAssist } from '../src/page/editor/surface.ts';

// A link's hint in the desktop app, placed in Chromium: above the link,
// where the pointer resting on its line of text doesn't cover it. So is a
// wikilink's source, its hint in the visual editor.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// As in the desktop app, which sets its bridge before the pages load.
window.wikistowDesktop = {} as NonNullable<Window['wikistowDesktop']>;
const { BodyLink } = await import('../src/page/body-link.tsx');
const { HintLayer } = await import('../src/components/ui/tooltip.tsx');
const { default: VisualSurface } = await import('../src/page/editor/visual/visual-surface.tsx');

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

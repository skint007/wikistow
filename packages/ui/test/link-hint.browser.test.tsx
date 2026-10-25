import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vite-plus/test';
import { userEvent } from 'vite-plus/test/browser/context';

// A link's hint in the desktop app, placed in Chromium: above the link,
// where the pointer resting on its line of text doesn't cover it.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// As in the desktop app, which sets its bridge before the pages load.
window.wikistowDesktop = {} as NonNullable<Window['wikistowDesktop']>;
const { BodyLink } = await import('../src/page/body-link.tsx');
const { HintLayer } = await import('../src/components/ui/tooltip.tsx');

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

it('shows a link hint above the link', async () => {
  const container = document.createElement('div');
  container.style.padding = '200px 40px';
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        <p>
          See <BodyLink href="https://example.com/docs">the docs</BodyLink> first.
        </p>
        <HintLayer />
      </>,
    ),
  );
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  const link = container.querySelector('a')!;
  await userEvent.hover(link);
  await expect.poll(() => document.querySelector('[data-slot="tooltip-content"]')).not.toBeNull();
  const hint = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')!;
  expect(hint.dataset['side']).toBe('top');
  expect(hint.getBoundingClientRect().bottom).toBeLessThanOrEqual(link.getBoundingClientRect().top);
});

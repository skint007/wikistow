import type { QuoteText } from '@wikistow/client';
import { TextSelection } from '@milkdown/kit/prose/state';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, expect, it } from 'vite-plus/test';
import { loadSyntaxNodes } from '../src/page/editor/visual/config.ts';
import VisualSurface from '../src/page/editor/visual/visual-surface.tsx';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import { viewOf } from './editor-view.ts';

// Comment in the visual editor's format toolbar (#667, ADR 0014 decision
// 13), in Chromium: there only where the page takes comments, dimmed with
// nothing or too much selected, and giving what the selection quotes.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

async function mount(
  initial: string,
  onComment: ((quote: QuoteText) => Promise<void>) | null,
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await loadSyntaxNodes();
  await act(async () =>
    root.render(
      <VisualSurface
        initial={initial}
        onChange={() => {}}
        links={{
          pages: [],
          targets: () => null,
          selfId: 'self',
          table: new Map(),
          headings: async () => [],
          ownHeadings: async () => [],
          create: () => {},
          pick: () => {},
          choose: () => {},
        }}
        attachments={{ list: [], url: async () => '' }}
        onFiles={() => {}}
        onUnfaithful={() => {}}
        onComment={onComment}
      />,
    ),
  );
  await act(() => expect.poll(() => container.querySelectorAll('.ProseMirror').length).toBe(1));
  const dom = container.querySelector<HTMLElement>('#page-visual');
  if (!dom) throw new Error('The editor did not mount');
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return dom;
}

/** Select from the first `start` to the end of the first `end` after it, or put the cursor at `start`. */
function select(dom: HTMLElement, start: string, end = start, cursor = false) {
  const view = viewOf(dom);
  const at = (text: string) => {
    let found = -1;
    view.state.doc.descendants((node, pos) => {
      const offset = node.isText ? (node.text?.indexOf(text) ?? -1) : -1;
      if (found < 0 && offset >= 0) found = pos + offset;
    });
    if (found < 0) throw new Error(`No text ${text}`);
    return found;
  };
  const from = at(start);
  const to = cursor ? from : at(end) + end.length;
  dom.focus();
  act(() =>
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))),
  );
}

const comment = () =>
  document
    .querySelector('[role="toolbar"][aria-label="Formatting"]')
    ?.querySelector<HTMLElement>('[aria-label="Comment on the selection"]') ?? null;

it('gives what the selection quotes, dimmed with nothing or too much selected', async () => {
  const quotes: QuoteText[] = [];
  const long = 'word '.repeat(120).trim();
  const dom = await mount(`Brown the mince with the onion.\n\n${long} last\n`, async (quote) => {
    quotes.push(quote);
  });
  const button = comment();
  expect(button).not.toBeNull();
  // In the toolbar, not over the text.
  expect(button?.closest('[role="toolbar"]')).not.toBeNull();

  // A cursor selects nothing.
  select(dom, 'mince', 'mince', true);
  await expect.poll(() => comment()?.getAttribute('aria-disabled')).toBe('true');
  expect(comment()?.getAttribute('data-hint')).toBe('Select text to comment on it');
  // Playwright won't press a dimmed control, which a person still can.
  act(() => comment()!.click());
  expect(quotes).toEqual([]);

  // More than 500 characters.
  select(dom, 'word', 'last');
  await expect
    .poll(() => comment()?.getAttribute('data-hint'))
    .toBe('Select at most 500 characters to comment on them');
  expect(comment()?.getAttribute('aria-disabled')).toBe('true');
  act(() => comment()!.click());
  expect(quotes).toEqual([]);

  select(dom, 'Brown', 'onion');
  await expect.poll(() => comment()?.getAttribute('aria-disabled')).toBe('false');
  await userEvent.click(comment()!);
  await expect.poll(() => quotes.length).toBe(1);
  expect(quotes[0]?.exact).toBe('Brown the mince with the onion');
  // The editor keeps its selection as the button is pressed.
  expect(String(getSelection())).toBe('Brown the mince with the onion');
});

it('shows no Comment where the page takes no comments on passages', async () => {
  await mount('Brown the mince.\n', null);
  expect(document.querySelector('[role="toolbar"][aria-label="Formatting"]')).not.toBeNull();
  expect(comment()).toBeNull();
});

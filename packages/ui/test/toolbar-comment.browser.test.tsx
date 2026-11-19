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

type OnComment = ((quote: QuoteText) => Promise<void>) | null;

/** The editor's element on `initial`, and a way to give it another `onComment`. */
async function mount(
  initial: string,
  onComment: OnComment,
): Promise<{ dom: HTMLElement; rerender: (onComment: OnComment) => Promise<void> }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await loadSyntaxNodes();
  const render = (onComment: OnComment) =>
    act(async () =>
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
  await render(onComment);
  await act(() => expect.poll(() => container.querySelectorAll('.ProseMirror').length).toBe(1));
  const dom = container.querySelector<HTMLElement>('#page-visual');
  if (!dom) throw new Error('The editor did not mount');
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { dom, rerender: render };
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
  const { dom } = await mount(
    `Brown the mince with the onion.\n\n${long} last\n`,
    async (quote) => {
      quotes.push(quote);
    },
  );
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

it('counts a selection only while it shows', async () => {
  const quotes: QuoteText[] = [];
  const { dom } = await mount('Brown the mince with the onion.\n', async (quote) => {
    quotes.push(quote);
  });
  const title = document.createElement('input');
  document.body.append(title);
  unmounts.push(() => title.remove());
  select(dom, 'Brown', 'onion');
  await expect.poll(() => comment()?.getAttribute('aria-disabled')).toBe('false');
  // Another field takes the focus; the editor keeps a selection nobody sees.
  act(() => title.focus());
  await expect.poll(() => comment()?.getAttribute('aria-disabled')).toBe('true');
  act(() => comment()!.click());
  expect(quotes).toEqual([]);
  // Nor once the focus reaches the toolbar from that field.
  act(() => comment()!.focus());
  await new Promise((done) => setTimeout(done, 200));
  expect(comment()?.getAttribute('aria-disabled')).toBe('true');
  act(() => comment()!.click());
  expect(quotes).toEqual([]);
  // Back in the editor, it counts again.
  act(() => dom.focus());
  await expect.poll(() => comment()?.getAttribute('aria-disabled')).toBe('false');
  // From the editor to the toolbar by keyboard, it still counts.
  act(() => comment()!.focus());
  await expect.poll(() => document.activeElement).toBe(comment());
  await new Promise((done) => setTimeout(done, 200));
  expect(comment()?.getAttribute('aria-disabled')).toBe('false');
  // Out of the window and back, as to another tab, it still counts.
  act(() => comment()!.blur());
  await expect.poll(() => comment()?.getAttribute('aria-disabled')).toBe('true');
  act(() => comment()!.focus());
  await expect.poll(() => comment()?.getAttribute('aria-disabled')).toBe('false');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => quotes.length).toBe(1);
});

it('leaves the toolbar a tab stop when Comment, the last one focused, goes', async () => {
  const { rerender } = await mount('Brown the mince.\n', async () => {});
  act(() => comment()!.focus());
  expect(comment()?.tabIndex).toBe(0);
  await rerender(null);
  expect(comment()).toBeNull();
  const bar = document.querySelector('[role="toolbar"][aria-label="Formatting"]')!;
  expect(bar.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  expect(bar.querySelector('[tabindex="0"]')?.getAttribute('aria-label')).toMatch(/^Text style/);
});

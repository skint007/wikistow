import { TextSelection } from '@milkdown/kit/prose/state';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import type { EditorSurfaceHandle } from '../src/page/editor/surface.ts';
import { loadSyntaxNodes } from '../src/page/editor/visual/config.ts';
import VisualSurface from '../src/page/editor/visual/visual-surface.tsx';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import { viewOf } from './editor-view.ts';

// Highlights and the theme's colours in the visual editor (#403), in
// Chromium: read from the page, typed, given by the toolbar and its
// shortcut, and written back as the page writes them.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Mounted = { dom: HTMLElement; changes: string[]; unfaithful: string[] };

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

async function mount(initial: string): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  const changes: string[] = [];
  const unfaithful: string[] = [];
  await loadSyntaxNodes();
  await act(async () =>
    root.render(
      <VisualSurface
        ref={ref}
        initial={initial}
        onChange={(markdown) => changes.push(markdown)}
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
        onUnfaithful={(markdown) => unfaithful.push(markdown)}
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
  return { dom, changes, unfaithful };
}

/** Select the first text `text` in the document, or put the cursor at its end with `cursor`. */
function select(m: Mounted, text: string, cursor = false) {
  const view = viewOf(m.dom);
  let from = -1;
  view.state.doc.descendants((node, pos) => {
    const at = node.isText ? (node.text?.indexOf(text) ?? -1) : -1;
    if (from < 0 && at >= 0) from = pos + at;
  });
  if (from < 0) throw new Error(`No text ${text}`);
  const to = from + text.length;
  m.dom.focus();
  act(() =>
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, cursor ? to : from, to)),
    ),
  );
}

/** The last Markdown the editor reported, once it's `expected`. */
const reported = (m: Mounted, expected: string) =>
  expect.poll(() => m.changes.at(-1)).toBe(expected);

const control = (label: string) => {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`No control ${label}`);
  return found;
};

/** Choose `item` in the colour menu's group `group` (Highlight, or Text colour). */
async function choose(group: string, item: string) {
  await userEvent.click(control('Highlight and text colour'));
  await expect
    .poll(() => document.querySelector(`[role="group"][aria-label="${group}"]`))
    .not.toBeNull();
  const items = document.querySelectorAll<HTMLElement>(
    `[role="group"][aria-label="${group}"] [role="menuitemradio"]`,
  );
  const found = [...items].find((each) => each.textContent?.trim().startsWith(item));
  if (!found) throw new Error(`No ${item} in ${group}`);
  await userEvent.click(found);
}

describe('highlights and colours in the visual editor', () => {
  it('show as the reader shows them, and an edit beside them writes them as written', async () => {
    const page =
      'A ==marked== word, <span data-color="red">red</span> and <mark data-color="blue">blue</mark>.\n';
    const m = await mount(page);
    expect(m.dom.querySelector('mark:not([data-color])')?.textContent).toBe('marked');
    expect(m.dom.querySelector('span[data-color="red"]')?.textContent).toBe('red');
    expect(m.dom.querySelector('mark[data-color="blue"]')?.textContent).toBe('blue');
    select(m, 'word', true);
    await userEvent.keyboard('s');
    await reported(m, page.replace('word,', 'words,'));
    expect(m.unfaithful).toEqual([]);
  });

  it('turn `==text==` typed into a highlight, and leave other `=` as typed', async () => {
    const m = await mount('');
    m.dom.focus();
    await userEvent.keyboard('==hi== then a == b and x==y');
    await reported(m, '==hi== then a == b and x\\=\\=y\n');
    expect(m.dom.querySelector('mark')?.textContent).toBe('hi');
    expect(m.unfaithful).toEqual([]);
  });

  it('highlight the selection with Ctrl+Shift+H, and take it off the same way', async () => {
    const m = await mount('Pick one word here.\n');
    select(m, 'word');
    await userEvent.keyboard('{Control>}{Shift>}h{/Shift}{/Control}');
    await reported(m, 'Pick one ==word== here.\n');
    expect(control('Highlight').getAttribute('aria-pressed')).toBe('true');
    await userEvent.keyboard('{Control>}{Shift>}h{/Shift}{/Control}');
    await reported(m, 'Pick one word here.\n');
  });

  it('keep bold around a highlight at its start as one', async () => {
    const m = await mount('Pick **one word** here.\n');
    select(m, 'one');
    await userEvent.keyboard('{Control>}{Shift>}h{/Shift}{/Control}');
    await reported(m, 'Pick **==one== word** here.\n');
    expect(m.unfaithful).toEqual([]);
  });

  it('give the selection a highlight and text colour from the toolbar', async () => {
    const m = await mount('Pick one word here.\n');
    select(m, 'word');
    await userEvent.click(control('Highlight'));
    await reported(m, 'Pick one ==word== here.\n');
    select(m, 'word');
    await choose('Highlight', 'Red');
    await reported(m, 'Pick one <mark data-color="red">word</mark> here.\n');
    select(m, 'word');
    await choose('Text colour', 'Blue');
    await reported(
      m,
      'Pick one <span data-color="blue"><mark data-color="red">word</mark></span> here.\n',
    );
    select(m, 'word');
    await choose('Highlight', 'No highlight');
    await reported(m, 'Pick one <span data-color="blue">word</span> here.\n');
    select(m, 'word');
    await choose('Text colour', 'Default');
    await reported(m, 'Pick one word here.\n');
    expect(m.unfaithful).toEqual([]);
  });

  it('give what’s typed next a colour at a cursor, and none in code', async () => {
    const m = await mount('Start\n\n```\ncode\n```\n');
    select(m, 'Start', true);
    await choose('Text colour', 'Green');
    await userEvent.keyboard(' green');
    // A colour's HTML holds the space typed in it, as `**` couldn't.
    await reported(m, 'Start<span data-color="green"> green</span>\n\n```\ncode\n```\n');
    select(m, 'code');
    expect(control('Highlight').getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(control('Highlight and text colour'));
    await expect.poll(() => document.querySelectorAll('[role="menuitemradio"]').length).toBe(15);
    for (const item of document.querySelectorAll('[role="menuitemradio"]'))
      expect(item.getAttribute('aria-disabled'), item.textContent ?? '').toBe('true');
  });
});

import type { Mark, Node } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import type { EditorSurfaceHandle } from '../src/page/editor/surface.ts';
import { loadSyntaxNodes, transformer } from '../src/page/editor/visual/config.ts';
import { fidelityOf, writesAsShown } from '../src/page/editor/visual/fidelity.ts';
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

/** Select `text` in the first block whose text holds it, across the marks in it. */
function selectAcross(m: Mounted, text: string) {
  const view = viewOf(m.dom);
  let from = -1;
  view.state.doc.descendants((node, pos) => {
    if (from >= 0 || !node.isTextblock) return from < 0;
    const at = node.textContent.indexOf(text);
    if (at >= 0) from = pos + 1 + at;
    return false;
  });
  if (from < 0) throw new Error(`No text ${text}`);
  m.dom.focus();
  act(() =>
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, from, from + text.length)),
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
    await userEvent.keyboard('==hi== then a == b ==> c and x==y');
    await reported(m, '==hi== then a == b ==> c and x==y\n');

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

  it('leave spaces at a mark’s ends out of it, however the marks around them part', async () => {
    const t = await transformer();
    for (const [page, text, keys, expected] of [
      ['one **two three**\n', 'one two', '{Control>}i{/Control}', '*one **two*** **three**\n'],
      [
        'Read the [setup guide](https://x.org) first.\n',
        'Read the setup',
        '{Control>}b{/Control}',
        '**Read the** [**setup** guide](https://x.org) first.\n',
      ],
      [
        'one **two three**\n',
        'one two',
        '{Control>}{Shift>}h{/Shift}{/Control}',
        '==one **two**== **three**\n',
      ],
    ] as const) {
      const m = await mount(page);
      selectAcross(m, text);
      await userEvent.keyboard(keys);
      await reported(m, expected);
      expect(fidelityOf(expected, t).visual, expected).toBe(true);
      unmounts.pop()?.();
    }
  });

  it('escape `==` in text only where it would pair with another', async () => {
    const t = await transformer();
    const { schema } = t.parse('x').type;
    const highlight = schema.marks['highlight']?.create();
    if (!highlight) throw new Error('No highlight');
    const paragraph = (...content: Node[]) =>
      schema.topNodeType.create(null, schema.node('paragraph', null, content));
    for (const [doc, written] of [
      [paragraph(schema.text('a ==> b')), 'a ==> b\n'],
      [paragraph(schema.text('if x==y then')), 'if x==y then\n'],
      // These two would make a highlight of `> b and x`.
      [paragraph(schema.text('a ==> b and x==y')), 'a \\=\\=> b and x\\=\\=y\n'],
      [paragraph(schema.text('x==y a==b c==d')), 'x\\=\\=y a\\=\\=b c\\=\\=d\n'],
      [
        paragraph(schema.text('x==y a'), schema.text('b c', [highlight]), schema.text('d')),
        'x\\=\\=y a==b c==d\n',
      ],
    ] as const) {
      expect(t.serialize(doc)).toBe(written);
      expect(writesAsShown(doc, written, t.parse)).toBe(true);
    }
    // Each block as it reads itself, and lists with the bullets they'd have.
    for (const page of [
      'if x==y then\n\na \\=\\=> b and x\\=\\=y\n',
      '- a==b\n- c==d\n',
      '1. x==y\n2. z\n',
      '- a\n\nx==y\n\n- b\n',
    ])
      expect(t.serialize(t.parse(page))).toBe(page);
  });

  it('leave a held space out of a mark before a soft line break', async () => {
    const t = await transformer();
    const { schema } = t.parse('x').type;
    const [strong, em, strike] = ['strong', 'emphasis', 'strike_through'].map((name) => {
      const mark = schema.marks[name]?.create();
      if (!mark) throw new Error(`No mark ${name}`);
      return mark;
    }) as [Mark, Mark, Mark];
    const soft = schema.nodes['hardbreak']?.create({ isInline: true });
    if (!soft) throw new Error('No line break');
    for (const [outer, written] of [
      [strong, '**a *b***\n*c*\n'],
      [strike, '~~a *b*~~\n*c*\n'],
    ] as const) {
      const doc = schema.topNodeType.create(
        null,
        schema.node('paragraph', null, [
          schema.text('a ', [outer]),
          schema.text('b', [outer, em]),
          schema.text(' ', [em]),
          soft.mark([em]),
          schema.text('c', [em]),
        ]),
      );
      expect(t.serialize(doc)).toBe(written);
    }
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

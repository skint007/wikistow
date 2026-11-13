import { splitFrontmatter } from '@wikistow/client';
import { undo } from '@milkdown/kit/prose/history';
import type { Node } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import { act, createRef, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';
import { unnumbered } from '../src/page/editor/visual/blocks.ts';
import { transformer } from '../src/page/editor/visual/config.ts';
import { fidelityOf, withLf, writesAsShown } from '../src/page/editor/visual/fidelity.ts';
import { inText, spansOf } from '../src/page/editor/visual/sources.ts';
import VisualSurface from '../src/page/editor/visual/visual-surface.tsx';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import { viewOf } from './editor-view.ts';

// The visual editor by block (ADR 0015 decision 3, step 2): each top-level
// block keeps the source it was read from until it's edited, and text from
// outside goes in a block at a time, as reading the page whole shows it.

const corpus = import.meta.glob<string>('../../client/test/corpus/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
});
const SOURCE_ONLY = new Set([
  '15-references.md',
  '16-unused-definition.md',
  '26-obsidian.md',
  '32-math-comments.md',
]);
const samples = Object.entries(corpus)
  .map(([path, markdown]) => ({ name: path.split('/').at(-1) ?? path, markdown }))
  .filter(({ name }) => !SOURCE_ONLY.has(name))
  .sort((a, b) => a.name.localeCompare(b.name))
  .flatMap(({ name, markdown }) => {
    const { body } = splitFrontmatter(markdown);
    return [
      { name, body },
      { name: `${name} (CRLF)`, body: body.replace(/\r?\n/g, '\r\n') },
    ];
  });

const links: LinkAssist = {
  pages: [],
  targets: () => null,
  selfId: 'self',
  table: new Map(),
  headings: async () => [],
  ownHeadings: async () => [],
  create: () => {},
  pick: () => {},
  choose: () => {},
};

type Mounted = {
  handle: EditorSurfaceHandle;
  /** Draw it again, with the page's line break now `lineBreak`. */
  breaks: (lineBreak: '\r\n' | '\n') => void;
  dom: HTMLElement;
  changes: string[];
  unfaithful: string[];
  unmount: () => void;
};

const mounted: Mounted[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function mount(initial: string, lineBreak?: '\r\n' | '\n'): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  const changes: string[] = [];
  const unfaithful: string[] = [];
  const attachments = { list: [], url: async () => null };
  const draw = (lineBreak?: '\r\n' | '\n') =>
    root.render(
      <StrictMode>
        <VisualSurface
          ref={ref}
          initial={initial}
          onChange={(markdown) => changes.push(markdown)}
          links={links}
          attachments={attachments}
          onFiles={() => {}}
          {...(lineBreak ? { lineBreak } : {})}
          onUnfaithful={(markdown) => unfaithful.push(markdown)}
        />
      </StrictMode>,
    );
  await act(async () => draw(lineBreak));
  await act(() => expect.poll(() => container.querySelectorAll('.ProseMirror').length).toBe(1));
  const dom = container.querySelector<HTMLElement>('#page-visual');
  if (!ref.current || !dom) throw new Error('The editor did not mount');
  // Made, and its first idle work done.
  await act(() => expect.poll(() => viewOf(dom).state.doc.childCount).toBeGreaterThan(0));
  let gone = false;
  const m: Mounted = {
    handle: ref.current,
    breaks: (lineBreak) => act(() => draw(lineBreak)),
    dom,
    changes,
    unfaithful,
    unmount: () => {
      if (gone) return;
      gone = true;
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(m);
  return m;
}

/** mulberry32: small, fast and the same everywhere. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// The first text node with `text` in it, and where `text` is in it.
function find(doc: Node, text: string): number {
  let at = -1;
  doc.descendants((node, pos) => {
    const i = node.isText ? (node.text ?? '').indexOf(text) : -1;
    if (at < 0 && i >= 0) at = pos + i;
  });
  if (at < 0) throw new Error(`No text ${text}`);
  return at;
}

// Insert `text` at `at` as the person types it, and wait for it to be reported.
async function typeAt(m: Mounted, at: number, text: string) {
  const view = viewOf(m.dom);
  const count = m.changes.length;
  act(() => view.dispatch(view.state.tr.insertText(text, at)));
  await expect.poll(() => m.changes.length).toBeGreaterThan(count);
  return m.changes.at(-1);
}

// Whether `m` shows what reading `markdown` whole shows. Its schema isn't
// the reader's here, so they're compared as JSON.
const showsAsRead = async (m: Mounted, markdown: string) => {
  const t = await transformer();
  const json = (doc: Node) => JSON.stringify(unnumbered(doc).toJSON());
  return json(viewOf(m.dom).state.doc) === json(t.parse(withLf(markdown)));
};

describe('where each block was read from', () => {
  it('reads each corpus page with where each top-level block is in its text, CRLF too', async () => {
    const t = await transformer();
    for (const { name, body } of samples) {
      const lf = withLf(body);
      const doc = t.parse(lf);
      const spans = spansOf(doc);
      expect(spans?.length, name).toBe(doc.childCount);
      const there = inText(body, spans ?? []);
      let last = 0;
      for (const [i, span] of (spans ?? []).entries()) {
        const raw = there[i];
        expect(span, `${name} block ${i}`).not.toBeNull();
        if (!span || !raw) continue;
        expect(span.from, name).toBeGreaterThanOrEqual(last);
        last = span.to;
        expect(withLf(body.slice(raw.from, raw.to)), name).toBe(lf.slice(span.from, span.to));
      }
    }
  });
});

describe('an edit in the visual editor', () => {
  // Written as no editor's style: a setext heading, `*` bullets, `_`, `__`
  // and a tilde fence, emoji, blank lines and CRLF.
  const PAGE = [
    'Title 🌱',
    '=======',
    '',
    '* one 🎉',
    '* two',
    '',
    '_emphasis_ and __strong__',
    '',
    '~~~',
    'code',
    '~~~',
    '',
    '',
    '',
    'Last',
  ].join('\r\n');

  it('writes only the block it changed, keeping the others byte for byte', async () => {
    const m = await mount(PAGE);
    const view = viewOf(m.dom);
    expect(await typeAt(m, view.state.doc.content.size - 1, ' more')).toBe(`${PAGE} more`);
    // The paragraph in the middle, written in the editor's style.
    const written = await typeAt(m, find(view.state.doc, 'emphasis') + 2, '!');
    expect(written).toBe(
      PAGE.replace('_emphasis_ and __strong__', '*em!phasis* and **strong**').concat(' more'),
    );
    // In a list, the list's.
    const listed = await typeAt(m, find(view.state.doc, 'one') + 3, '!');
    expect(listed).toBe(
      PAGE.replace('* one 🎉\r\n* two', '- one! 🎉\r\n- two')
        .replace('_emphasis_ and __strong__', '*em!phasis* and **strong**')
        .concat(' more'),
    );
    expect(m.unfaithful).toEqual([]);
  });

  it('keeps every corpus block it didn’t change as the page wrote it, LF and CRLF', async () => {
    const t = await transformer();
    for (const { name, body } of samples) {
      const m = await mount(body);
      const view = viewOf(m.dom);
      // Typed at the end of its first block's text.
      let at = -1;
      view.state.doc.firstChild?.descendants((node, pos) => {
        if (node.isTextblock && at < 0 && !node.type.spec.code)
          at = pos + 1 + node.content.size + 1;
      });
      if (at < 0) {
        m.unmount();
        continue;
      }
      const written = (await typeAt(m, at, 'x')) ?? '';
      // Each block after the first is where it was, as it was.
      const spans = inText(body, spansOf(t.parse(withLf(body))) ?? []);
      const rest = spans[1]?.from ?? body.length;
      expect(written.endsWith(body.slice(rest)), name).toBe(true);
      expect(m.unfaithful, name).toEqual([]);
      m.unmount();
    }
  });

  it('gives back the page as it was, byte for byte, once the edit is undone', async () => {
    const m = await mount(PAGE);
    const view = viewOf(m.dom);
    await typeAt(m, find(view.state.doc, 'two') + 3, '!');
    act(() => void undo(view.state, view.dispatch));
    expect(m.handle.read()).toBe(PAGE);
  });

  it('says where the cursor is in a block kept as written, past its atoms too', async () => {
    for (const lineBreak of ['\n', '\r\n']) {
      const page = ['Plan [[Plan]] P and *x*', '', 'Next', ''].join(lineBreak);
      const m = await mount(page);
      const view = viewOf(m.dom);
      await typeAt(m, find(view.state.doc, 'Next') + 4, '!');
      const end = (view.state.doc.firstChild?.nodeSize ?? 0) - 1;
      act(() =>
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end))),
      );
      expect(m.handle.caret?.(), JSON.stringify(lineBreak)).toBe('Plan [[Plan]] P and *x'.length);
      const p = find(view.state.doc, ' P');
      act(() =>
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, p + 2))),
      );
      expect(m.handle.caret?.()).toBe('Plan [[Plan]] P'.length);
      m.unmount();
    }
    // Not in a link's address.
    const m = await mount('[x](https://y.org/abc) abc\n\nNext\n');
    const view = viewOf(m.dom);
    await typeAt(m, find(view.state.doc, 'Next') + 4, '!');
    const end = (view.state.doc.firstChild?.nodeSize ?? 0) - 1;
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end))));
    expect(m.handle.caret?.()).toBe('[x](https://y.org/abc) abc'.length);
  });

  it('writes a page with no text yet in the frontmatter’s line breaks', async () => {
    for (const body of ['', '\r\n\r\n']) {
      const m = await mount(body, '\r\n');
      const view = viewOf(m.dom);
      const { schema } = view.state;
      const paragraph = (text: string) => schema.node('paragraph', null, schema.text(text));
      act(() =>
        view.dispatch(
          view.state.tr.replaceWith(0, view.state.doc.content.size, [
            paragraph('a'),
            paragraph('b'),
          ]),
        ),
      );
      await expect
        .poll(() => m.changes.at(-1), { message: JSON.stringify(body) })
        .toBe('a\r\n\r\nb\r\n');
      m.unmount();
    }
    // Given later, as frontmatter is added, too.
    const m = await mount('', '\n');
    m.breaks('\r\n');
    const view = viewOf(m.dom);
    const { schema } = view.state;
    const paragraph = (text: string) => schema.node('paragraph', null, schema.text(text));
    act(() =>
      view.dispatch(
        view.state.tr.replaceWith(0, view.state.doc.content.size, [paragraph('a'), paragraph('b')]),
      ),
    );
    await expect.poll(() => m.changes.at(-1)).toBe('a\r\n\r\nb\r\n');
  });

  it('keeps blank lines before the first block and after the last, either edited', async () => {
    const m = await mount('\n\nA\n\nB\n\n\n');
    const view = viewOf(m.dom);
    expect(await typeAt(m, find(view.state.doc, 'B') + 1, '!')).toBe('\n\nA\n\nB!\n\n\n');
    expect(await typeAt(m, find(view.state.doc, 'A') + 1, '!')).toBe('\n\nA!\n\nB!\n\n\n');
    expect(m.unfaithful).toEqual([]);
  });

  it('keeps a block’s indent, which is part of what it says, wherever it goes', async () => {
    for (const [page, kept] of [
      ['Para.\n\n  ```\n  code\n  ```\n', '  ```\n  code\n  ```\n'],
      ['Para.\n\n  - a\n\n        b\n', '  - a\n\n        b\n'],
    ] as const) {
      const m = await mount(page);
      const view = viewOf(m.dom);
      const first = view.state.doc.firstChild?.nodeSize ?? 0;
      act(() => view.dispatch(view.state.tr.delete(0, first)));
      await expect.poll(() => m.changes.at(-1), { message: page }).toBe(kept);
      expect(m.unfaithful, page).toEqual([]);
      m.unmount();
    }
  });
});

describe('text taken in by block', () => {
  const PAGES = ['One.\n\nTwo.\n\nThree.\n\nFour.\n', PAGE_OF('\r\n')];
  function PAGE_OF(lineBreak: string) {
    return [
      '# Head',
      '',
      'A *b* c.',
      '',
      '* x',
      '* y',
      '',
      'More.',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
    ].join(lineBreak);
  }

  it('shows a change to a block as reading the page whole does, reading only what changed', async () => {
    for (const page of PAGES) {
      const m = await mount(page);
      const view = viewOf(m.dom);
      const before = view.state.doc;
      const next = page.replace('Two.', 'Two, changed.').replace('A *b* c.', 'A *b* changed.');
      expect(m.handle.take?.(next), page).toBe(true);
      expect(m.handle.read()).toBe(next);
      expect(await showsAsRead(m, next)).toBe(true);
      // The blocks it didn't change are the very ones it had.
      const after = view.state.doc;
      expect(after.lastChild).toBe(before.lastChild);
      expect(m.changes).toEqual([]);
    }
  });

  it('takes in random changes as reading each corpus page whole does, LF and CRLF', async () => {
    const t = await transformer();
    const rng = random(20_261_112);
    const tokens = [
      ' word',
      'x',
      '\n\n',
      '\n',
      '*',
      '**',
      '- ',
      '1. ',
      '# ',
      '`',
      '> ',
      '|',
      '[[Plan]]',
      '🌱',
      '\\',
      '',
    ];
    let taken = 0;
    let edits = 0;
    for (const { name, body } of samples) {
      const m = await mount(body);
      let text = body;
      for (let i = 0; i < 12; i++) {
        const at = Math.floor(rng() * (text.length + 1));
        const cut = rng() < 0.3 ? Math.floor(rng() * 12) : 0;
        const token = tokens[Math.floor(rng() * tokens.length)] ?? '';
        const next = text.slice(0, at) + token + text.slice(at + cut);
        const where = `${name}, edit ${i}: ${JSON.stringify(token)} at ${at}, ${cut} cut`;
        // As the page editor would, only text the visual editor keeps whole.
        const kept = fidelityOf(next, t).visual;
        if (!kept) continue;
        edits++;
        let by = false;
        act(() => void (by = m.handle.take?.(next) ?? false));
        if (by) taken++;
        else act(() => m.handle.replace(next));
        expect(m.handle.read(), where).toBe(next);
        expect(await showsAsRead(m, next), where).toBe(true);
        text = next;
      }
      expect(m.changes, name).toEqual([]);
      m.unmount();
    }
    // Most go in a block at a time.
    expect(taken).toBeGreaterThan(edits * 0.5);
  });

  it('takes a line added at a block’s end in by block, as a new item, row or line', async () => {
    for (const lineBreak of ['\n', '\r\n']) {
      const lines = (...all: string[]) => all.join(lineBreak);
      const page = lines(
        'Intro.',
        '',
        '* one',
        '* two',
        '',
        'Para line',
        '',
        '| a | b |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '> quote',
        '',
        'End.',
        '',
      );
      for (const next of [
        page.replace(`* two`, lines('* two', '* t')),
        page.replace('Para line', lines('Para line', 'more')),
        page.replace('| 1 | 2 |', lines('| 1 | 2 |', '| 3 | 4 |')),
        page.replace('> quote', lines('> quote', '> more')),
        page.replace('Intro.', lines('Before', '', 'Intro.')),
      ]) {
        const m = await mount(page);
        expect(m.handle.take?.(next), JSON.stringify(next)).toBe(true);
        expect(m.handle.read()).toBe(next);
        expect(await showsAsRead(m, next), JSON.stringify(next)).toBe(true);
        m.unmount();
      }
    }
  });

  it('reads the page whole where a change reaches past its block', async () => {
    const page = 'One[^a].\n\n- a\n\nTwo.\n\nThree.\n\n[^a]: Note.\n\nFour.\n';
    for (const next of [
      // A fence or HTML left open, which takes in what follows.
      page.replace('Two.', '```\nTwo.'),
      page.replace('Two.', '<!-- Two.'),
      // A footnote defined, or no longer.
      page.replace('Three.', '[^b]: Three.'),
      page.replace('[^a]: Note.\n\n', ''),
      // A block that joins the one before it.
      page.replace('Two.', '- Two.'),
      page.replace('Two.', '  Two.'),
      // Much text new at once.
      page.replace('Two.', `Two ${'long '.repeat(250)}.`),
      // A change in a block so long it's checked off the page's thread.
      page.replace('- a', Array.from({ length: 1_500 }, (_, i) => `- item ${i}`).join('\n')),
    ]) {
      const m = await mount(page);
      expect(m.handle.take?.(next), next).toBe(false);
      expect(m.handle.read(), next).toBe(page);
      act(() => m.handle.replace(next));
      expect(m.handle.read(), next).toBe(next);
      expect(await showsAsRead(m, next), next).toBe(true);
      m.unmount();
    }
  });

  it('reads the page whole where a change is beside a long block, which would be slow to read again', async () => {
    const list = Array.from({ length: 1_500 }, (_, i) => `- item ${i}`).join('\n');
    const page = `One.\n\n${list}\n\nTwo.\n\nThree.\n`;
    const m = await mount(page);
    const next = page.replace('Two.', 'Two, changed.');
    expect(m.handle.take?.(next)).toBe(false);
    act(() => m.handle.replace(next));
    expect(m.handle.read()).toBe(next);
    expect(await showsAsRead(m, next)).toBe(true);
    // Away from it, a block at a time.
    expect(m.handle.take?.(next.replace('Three.', 'Three, changed.'))).toBe(true);
  });

  it('takes nothing it wouldn’t keep whole, such as a reference link', async () => {
    const m = await mount('One.\n\nTwo.\n\nThree.\n');
    expect(m.handle.take?.('One.\n\n[a][r]\n\n[r]: https://example.test/\n\nThree.\n')).toBe(false);
    expect(m.handle.read()).toBe('One.\n\nTwo.\n\nThree.\n');
  });

  it('keeps the cursor where it was, and the change out of undo history', async () => {
    const m = await mount('One.\n\nTwo.\n\nThree.\n');
    const view = viewOf(m.dom);
    await typeAt(m, find(view.state.doc, 'Three') + 5, ' more');
    act(() =>
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, find(view.state.doc, 'hree')),
        ),
      ),
    );
    expect(m.handle.take?.('One, from outside.\n\nTwo.\n\nThree more.\n')).toBe(true);
    const { selection, doc } = view.state;
    expect(doc.textBetween(selection.head, selection.head + 4)).toBe('hree');
    // Undo takes back the person's edit, not the change.
    act(() => void undo(view.state, view.dispatch));
    expect(view.state.doc.textContent).toBe('One, from outside.Two.Three.');
  });

  it('writes anew a block taken in that shows other than as read', async () => {
    const t = await transformer();
    const page = 'Intro\n\nMid\n\n| A | B |\n| --- | --- |\n| a | b |\n';
    const m = await mount(page);
    act(() => void m.handle.take?.(page.replace('| a | b |', '\t| a | b |')));
    const view = viewOf(m.dom);
    const written = (await typeAt(m, find(view.state.doc, 'Intro') + 5, '!')) ?? '';
    // What it writes reads as it shows, or it says it doesn't.
    if (m.unfaithful.length === 0)
      expect(writesAsShown(view.state.doc, withLf(written), t.parse)).toBe(true);
  });

  it('keeps blocks taken in as written there, as they were given', async () => {
    const m = await mount('One.\n\nTwo.\n');
    const next = 'One.\n\nTitle\n=====\n\n* a\n* b\n\nTwo.\n';
    expect(m.handle.take?.(next)).toBe(true);
    const view = viewOf(m.dom);
    expect(await typeAt(m, find(view.state.doc, 'Two') + 3, '!')).toBe(
      next.replace('Two.', 'Two!.'),
    );
  });
});

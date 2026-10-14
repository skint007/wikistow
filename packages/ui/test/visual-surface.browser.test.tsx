import { splitFrontmatter, type AttachmentRef, type LinkablePage } from '@wikistow/client';
import { joinBackward } from '@milkdown/kit/prose/commands';
import { Fragment, Slice, type Node } from '@milkdown/kit/prose/model';
import { AllSelection, TextSelection } from '@milkdown/kit/prose/state';
import { act, createRef, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';
import { transformer, writingLiterals } from '../src/page/editor/visual/config.ts';
import { fidelityOf, withLf, writesAsShown } from '../src/page/editor/visual/fidelity.ts';
import VisualSurface from '../src/page/editor/visual/visual-surface.tsx';
import { Writer } from '../src/page/editor/visual/writer.ts';
// The app's stylesheet brings it; without it, spaces typed at a line's end collapse.
import '@milkdown/kit/prose/view/style/prosemirror.css';
import { viewOf } from './editor-view.ts';
// What Word puts on the clipboard: its styles, list paragraphs and conditional comments.
import WORD from './word-paste.html?raw';

// The real visual surface, in Chromium: an unchanged document gives back
// the page's exact bytes, and edits come back as Markdown the reader reads
// the same way.

const corpus = import.meta.glob<string>('../../client/test/corpus/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
});
const samples = Object.entries(corpus)
  .map(([path, markdown]) => ({ name: path.split('/').at(-1) ?? path, markdown }))
  .sort((a, b) => a.name.localeCompare(b.name));

const pages: LinkablePage[] = [
  { id: 'self', title: 'Garden', folders: [] },
  { id: 'plan', title: 'Plan', folders: [] },
  { id: 'notes-work', title: 'Notes', folders: ['Work'] },
  { id: 'notes-home', title: 'Notes', folders: ['Home'] },
];

const links: LinkAssist = {
  pages,
  targets: () => null,
  selfId: 'self',
  table: new Map(),
  headings: async () => [],
  ownHeadings: async () => [],
  create: () => {},
  pick: () => {},
  choose: () => {},
};

// A 1×1 PNG.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);
const picture = { id: 'a1', name: 'bed.png', mediaType: 'image/png', size: 70 } as AttachmentRef;

type Mounted = {
  handle: EditorSurfaceHandle;
  dom: HTMLElement;
  changes: string[];
  /** Each time it said the person edited: how many edits it had reported then. */
  editing: number[];
  uploads: { files: File[]; place: (markdown: string) => boolean }[];
  /** What it wrote that doesn't read as it shows. */
  unfaithful: string[];
  unmount: () => void;
};

const mounted: Mounted[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function mount(
  initial: string,
  // Done as soon as it's on screen, maybe before the editor is made.
  first?: (handle: EditorSurfaceHandle) => void,
): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  const changes: string[] = [];
  const editing: number[] = [];
  const uploads: Mounted['uploads'] = [];
  const unfaithful: string[] = [];
  const attachments = {
    list: [picture],
    url: async () => URL.createObjectURL(new Blob([PNG], { type: 'image/png' })),
  };
  // Strict Mode makes the editor twice; one stays. It's made a moment later.
  await act(async () =>
    root.render(
      <StrictMode>
        <VisualSurface
          ref={ref}
          initial={initial}
          onChange={(markdown) => changes.push(markdown)}
          onEditing={() => editing.push(changes.length)}
          links={links}
          attachments={attachments}
          onFiles={(files, place) => uploads.push({ files, place })}
          onUnfaithful={(markdown) => unfaithful.push(markdown)}
        />
      </StrictMode>,
    ),
  );
  if (first && ref.current) act(() => first(ref.current as EditorSurfaceHandle));
  // The first loads Milkdown, which takes a while under load.
  await act(() => expect.poll(() => container.querySelectorAll('.ProseMirror').length).toBe(1));
  const dom = container.querySelector<HTMLElement>('#page-visual');
  if (!ref.current || !dom) throw new Error('The editor did not mount');
  let gone = false;
  const m: Mounted = {
    handle: ref.current,
    dom,
    changes,
    editing,
    uploads,
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

/** Type `text` as it is: brackets and braces aren't keys to press. */
const type = (text: string) => userEvent.keyboard(text.replace(/[[{]/g, '$&$&'));

/**
 * Put the cursor at the end of the document, read by ProseMirror at once,
 * and type `text`. Moved by a key, it's read a moment later, and a change
 * shown meanwhile, or the editor's being focused, puts it back.
 */
async function typeAtEnd(m: Mounted, text: string) {
  m.dom.focus();
  getSelection()?.selectAllChildren(m.dom);
  getSelection()?.collapseToEnd();
  document.dispatchEvent(new Event('selectionchange'));
  if (text) await type(text);
}

/** Paste `data`, by type, and `files`. */
const paste = (m: Mounted, data: Record<string, string>, files: File[] = []) => {
  const transfer = new DataTransfer();
  for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
  for (const file of files) transfer.items.add(file);
  m.dom.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
  );
};

/** Copy all of `m`, as Ctrl+A then Ctrl+C would. */
const copyAll = (m: Mounted) => {
  const view = viewOf(m.dom);
  act(() => view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc))));
  const copied = new DataTransfer();
  m.dom.dispatchEvent(
    new ClipboardEvent('copy', { clipboardData: copied, bubbles: true, cancelable: true }),
  );
  return copied;
};

// The images shown, not the ones ProseMirror puts beside atoms for the cursor.
const images = (m: Mounted) => [...m.dom.querySelectorAll('img:not(.ProseMirror-separator)')];

// The samples the visual editor would change: reference links, a callout
// title and comments.
const SOURCE_ONLY = [
  '15-references.md',
  '16-unused-definition.md',
  '26-obsidian.md',
  '32-math-comments.md',
];

// The samples the visual editor opens, as one page.
const corpusPage = () =>
  samples
    .filter(({ name }) => !SOURCE_ONLY.includes(name))
    .map(({ markdown }) => withLf(splitFrontmatter(markdown).body))
    .join('\n\n');

describe('the fidelity check', () => {
  it('keeps in source mode only the corpus samples the visual editor would change', async () => {
    const t = await transformer();
    const kept = samples
      .filter(({ markdown }) => !fidelityOf(splitFrontmatter(markdown).body, t).visual)
      .map(({ name }) => name);
    expect(kept).toEqual(SOURCE_ONLY);
  });

  it('keeps Obsidian syntax that Markdown reads as text in source mode', async () => {
    const t = await transformer();
    const visual = (body: string) => fidelityOf(body, t).visual;
    for (const body of [
      '> [!note] Title\n> body\n',
      'Speed is $v = d / t$ here.\n',
      'Hidden %%note%% text\n',
      '#project starts a line\n',
      '==marked== starts a line\n',
      '[a][r]\n\n[r]: https://example.test\n',
    ])
      expect(visual(body), body).toBe(false);
    // Text Markdown writes back the same stays visual.
    for (const body of [
      'A #tag mid-line, $5 and $10, ==marked== and ^block\n',
      '> [!NOTE]\n> body\n',
    ])
      expect(visual(body), body).toBe(true);
  });
});

describe('writing an edit', () => {
  // The first text node that is `text`, as a range.
  const find = (doc: Node, text: string) => {
    let at = -1;
    doc.descendants((node, pos) => {
      if (at < 0 && node.isText && node.text === text) at = pos;
    });
    if (at < 0) throw new Error(`No text ${text}`);
    return { from: at, to: at + text.length };
  };
  const without = (doc: Node, text: string) => {
    const { from, to } = find(doc, text);
    return doc.replace(from, to, Slice.empty);
  };
  const insert = (doc: Node, at: number, nodes: Node | Node[]) =>
    doc.replace(at, at, new Slice(Fragment.from(nodes), 0, 0));

  it('turns away what Markdown can’t hold as it shows', async () => {
    const t = await transformer();
    const { schema } = t.parse('x').type;
    // A list item's first paragraph emptied, its blocks then out of it.
    expect(writesAsShown(without(t.parse('- a\n\n  b\n'), 'a'), '-\n\n  b\n', t.parse)).toBe(false);
    // Spaces starting a line, or before a soft line break, which two make hard.
    const spaced = insert(t.parse('**bold**\n'), 1, schema.text('    '));
    expect(writesAsShown(spaced, '    **bold**\n', t.parse)).toBe(false);
    const soft = t.parse('**x**\nnext\n');
    const hard = insert(soft, find(soft, 'x').to, schema.text('  '));
    expect(writesAsShown(hard, '**x**  \nnext\n', t.parse)).toBe(false);
    // Code in a table cell with a backslash before a bar, which GFM can't hold:
    // a cell reads `\|` in code as the bar, and `\\` as both backslashes.
    const table = t.parse('| a |\n| - |\n| `x` |\n');
    const { from, to } = find(table, 'x');
    const code = schema.marks['inlineCode']?.create();
    const text = schema.text('a\\|b', code ? [code] : []);
    const cell = table.replace(from, to, new Slice(Fragment.from(text), 0, 0));
    expect(writesAsShown(cell, t.serialize(cell), t.parse)).toBe(false);
    // One link written as two, or two as one, whatever ids they have.
    const strong = schema.marks['strong']?.create();
    const link = schema.marks['link']?.create({ href: 'https://bank.example.evil.example' });
    if (!strong || !link) throw new Error('No marks');
    const boldStart = schema.topNodeType.create(
      null,
      schema.node('paragraph', null, [
        schema.text('https://bank.example', [strong, link]),
        schema.text('.evil.example', [link]),
      ]),
    );
    const two =
      '**[https://bank.example](https://bank.example.evil.example)**[.evil.example](https://bank.example.evil.example)\n';
    expect(writesAsShown(boldStart, two, t.parse)).toBe(false);
    expect(writesAsShown(t.parse(two), two, t.parse)).toBe(true);
    expect(writesAsShown(t.parse('[a](u)[b](u)\n'), '[ab](u)\n', t.parse)).toBe(false);
  });
});

describe('writing a block at a time', () => {
  it('writes each corpus page as writing it whole would, and finds it reads as it shows', async () => {
    const t = await transformer();
    for (const { name, markdown } of samples) {
      if (SOURCE_ONLY.includes(name)) continue;
      const doc = t.parse(withLf(splitFrontmatter(markdown).body));
      const written = new Writer(t).write(doc);
      expect(written.markdown, name).toBe(writingLiterals(() => t.serialize(doc)).written);
      expect(written.faithful, name).toBe(true);
    }
  });

  it('reads blocks beside each other, as HTML left open takes the next', async () => {
    const t = await transformer();
    const open = t.parse('<!-- note\n');
    const doc = open.replace(
      open.content.size,
      open.content.size,
      new Slice(t.parse('After\n').content, 0, 0),
    );
    const written = new Writer(t).write(doc);
    expect(written.markdown).toBe(t.serialize(doc));
    expect(written.faithful).toBe(false);
    // Checked against the page it was put in, on a page not yet read, the same.
    const base = t.parse('One.\n\nTwo.\n');
    const at = base.child(0).nodeSize;
    const put = base.replace(at, at, new Slice(t.parse('<!-- open\n').content, 0, 0));
    expect(new Writer(t).check(put, base)).toBe(false);
    // A footnote named in one block and defined in another is one.
    const notes = t.parse('One[^a].\n\nTwo.\n\n[^a]: Note.\n');
    expect(new Writer(t).write(notes).faithful).toBe(true);
  });

  it('reads the last block with the line break a writing ends with, as HTML left open takes it', async () => {
    const t = await transformer();
    for (const [page, faithful] of [
      ['Text\n\n<!-- note', false],
      ['Text\n\n<!-- note -->', true],
    ] as const) {
      const doc = t.parse(page);
      const written = new Writer(t).write(doc);
      expect(written.faithful, page).toBe(faithful);
      expect(writesAsShown(doc, written.markdown, t.parse), page).toBe(faithful);
      // With no final line break, as a page that has none is written, it's
      // read as that, where nothing takes it in.
      const bare = new Writer(t).write(doc, false);
      expect(bare.markdown, page).toBe(written.markdown.replace(/\n$/, ''));
      expect(bare.faithful, page).toBe(true);
      expect(writesAsShown(doc, bare.markdown, t.parse), page).toBe(true);
      // Put at the end, as a paste is.
      const base = t.parse('Text\n');
      const end = base.content.size;
      const put = base.replace(end, end, new Slice(t.parse(page).content, 0, 0));
      expect(new Writer(t).check(put, base), page).toBe(faithful);
    }
  });

  it('writes empty paragraphs, which write as nothing, a block at a time too', async () => {
    const t = await transformer();
    const page = Array.from({ length: 300 }, (_, i) => `Line ${i}.`).join('\n\n');
    const writer = new Writer(t);
    let doc = t.parse(page);
    writer.write(doc);
    const empty = () => doc.type.schema.nodes['paragraph']?.create() ?? doc;
    const lists = [...t.parse('- a\n').content.content];
    // Each before the top-level block at an index, or at the end.
    const edits: [number, Node[]][] = [
      [0, [empty()]],
      [150, [empty(), empty()]],
      // Lists apart only by an empty paragraph are next to each other once written.
      [Infinity, lists],
      [Infinity, [empty(), ...lists]],
    ];
    for (const [index, nodes] of edits) {
      let at = 0;
      doc.forEach((node, offset, i) => {
        if (i < index) at = offset + node.nodeSize;
      });
      doc = doc.replace(at, at, new Slice(Fragment.from(nodes), 0, 0));
      const markdown = writingLiterals(() => t.serialize(doc)).written;
      expect(writer.write(doc)).toEqual({ markdown, faithful: true });
    }
    expect(writer.write(doc).markdown).toMatch(/^Line 0\.\n[^]*\n- a\n\n\* a\n$/);
  });

  it('writes a block a document has more than once a block at a time, as a copy dragged is', async () => {
    const t = await transformer();
    const [one, two, three] = t.parse('One.\n\nTwo.\n\nThree.\n').content.content;
    const empty = one?.type.create();
    if (!one || !two || !three || !empty) throw new Error('No blocks');
    // `One.` after two blocks, and alone and with an empty paragraph after it.
    const doc = t.parse('').type.create(null, [one, two, one, three, one, empty]);
    expect(new Writer(t).write(doc)).toEqual({
      markdown: 'One.\n\nTwo.\n\nOne.\n\nThree.\n\nOne.\n',
      faithful: true,
    });
  });
});

describe('the visual surface', () => {
  it('gives back every corpus sample it opens exactly, reporting no edit', async () => {
    for (const { name, markdown } of samples) {
      if (SOURCE_ONLY.includes(name)) continue;
      const { body } = splitFrontmatter(markdown);
      const m = await mount(body);
      expect(m.handle.read(), name).toBe(body);
      expect(m.changes, name).toEqual([]);
      m.unmount();
    }
  });

  it('writes an edit in the page’s line breaks, with no final one if it had none', async () => {
    const m = await mount('One\r\n\r\nTwo');
    await typeAtEnd(m, ' more');
    await expect.poll(() => m.changes.at(-1)).toBe('One\r\n\r\nTwo more');
    expect(m.handle.read()).toBe('One\r\n\r\nTwo more');
  });

  it('opens each corpus sample written in CRLF, giving it back unchanged and editing it in CRLF', async () => {
    const t = await transformer();
    for (const { name, markdown } of samples) {
      if (SOURCE_ONLY.includes(name)) continue;
      const body = splitFrontmatter(markdown).body.replace(/\r?\n/g, '\r\n');
      expect(fidelityOf(body, t), name).toEqual({ visual: true });
      const m = await mount(body);
      expect(m.handle.read(), name).toBe(body);
      await typeAtEnd(m, 'x');
      await expect.poll(() => m.handle.read(), { message: name }).not.toBe(body);
      const edited = m.handle.read();
      expect(edited.replace(/\r\n/g, ''), name).not.toMatch(/[\r\n]/);
      expect(fidelityOf(edited, t), name).toEqual({ visual: true });
      m.unmount();
    }
  });

  it('gives back the original bytes once an edit is undone', async () => {
    const text = 'Title\n=====\n\n* one\n* two\n';
    const m = await mount(text);
    await typeAtEnd(m, 'x');
    await expect.poll(() => m.handle.read()).not.toBe(text);
    await userEvent.keyboard('{Control>}z{/Control}');
    await expect.poll(() => m.handle.read()).toBe(text);
  });

  // Its read back alone may take 30 s on a busy runner.
  it(
    'writes and reads whole an edit on a long page not yet read back, if the page is hidden first',
    { timeout: 60_000 },
    async () => {
      const t = await transformer();
      const chunk = corpusPage();
      const body = Array.from({ length: Math.ceil(100_000 / chunk.length) }, () => chunk).join(
        '\n\n',
      );
      // Its first block written as typed would link `https://x.org\`: only
      // reading it back finds it must be written otherwise.
      const page = `See https://x.org_ and more.\n\n${body}\n\nEnd\n`;
      const m = await mount(page);
      const view = viewOf(m.dom);
      await typeAtEnd(m, ' more ');
      paste(m, { 'text/plain': '*word*' });
      expect(view.state.doc.lastChild?.textContent).toBe('End more word');
      expect(m.changes).toEqual([]);
      // Hidden, as when the tab closes, it's written and read whole at once.
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      expect(m.changes).toHaveLength(1);
      expect(m.changes[0]).toMatch(/^See <https:\/\/x\.org>\\_ and more\.\n/);
      expect(writesAsShown(view.state.doc, withLf(m.changes[0] ?? ''), t.parse)).toBe(true);
    },
  );

  it('reports an edit as soon as the page is hidden', async () => {
    const m = await mount('Start.\n');
    await typeAtEnd(m, ' more');
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(m.changes.at(-1)).toBe('Start. more\n');
  });

  it('reports its last edit as it unmounts', async () => {
    const m = await mount('Draft');
    await typeAtEnd(m, '!');
    m.unmount();
    expect(m.changes.at(-1)).toBe('Draft!');
  });

  it('shows a renamed link without reporting an edit', async () => {
    const m = await mount('See [[Old]] first.\n');
    act(() => m.handle.replace('See [[New title]] first.\n'));
    expect(m.handle.read()).toBe('See [[New title]] first.\n');
    expect(m.dom.querySelector('[data-wikilink]')?.getAttribute('data-wikilink')).toBe(
      '[[New title]]',
    );
    expect(m.changes).toEqual([]);
  });

  it('says at once that the person edited, before it reports the edit', async () => {
    const m = await mount('One\n');
    const view = viewOf(m.dom);
    act(() => view.dispatch(view.state.tr.insertText(' more', view.state.doc.content.size - 1)));
    expect(m.editing).toEqual([0]);
    await expect.poll(() => m.changes.at(-1)).toBe('One more\n');
  });

  it('shows text it was given while the editor was being made', async () => {
    const m = await mount('See [[Old]]\n', (handle) => handle.replace('See [[New]]\n'));
    await expect
      .poll(() => m.dom.querySelector('[data-wikilink]')?.getAttribute('data-wikilink'))
      .toBe('[[New]]');
    expect(m.handle.read()).toBe('See [[New]]\n');
    expect(m.changes).toEqual([]);
  });

  describe('autolinks', () => {
    const links = (m: Mounted) =>
      [...m.dom.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);

    it('links an address typed where the reader would, writing it as typed', async () => {
      for (const [typed, shown] of [
        [
          ' See https://example.com/a for more.',
          [['https://example.com/a', 'https://example.com/a']],
        ],
        [' Mail me@example.com.', [['me@example.com', 'mailto:me@example.com']]],
      ] as const) {
        const m = await mount('Start.\n');
        await typeAtEnd(m, typed);
        await expect.poll(() => m.handle.read(), { message: typed }).toBe(`Start.${typed}\n`);
        expect(links(m), typed).toEqual(shown);
        await act(async () => {});
        expect(m.unfaithful, typed).toEqual([]);
        m.unmount();
      }
    });

    it('keeps a link of the page’s own where it goes, as written, whatever is typed beside it', async () => {
      const t = await transformer();
      const m = await mount('<https://bank.example>.evil.example\n');
      await typeAtEnd(m, ' and www.more.example');
      await expect
        .poll(() => m.handle.read())
        .toBe('<https://bank.example>.evil.example and www.more.example\n');
      expect(links(m)).toEqual([
        ['https://bank.example', 'https://bank.example'],
        ['www.more.example', 'http://www.more.example'],
      ]);
      await act(async () => {});
      const view = viewOf(m.dom);
      expect(writesAsShown(view.state.doc, m.handle.read(), t.parse)).toBe(true);
      expect(m.unfaithful).toEqual([]);
    });

    it('takes a link of the page’s own where its text says, edited inside, over just its text', async () => {
      const t = await transformer();
      const exazmple = [['https://exazmple.com', 'https://exazmple.com']];
      // Each page, the text it shows after which some is cut and some typed,
      // and the links it then shows and is written as.
      for (const [page, after, cut, typed, shown, written] of [
        ['<https://example.com>', 'https://exa', 0, 'z', exazmple, '<https://exazmple.com>'],
        // Text not an address keeps where it goes, though `<…>` would link it.
        [
          'See [site](https://example.com/) now',
          'See si',
          0,
          'z',
          [['sizte', 'https://example.com/']],
          'See [sizte](https://example.com/) now',
        ],
        [
          'See [Re:Plan](https://x.example/plan)',
          'See Re:Pla',
          0,
          's',
          [['Re:Plasn', 'https://x.example/plan']],
          'See [Re:Plasn](https://x.example/plan)',
        ],
      ] as const) {
        const m = await mount(`${page}\n`);
        const view = viewOf(m.dom);
        const [from, to] = [after.length + 1, after.length + 1 + cut];
        const { tr } = view.state;
        act(() => view.dispatch(typed ? tr.insertText(typed, from, to) : tr.delete(from, to)));
        await expect.poll(() => m.handle.read(), { message: page }).toBe(`${written}\n`);
        expect(links(m), page).toEqual(shown);
        await act(async () => {});
        expect(writesAsShown(view.state.doc, m.handle.read(), t.parse), page).toBe(true);
        expect(m.unfaithful, page).toEqual([]);
        m.unmount();
      }
    });
  });

  it('gives what it can’t write as it shows to onUnfaithful, as its text', async () => {
    const m = await mount('# Title\n\n<div>\nx\n</div>\n');
    const view = viewOf(m.dom);
    const start = (view.state.doc.firstChild?.nodeSize ?? 0) + 1;
    // Backspace at the HTML's start joins it to the heading, which can't hold it.
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
      joinBackward(view.state, view.dispatch);
    });
    const written = m.handle.read();
    expect(written).toBe('Title<div>\nx\n</div>\n======\n');
    await expect.poll(() => m.unfaithful).toEqual([written]);
    // Once for what it shows, however often it's read.
    m.handle.read();
    await act(async () => {});
    expect(m.unfaithful).toEqual([written]);
  });

  describe('wikilinks', () => {
    it('holds each as an atom that writes back its source, showing what it names', async () => {
      const m = await mount('[[Plan#Dates|when]] and [[Notes]] and ![[bed.png]]\n');
      const atoms = [...m.dom.querySelectorAll('[data-wikilink]')];
      expect(atoms.map((a) => a.getAttribute('data-wikilink'))).toEqual([
        '[[Plan#Dates|when]]',
        '[[Notes]]',
        '![[bed.png]]',
      ]);
      expect(atoms[0]?.textContent).toBe('when');
      await expect
        .poll(() => atoms[2]?.querySelector('img')?.getAttribute('src'))
        .toMatch(/^blob:/);
      await typeAtEnd(m, 'x');
      await expect
        .poll(() => m.handle.read())
        .toBe('[[Plan#Dates|when]] and [[Notes]] and ![[bed.png]]x\n');
    });
  });

  it('shows attachment images decrypted, and never loads one from another host', async () => {
    const m = await mount('![remote](https://example.test/x.png)\n\n![bed](attachment:a1)\n');
    await expect
      .poll(() => images(m).map((img) => img.getAttribute('src')))
      .toEqual([expect.stringMatching(/^blob:/)]);
    expect(images(m).map((img) => img.getAttribute('alt'))).toEqual(['bed']);
    expect(m.dom.textContent).toContain('Image not loaded: remote');
    expect(m.dom.innerHTML).not.toContain('example.test');
  });

  it('writes GitHub’s alerts with their markers as they are, edited or not', async () => {
    const body = '> Plain.\n\n> [!NOTE]\n> Read *this*.\n\n> [!warning]\n>\n> Two.\n';
    const t = await transformer();
    expect(t.serialize(t.parse(body))).toBe(body);
    const m = await mount(body);
    await typeAtEnd(m, ' More.');
    await expect.poll(() => m.handle.read()).toBe(body.replace('Two.', 'Two. More.'));
  });

  describe('pasting', () => {
    it('keeps text the editor would change as the text it is', async () => {
      const m = await mount('');
      m.dom.focus();
      paste(m, { 'text/plain': '[a][r]\n\n[r]: https://example.test/' });
      // Escaped, so it reads as the text pasted, its address a link as the reader reads it.
      await expect.poll(() => m.handle.read()).toBe('\\[a]\\[r]\n\n\\[r]: https://example.test/\n');
      expect(m.dom.querySelector('a')?.getAttribute('href')).toBe('https://example.test/');
      await act(async () => {});
      expect(m.unfaithful).toEqual([]);
    });

    it('reads wikilinks, images and footnotes from HTML as this tab copied them', async () => {
      const page = 'See [[Plan|the plan]] and ![bed](attachment:a1) and A[^1].\n\n[^1]: Note.\n';
      const m = await mount(page);
      const copied = copyAll(m);
      const html = copied.getData('text/html');
      m.unmount();
      const into = await mount('');
      into.dom.focus();
      paste(into, { 'text/html': html, 'text/plain': copied.getData('text/plain') });
      await expect.poll(() => into.handle.read()).toBe(page);
    });

    it('keeps the headings, bold, italics and lists pasted from Word', async () => {
      const m = await mount('');
      m.dom.focus();
      paste(m, { 'text/html': WORD, 'text/plain': 'Garden plan' });
      await expect
        .poll(() => m.handle.read())
        .toBe(
          [
            '# Garden plan',
            '',
            '# Spring',
            '',
            'Sow the **tomatoes** early and the *beans* late.',
            '',
            '- Tomatoes',
            '  - Cherry',
            '- Beans',
            '',
            'Then:',
            '',
            '1. Water',
            '2. Mulch',
            '',
          ].join('\n'),
        );
      expect(m.unfaithful).toEqual([]);
    });

    it('gives a footnote pasted under a label the page has a free one', async () => {
      const m = await mount('Text[^1].\n\n[^1]: Mine.\n\nEnd\n');
      await typeAtEnd(m, '');
      paste(m, { 'text/plain': 'More[^1].\n\n[^1]: Theirs.\n' });
      await expect
        .poll(() => m.handle.read())
        .toBe('Text[^1].\n\n[^1]: Mine.\n\nEndMore[^1-2].\n\n[^1-2]: Theirs.\n');
      expect(m.dom.querySelector('.footnote-hidden')).toBeNull();
      await act(async () => {});
      expect(m.unfaithful).toEqual([]);
    });

    it('attaches files, and puts their Markdown where they landed', async () => {
      const m = await mount('Before\n');
      await typeAtEnd(m, '');
      paste(m, {}, [new File([PNG], 'bed.png', { type: 'image/png' })]);
      expect(m.uploads.map((u) => u.files.map((f) => f.name))).toEqual([['bed.png']]);
      // Typed while it uploads: it goes after the file.
      await type('x');
      act(() => void m.uploads[0]?.place('![bed.png](attachment:a1)'));
      await expect.poll(() => m.handle.read()).toBe('Before![bed.png](attachment:a1)x\n');
    });

    it('says files had nowhere to go once the editor has gone', async () => {
      const m = await mount('Before\n');
      await typeAtEnd(m, '');
      const file = new File([PNG], 'bed.png', { type: 'image/png' });
      paste(m, {}, [file]);
      paste(m, {}, [file]);
      let placed: boolean | undefined;
      act(() => void (placed = m.uploads[0]?.place('![bed.png](attachment:a1)')));
      expect(placed).toBe(true);
      m.unmount();
      expect(m.uploads[1]?.place('![bed.png](attachment:a1)')).toBe(false);
    });
  });
});

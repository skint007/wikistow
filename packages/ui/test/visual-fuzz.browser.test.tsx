import { splitFrontmatter } from '@wikistow/client';
import { joinBackward, joinForward } from '@milkdown/kit/prose/commands';
import type { Mark, Node } from '@milkdown/kit/prose/model';
import { liftListItem, sinkListItem, splitListItem } from '@milkdown/kit/prose/schema-list';
import { TextSelection, type Command } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vite-plus/test';
import type { EditorSurfaceHandle } from '../src/page/editor/surface.ts';
import { transformer } from '../src/page/editor/visual/config.ts';
import { withLf, writesAsShown } from '../src/page/editor/visual/fidelity.ts';
import { inlineHtml } from '../src/page/editor/visual/read-alone.ts';
import VisualSurface from '../src/page/editor/visual/visual-surface.tsx';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import { viewOf } from './editor-view.ts';

// Random edits, made as ProseMirror transactions on the real visual
// surface, on each corpus page in LF and CRLF: after each, what it writes
// must read back as the document it shows, the guard's check, and again
// once opened anew. Only what Markdown can't hold may read otherwise, and
// the surface must then give it up (`onUnfaithful`). Seeded, so a failure
// names what reproduces it: the seed (`VITE_FUZZ_SEED` picks another), the
// page and each edit.

const SEED = Number(import.meta.env['VITE_FUZZ_SEED'] ?? 20_261_008);
const EDITS = 100;

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
const pages = Object.entries(corpus)
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

/** mulberry32: small, fast and the same everywhere. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const below = (n: number) => Math.floor(next() * n);
  const pick = <T,>(items: readonly T[]): T | undefined => items[below(items.length)];
  return { next, below, pick };
}
type Random = ReturnType<typeof random>;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function mount(initial: string) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  const unfaithful: string[] = [];
  await act(async () =>
    root.render(
      <VisualSurface
        ref={ref}
        initial={initial}
        onChange={() => {}}
        onUnfaithful={(markdown) => unfaithful.push(markdown)}
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
        attachments={{ list: [], url: async () => null }}
        onFiles={() => {}}
      />,
    ),
  );
  await act(() => expect.poll(() => container.querySelector('#page-visual')).not.toBeNull());
  const dom = container.querySelector('#page-visual');
  if (!ref.current || !dom) throw new Error('The editor did not mount');
  const view = viewOf(dom);
  return {
    handle: ref.current,
    view,
    unfaithful,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// Text typed: spaces, table bars, links with and without an alias, what
// starts emphasis, headings, quotes, lists, code and HTML, and addresses
// GFM links (a URL, `www.`, an email), whole or as typed so far.
const TYPED = [
  ' ',
  '  ',
  '    ',
  '|',
  ' | ',
  '[[Plan]]',
  '[[Plan|the plan]]',
  '[[Notes#Dates|when]]',
  '![[bed.png]]',
  '*',
  '**',
  '_',
  '~~',
  '#',
  '# ',
  '>',
  '> ',
  '- ',
  '1. ',
  '+',
  '!',
  '`',
  '\\',
  '[',
  ']',
  '<b>',
  '&amp;',
  '=',
  '---',
  'word',
  'two words',
  'https://example.test/a',
  'https://',
  'www.example.test',
  'www.',
  'me@example.test',
  '@example.test',
  'mailto:me@example.test',
  '(https://example.test/b).',
  ' https://example.test/c. ',
];

/** Where text can go: positions in a text block, with what they're in. */
function spots(doc: Node) {
  const found: { pos: number; inside: Set<string>; start: boolean }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const $pos = doc.resolve(pos + 1);
    const inside = new Set<string>();
    for (let depth = $pos.depth; depth > 0; depth--) inside.add($pos.node(depth).type.name);
    let offset = 0;
    let lineStart = true;
    node.forEach((child) => {
      found.push({ pos: pos + 1 + offset, inside, start: lineStart });
      lineStart = child.type.name === 'hardbreak';
      if (child.isText)
        for (let i = 1; i < child.nodeSize; i++)
          found.push({ pos: pos + 1 + offset + i, inside, start: false });
      offset += child.nodeSize;
    });
    found.push({ pos: pos + 1 + offset, inside, start: lineStart });
    return false;
  });
  return found;
}

const CONTAINERS = ['table_cell', 'table_header', 'list_item', 'blockquote'];

function spot(doc: Node, rng: Random) {
  const all = spots(doc);
  const roll = rng.below(4);
  const inContainer = all.filter(({ inside }) => CONTAINERS.some((type) => inside.has(type)));
  const lineStarts = all.filter(({ start }) => start);
  return (
    (roll === 0 && rng.pick(inContainer)) || (roll === 1 && rng.pick(lineStarts)) || rng.pick(all)
  );
}

function runAt(view: EditorView, pos: number, command: Command) {
  const { state } = view;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  return command(view.state, view.dispatch);
}

/** One random edit, described, or null if it found nothing to do. */
function edit(view: EditorView, rng: Random): string | null {
  const { state } = view;
  const { doc, schema } = state;
  const at = spot(doc, rng);
  if (!at) return null;
  const item = schema.nodes['list_item'];
  switch (rng.below(9)) {
    case 0:
    case 1: {
      const text = rng.pick(TYPED) ?? ' ';
      view.dispatch(state.tr.insertText(text, at.pos));
      return `type ${JSON.stringify(text)} at ${at.pos}`;
    }
    case 2: {
      const from = rng.below(doc.content.size + 1);
      const to = Math.min(doc.content.size, from + 1 + rng.below(12));
      view.dispatch(rng.below(2) ? state.tr.delete(from, to) : state.tr.deleteRange(from, to));
      return `delete ${from}–${to}`;
    }
    case 3: {
      // Enter twice, or an empty paragraph put between blocks.
      if (rng.below(2)) {
        view.dispatch(state.tr.split(at.pos).split(at.pos + 1));
        return `empty paragraph by splitting at ${at.pos}`;
      }
      const between: number[] = [];
      doc.descendants((node, pos) => {
        if (node.isBlock) between.push(pos, pos + node.nodeSize);
        return !node.isTextblock;
      });
      const pos = rng.pick(between) ?? 0;
      const paragraph = schema.nodes['paragraph']?.create();
      if (
        !paragraph ||
        !doc
          .resolve(pos)
          .parent.canReplaceWith(doc.resolve(pos).index(), doc.resolve(pos).index(), paragraph.type)
      )
        return null;
      view.dispatch(state.tr.insert(pos, paragraph));
      return `empty paragraph at ${pos}`;
    }
    case 4: {
      const $at = doc.resolve(at.pos);
      const block = $at.parent;
      if (block.content.size === 0) return null;
      const start = $at.start();
      const from = start + rng.below(block.content.size);
      const to = Math.min(start + block.content.size, from + 1 + rng.below(8));
      const marks = ['strong', 'emphasis', 'strike_through', 'inlineCode', 'link'] as const;
      const name = rng.pick(marks) ?? 'strong';
      const type = schema.marks[name];
      if (!type) return null;
      const mark: Mark = type.create(name === 'link' ? { href: 'https://example.test/x' } : null);
      const tr = doc.rangeHasMark(from, to, type)
        ? state.tr.removeMark(from, to, type)
        : state.tr.addMark(from, to, mark);
      view.dispatch(tr);
      return `toggle ${name} ${from}–${to}`;
    }
    case 5: {
      if (!item) return null;
      const inItem = spots(doc).filter(({ inside }) => inside.has('list_item'));
      const pos = (rng.pick(inItem) ?? at).pos;
      const commands = {
        split: splitListItem(item),
        lift: liftListItem(item),
        sink: sinkListItem(item),
      };
      const name = rng.pick(Object.keys(commands) as (keyof typeof commands)[]) ?? 'split';
      return runAt(view, pos, commands[name]) ? `${name} list item at ${pos}` : null;
    }
    case 6:
    case 7: {
      // Backspace at a block's start, or Delete at its end: joins.
      const $at = doc.resolve(at.pos);
      const back = rng.below(2) === 0;
      const pos = back ? $at.start() : $at.end();
      return runAt(view, pos, back ? joinBackward : joinForward)
        ? `${back ? 'join backward' : 'join forward'} at ${pos}`
        : null;
    }
    default: {
      // A line's start, inside whatever it is.
      const starts = spots(doc).filter(({ start }) => start);
      const pos = (rng.pick(starts) ?? at).pos;
      const text =
        rng.pick(['    ', '  x', '# x', '> x', '- x', '1. x', '| x', '*x', '[[Plan|y]]']) ?? ' ';
      view.dispatch(state.tr.insertText(text, pos));
      return `type ${JSON.stringify(text)} at line start ${pos}`;
    }
  }
}

const CELLS = new Set(['table_cell', 'table_header']);

/**
 * What in `doc` Markdown can't hold, which no writing could keep, so only
 * the guard can catch: in a table cell, code with a lone backslash before
 * a bar (a cell reads `\|` in code as the bar, `\\` as two backslashes);
 * and HTML that's a block of its own in a heading or a cell.
 */
function unwritable(doc: Node): string | null {
  let found: string | null = null;
  doc.descendants((node, pos, parent) => {
    const $pos = doc.resolve(pos);
    let cell = false;
    for (let depth = $pos.depth; depth > 0; depth--) cell ||= CELLS.has($pos.node(depth).type.name);
    const code = node.marks.some((mark) => mark.type.spec.code);
    if (cell && code && /(^|[^\\])(\\\\)*\\\|/.test(node.text ?? ''))
      found ??= 'code with a backslash before a bar in a table cell';
    const block = node.type.name === 'html' && !inlineHtml(String(node.attrs['value']));
    if (block && (cell || parent?.type.name !== 'paragraph'))
      found ??= 'block HTML in a heading or cell';
    return found === null;
  });
  return found;
}

describe('random visual edits', () => {
  it(
    'each write back as the document shown, or the guard catches it',
    { timeout: 120_000 },
    async () => {
      const t = await transformer();
      const rng = random(SEED);
      let edits = 0;
      for (const { name, body } of pages) {
        const m = await mount(body);
        const done: string[] = [];
        let caught = false;
        for (let i = 0; i < EDITS; i++) {
          let did: string | null = null;
          try {
            act(() => {
              did = edit(m.view, rng);
            });
          } catch (error) {
            // A step that doesn't fit where it was aimed; ProseMirror refused it.
            if (!(error instanceof RangeError || (error as Error).name === 'TransformError'))
              throw error;
          }
          if (!did) continue;
          done.push(did);
          edits++;
          const { doc } = m.view.state;
          const written = withLf(m.handle.read());
          const where = [
            `seed ${SEED}, ${name}, after:\n${done.join('\n')}`,
            `wrote ${JSON.stringify(written)}`,
            `showing ${JSON.stringify(doc.toJSON())}`,
            `read back ${JSON.stringify(t.parse(written).toJSON())}`,
          ].join('\n');
          if (!writesAsShown(doc, written, t.parse)) {
            // Only what Markdown can't hold, which the surface gave up as it wrote it.
            expect(unwritable(doc), where).not.toBeNull();
            await act(async () => {});
            expect(m.unfaithful.map(withLf), where).toEqual([written]);
            caught = true;
            break;
          }
          // And opened again, it still does.
          const again = t.parse(written);
          expect(writesAsShown(again, t.serialize(again), t.parse), where).toBe(true);
        }
        await act(async () => {});
        // Given up only for what it couldn't write.
        expect(m.unfaithful.length, name).toBe(caught ? 1 : 0);
        m.unmount();
      }
      expect(edits).toBeGreaterThan(pages.length * EDITS * 0.5);
    },
  );
});

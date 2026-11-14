// Presence in the visual editor (ADR 0015 decision 7): a bar in each other
// person's colour beside the top-level block their caret is in, with their
// name, since the editor maps the shared text to blocks, not to places in a
// block. The person's own caret goes out in their presence, where in the
// shared text the writer puts it (`Writer.caret`).
import type { Node } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import type { Run } from './blocks';
import type { Span } from './sources';

/** Someone's place in the editor's text, as the binding resolves their caret. */
export type BlockCaret = { key: string; name: string; colour: number; at: number };

/** A top-level block someone is in, by index, and who. */
export type BlockBar = { index: number; colour: number; names: readonly string[] };

/**
 * Which top-level block of a document laid out as `runs` and `spans` an
 * offset in its text is in: the block whose source holds it, else the
 * first of the run that does, else the next block after it, else the last.
 */
export function blockAt(
  runs: readonly Run[],
  spans: readonly (Span | null)[],
  count: number,
  at: number,
): number | null {
  if (count === 0) return null;
  const within = spans.findIndex((span) => span && span.from <= at && at <= span.to);
  if (within >= 0) return within;
  const run = runs.find((run) => run.from <= at && at <= run.to);
  if (run) return run.first;
  const after = runs.find((run) => run.from > at);
  if (after) return after.first;
  const last = runs.at(-1);
  return last ? Math.min(last.first + last.count - 1, count - 1) : count - 1;
}

/** The bars for `carets`, a block's people together in the colour of the first. */
export function barsOf(
  carets: readonly BlockCaret[],
  place: (at: number) => number | null,
): BlockBar[] {
  const bars = new Map<number, { colour: number; names: string[] }>();
  for (const caret of carets) {
    const index = place(caret.at);
    if (index === null) continue;
    const bar = bars.get(index);
    if (!bar) bars.set(index, { colour: caret.colour, names: [caret.name] });
    else if (!bar.names.includes(caret.name)) bar.names.push(caret.name);
  }
  return [...bars.entries()]
    .map(([index, bar]) => ({ index, ...bar }))
    .toSorted((a, b) => a.index - b.index);
}

const key = new PluginKey<DecorationSet>('wikistow-live-bars');

/** "Sam", "Sam and Rita", "Sam, Rita and Ola". */
const sentence = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** The decorations that draw `bars` in `doc`: a class on each block, never a `style` attribute. */
export function barDecorations(doc: Node, bars: readonly BlockBar[]): DecorationSet {
  const decorations: Decoration[] = [];
  let pos = 0;
  let index = 0;
  const wanted = new Map(bars.map((bar) => [bar.index, bar]));
  doc.forEach((node) => {
    const bar = wanted.get(index);
    if (bar) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: `live-block live-block-${bar.colour}`,
          'data-live-block': sentence(bar.names),
        }),
      );
    }
    pos += node.nodeSize;
    index++;
  });
  return DecorationSet.create(doc, decorations);
}

/** Set the bars a document shows, in a transaction that changes nothing else. */
export const setBars = (tr: Transaction, set: DecorationSet) =>
  tr.setMeta(key, set).setMeta('addToHistory', false);

/** What the bars plugin asks of the editor while it's bound. */
export type BarsHost = {
  /** Draw the bars again soon, as carets or the text moved. */
  redraw?: (() => void) | undefined;
  /** The person's caret moved, or the editor was focused or left. */
  moved?: (() => void) | undefined;
};

/**
 * The plugin that holds the bars, mapped through each change until they're
 * drawn again, and hears the person's caret move.
 */
export const liveBars = (host: BarsHost) =>
  $prose(
    () =>
      new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, set) =>
            (tr.getMeta(key) as DecorationSet | undefined) ?? set.map(tr.mapping, tr.doc),
        },
        props: { decorations: (state) => key.getState(state) },
        view: (view) => {
          const moved = () => host.moved?.();
          view.dom.addEventListener('focus', moved);
          view.dom.addEventListener('blur', moved);
          return {
            update(view, before) {
              if (!view.state.selection.eq(before.selection) || !view.state.doc.eq(before.doc))
                moved();
              if (!view.state.doc.eq(before.doc)) host.redraw?.();
            },
            destroy() {
              view.dom.removeEventListener('focus', moved);
              view.dom.removeEventListener('blur', moved);
            },
          };
        },
      }),
  );

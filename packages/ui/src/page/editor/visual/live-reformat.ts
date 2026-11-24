// The visual editor's formatting as something it can make again over other
// text (ADR 0015, **Decided while building it**): when its write of the
// formatting is taken out of a live session's `body` again, as
// `live-rebase.ts` does, and it has taken in someone else's text in its
// place, it adds and removes the same marks again, each over its range
// carried onto what it shows now, as prosemirror-collab maps its steps.
import type { Mark, Node } from '@milkdown/kit/prose/model';
import { Plugin, type Transaction } from '@milkdown/kit/prose/state';
import { AddMarkStep, RemoveMarkStep, StepMap, Transform } from '@milkdown/kit/prose/transform';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { diffArrays } from 'diff';
import { unnumbered } from './blocks';
import { EXTERNAL } from './plugins';

/** Marks added and taken off, each over its range in `before`, the document they were made on. */
export type Formatting = {
  readonly before: Node;
  readonly steps: readonly (AddMarkStep | RemoveMarkStep)[];
};

const isFormatting = (intent: unknown): intent is Formatting =>
  typeof intent === 'object' && intent !== null && 'before' in intent && 'steps' in intent;

/**
 * The person's edits in the editor since it was last asked, or since it
 * last took text in: as formatting alone, or, if anything else changed the
 * document, as typing, nothing.
 */
export class FormatRecord {
  #before: Node | null = null;
  #steps: (AddMarkStep | RemoveMarkStep)[] = [];
  #other = false;

  readonly plugin = $prose(
    () =>
      new Plugin({
        appendTransaction: (transactions: readonly Transaction[]) => {
          this.#saw(transactions);
          return null;
        },
      }),
  );

  /** Its edits as formatting, if that's all they are, starting afresh. */
  take(): Formatting | null {
    const taken =
      this.#before && !this.#other && this.#steps.length > 0
        ? { before: this.#before, steps: this.#steps }
        : null;
    this.#reset();
    return taken;
  }

  #saw(transactions: readonly Transaction[]) {
    for (const transaction of transactions) {
      if (!transaction.docChanged) continue;
      const made: Transaction = transaction.getMeta('appendedTransaction') ?? transaction;
      // Text it took in: what came before isn't to be made again over it.
      if (made.getMeta(EXTERNAL)) {
        this.#reset();
        continue;
      }
      this.#before ??= transaction.before;
      for (const step of transaction.steps) {
        if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
          if (!this.#other) this.#steps.push(step);
        } else {
          this.#other = true;
          this.#steps = [];
        }
      }
    }
  }

  #reset() {
    this.#before = null;
    this.#steps = [];
    this.#other = false;
  }
}

/**
 * Whether `intent` adds or takes off a mark that isn't only formatting: code,
 * whose text reads as written, or a link, whose address is text two people
 * can each change, which only a merge by characters keeps both of.
 */
export const literal = (intent: unknown): boolean =>
  isFormatting(intent) &&
  intent.steps.some((step) => !!step.mark.type.spec.code || step.mark.type.name === 'link');

/**
 * `intents`' marks made again over the document `view` shows now, as one
 * edit of the person's own (`remade`).
 */
export function reformat(view: EditorView, intents: readonly unknown[]): void {
  const { tr } = view.state;
  remade(tr, intents);
  if (tr.docChanged) view.dispatch(tr);
}

/**
 * Whether Yjs's merge, `merged`, is to stay as it is: it already reads as
 * `theirs` with `intents`' marks made again over it, or `theirs`, the text
 * without this app's formatting, shows raw HTML the merge doesn't, as
 * someone's tags that split this app's mark, which taking it out leaves
 * unpaired.
 */
export function keeps(merged: Node, theirs: Node, intents: readonly unknown[]): boolean {
  if (rawIn(theirs) > rawIn(merged)) return true;
  // Text typed at either end of a range may have gone inside it or outside,
  // as Yjs placed it: either reading counts.
  const ends: Ends[] = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  // And with their marks of the same kind left or painted over, as Yjs
  // nests two colours with the higher client's inside.
  return [true, false].some((spare) =>
    ends.some((assoc) => {
      const tr = new Transform(theirs);
      remade(tr, intents, assoc, spare);
      // Whatever ids each reading gave its links.
      return unnumbered(tr.doc).eq(unnumbered(merged));
    }),
  );
}

/** Which way each end of a range carried goes when text was typed right there. */
type Ends = readonly [from: number, to: number];

/** How many pieces of raw HTML `doc` shows. */
function rawIn(doc: Node): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === 'html') count++;
  });
  return count;
}

/**
 * `intents`' marks made again over `tr`'s document, each over its range
 * carried from the document it was made on. Text put in at either end of a
 * range goes inside it, as Yjs placed the text of the other person, the
 * lower client, before this one's tags in the merge it replaces.
 */
// How each intent's ranges were lined up with a document, as `keeps` reads
// one document several ways.
const lined = new WeakMap<Node, Map<unknown, StepMap>>();

function remade(
  tr: Transform,
  intents: readonly unknown[],
  ends: Ends = [1, 1],
  spare = true,
): void {
  for (const intent of intents) {
    if (!isFormatting(intent) || intent.before.type.schema !== tr.doc.type.schema) continue;
    // Lined up by its text and marks, so a word typed beside its copy isn't
    // taken for it; failing that, where someone's marks cut across a range,
    // by the marks it doesn't change, and then by its text alone.
    const changed = new Set(intent.steps.map((step) => step.mark.type));
    const ways: ((mark: Mark) => boolean)[] = [
      () => true,
      (mark) => !changed.has(mark.type),
      () => false,
    ];
    const known = lined.get(tr.doc)?.get(intent);
    let map = known ?? StepMap.empty;
    for (const kept of known ? [] : ways) {
      map = carried(intent.before, tr.doc, kept);
      const cut = intent.steps.some((step) =>
        [step.from, step.to].some((at) => map.mapResult(at, 1).deleted),
      );
      if (!cut) break;
    }
    if (!known) lined.set(tr.doc, (lined.get(tr.doc) ?? new Map()).set(intent, map));
    for (const step of intent.steps) {
      const Made = step instanceof AddMarkStep ? AddMarkStep : RemoveMarkStep;
      // Not over a mark of the same kind someone else put on since, as their
      // highlight inside this app's: theirs stays, as the merge kept it.
      for (const [from, to] of unclaimed(intent.before, tr.doc, map, step, ends, spare)) {
        tr.maybeStep(new Made(from, to, step.mark));
      }
    }
  }
}

// The ranges of `doc` that `step`'s range in `before` is carried onto by
// `map`, but for characters with a mark of `step`'s kind they didn't have
// in `before`.
function unclaimed(
  before: Node,
  doc: Node,
  map: StepMap,
  step: AddMarkStep | RemoveMarkStep,
  ends: Ends,
  spare: boolean,
): [number, number][] {
  const [start, end] = [map.map(step.from, ends[0]), map.map(step.to, ends[1])];
  if (start >= end) return [];
  const type = step.mark.type;
  const markOf = (node: Node | null | undefined) => type.isInSet(node?.marks ?? []);
  const out: [number, number][] = [];
  const back = map.invert();
  let open: number | null = null;
  for (let at = start; at < end; at++) {
    const now = markOf(doc.nodeAt(at));
    // Where this character was, if it was there.
    const there = back.mapResult(at, 1);
    const was = there.deleted ? null : markOf(before.nodeAt(there.pos));
    const claimed = spare && !!now && !(was && was.eq(now));
    if (!claimed) open ??= at;
    else if (open !== null) {
      out.push([open, at]);
      open = null;
    }
  }
  if (open !== null) out.push([open, end]);
  return out;
}

// A document as one token for each place in it, as ProseMirror counts
// them: each node's start by its type and its end, each leaf, and each
// character of its text, with the marks `kept` keeps.
function places(doc: Node, kept: (mark: Mark) => boolean): string[] {
  const out: string[] = [];
  const marks = (node: Node) =>
    node.marks
      .filter(kept)
      // A link's id is new each time a text is read: it tells nothing.
      .map((mark) => `${mark.type.name}${JSON.stringify({ ...mark.attrs, id: null })}`)
      .join(' ');
  const walk = (node: Node) =>
    node.forEach((child) => {
      if (child.isText) {
        const signature = marks(child);
        for (const unit of child.text ?? '') {
          // A character beyond the first plane is two places, as ProseMirror counts it.
          for (let i = 0; i < unit.length; i++) out.push(`t${unit}${i}|${signature}`);
        }
      } else if (child.isLeaf) out.push(`l${child.type.name}|${marks(child)}`);
      else {
        out.push(`s${child.type.name}`);
        walk(child);
        out.push('e');
      }
    });
  walk(doc);
  return out;
}

// A diff of a few thousand places takes a millisecond or two; past this
// long it gives up, and what lies between the common start and end counts
// as replaced.
const DIFF_MS = 50;

/** How places in `a` are carried into `b`, by a diff of their places (`places`). */
function carried(a: Node, b: Node, kept: (mark: Mark) => boolean): StepMap {
  const was = places(a, kept);
  const now = places(b, kept);
  let start = 0;
  const shortest = Math.min(was.length, now.length);
  while (start < shortest && was[start] === now[start]) start++;
  let [endA, endB] = [was.length, now.length];
  while (endA > start && endB > start && was[endA - 1] === now[endB - 1]) {
    endA--;
    endB--;
  }
  // Out to whole blocks, as the editor's own writes are diffed by whole
  // lines, so characters alike within them line up as they did there.
  const edge = (token: string | undefined) => token === 'e' || token?.startsWith('s');
  while (start > 0 && !edge(was[start - 1])) start--;
  while (endA < was.length && endB < now.length && !edge(was[endA])) {
    endA++;
    endB++;
  }
  if (start === endA && start === endB) return StepMap.empty;
  const [middleA, middleB] = [was.slice(start, endA), now.slice(start, endB)];
  const parts = diffArrays(middleA, middleB, { timeout: DIFF_MS }) ?? [
    { value: middleA, removed: true, added: false, count: middleA.length },
    { value: middleB, removed: false, added: true, count: middleB.length },
  ];
  const ranges: number[] = [];
  let at = start;
  let [removed, added] = [0, 0];
  const flush = () => {
    if (removed > 0 || added > 0) ranges.push(at, removed, added);
    at += removed;
    [removed, added] = [0, 0];
  };
  for (const part of parts) {
    if (part.removed) removed += part.value.length;
    else if (part.added) added += part.value.length;
    else {
      flush();
      at += part.value.length;
    }
  }
  flush();
  return new StepMap(ranges);
}

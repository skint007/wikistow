// The visual editor's formatting as something it can make again over other
// text (ADR 0015, **Decided while building it**): when its write of the
// formatting is taken out of a live session's `body` again, as
// `live-rebase.ts` does, and it has taken in someone else's text in its
// place, it adds and removes the same marks again, each over its range in
// what it shows now, as prosemirror-collab maps its steps. Only over a
// block whose text nobody changed since: the other person's change to it
// is formatting alone too, so each range is where it was.
import type { Node } from '@milkdown/kit/prose/model';
import { Plugin, type Transaction } from '@milkdown/kit/prose/state';
import { AddMarkStep, RemoveMarkStep, Transform } from '@milkdown/kit/prose/transform';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
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

// Each top-level block as one string, without its marks: two blocks share
// it only if they have the same text and nodes, formatted alike or not.
// Kept by node, as documents share the blocks an edit didn't change.
const bareOf = new WeakMap<Node, string>();
// And with its marks, as it shows, whatever ids each reading gave its links.
const shownOf = new WeakMap<Node, string>();

function key(node: Node, marked: boolean): string {
  const cache = marked ? shownOf : bareOf;
  const known = cache.get(node);
  if (known !== undefined) return known;
  const out: string[] = [];
  const marks = (child: Node) =>
    marked
      ? JSON.stringify(
          child.marks.map((mark) => [
            mark.type.name,
            mark.type.name === 'link' ? { ...mark.attrs, id: null } : mark.attrs,
          ]),
        )
      : '';
  const walk = (parent: Node) => {
    // Text as one run while its marks are the same: without them, all of it
    // between two nodes, however its marks split it.
    let run: string | null = null;
    let text = '';
    const flush = () => {
      if (run !== null) out.push(`t${run}${JSON.stringify(text)}`);
      [run, text] = [null, ''];
    };
    parent.forEach((child) => {
      if (child.isText) {
        const signature = marks(child);
        if (signature !== run) flush();
        run = signature;
        text += child.text ?? '';
        return;
      }
      flush();
      out.push(`n${child.type.name}${JSON.stringify(child.attrs)}${marks(child)}(`);
      walk(child);
      out.push(')');
    });
    flush();
  };
  out.push(`n${node.type.name}${JSON.stringify(node.attrs)}(`);
  walk(node);
  out.push(')');
  const made = out.join('');
  cache.set(node, made);
  return made;
}

/**
 * How a place in `before` is found in `now`, where only blocks whose text
 * and nodes are the same in both are lined up: those from the start up to
 * the first that differs, and those from the end back to the last. A place
 * in a block between, whose text someone changed, isn't found: null.
 */
type LinedUp = (from: number, to: number) => [number, number] | null;

function lineUp(before: Node, now: Node): LinedUp {
  const [a, b] = [before.childCount, now.childCount];
  const alike = (x: Node, y: Node) => x === y || key(x, false) === key(y, false);
  let head = 0;
  let headEnd = 0;
  while (head < a && head < b && alike(before.child(head), now.child(head))) {
    headEnd += before.child(head).nodeSize;
    head++;
  }
  let tail = 0;
  let tailStart = before.content.size;
  while (
    tail < a - head &&
    tail < b - head &&
    alike(before.child(a - 1 - tail), now.child(b - 1 - tail))
  ) {
    tailStart -= before.child(a - 1 - tail).nodeSize;
    tail++;
  }
  const shift = now.content.size - before.content.size;
  return (from, to) => {
    if (to <= headEnd) return [from, to];
    if (from >= tailStart) return [from + shift, to + shift];
    return null;
  };
}

/**
 * Whether each of `intents`' marks can be made again over `doc`: every
 * range lies in a block whose text and nodes are as they were when it was
 * made. Otherwise someone changed its text since, as by typing in it, and
 * Yjs's merge of the two stays as it is.
 */
export function remakes(doc: Node, intents: readonly unknown[]): boolean {
  return intents.every((intent) => {
    if (!isFormatting(intent) || intent.before.type.schema !== doc.type.schema) return false;
    const lined = lineUp(intent.before, doc);
    return intent.steps.every((step) => lined(step.from, step.to) !== null);
  });
}

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
 * Whether Yjs's merge, `merged`, already reads as `theirs`, the text
 * without this app's formatting, with `intents`' marks made again over it:
 * then it stays as it is. With their marks of the same kind left or painted
 * over, as Yjs nests two colours with the higher client's inside.
 */
export function readsAs(merged: Node, theirs: Node, intents: readonly unknown[]): boolean {
  return [true, false].some((spare) => {
    const tr = new Transform(theirs);
    remade(tr, intents, spare);
    return same(tr.doc, merged);
  });
}

// Whether two documents show the same, block by block.
function same(a: Node, b: Node): boolean {
  if (a.childCount !== b.childCount) return false;
  for (let i = 0; i < a.childCount; i++) {
    if (a.child(i) !== b.child(i) && key(a.child(i), true) !== key(b.child(i), true)) return false;
  }
  return true;
}

/**
 * `intents`' marks made again over `tr`'s document, each over its range in
 * the document it was made on, which is where it is now (`remakes`).
 */
function remade(tr: Transform, intents: readonly unknown[], spare = true): void {
  for (const intent of intents) {
    if (!isFormatting(intent) || intent.before.type.schema !== tr.doc.type.schema) continue;
    const lined = lineUp(intent.before, tr.doc);
    for (const step of intent.steps) {
      const at = lined(step.from, step.to);
      if (!at) continue;
      const Made = step instanceof AddMarkStep ? AddMarkStep : RemoveMarkStep;
      // Not over a mark of the same kind someone else put on since, as their
      // highlight inside this app's: theirs stays, as the merge kept it.
      for (const [from, to] of unclaimed(intent.before, tr.doc, step, at, spare)) {
        tr.maybeStep(new Made(from, to, step.mark));
      }
    }
  }
}

// The ranges of `doc` that `step`'s range in `before` is at now, `at`, but
// for characters with a mark of `step`'s kind they didn't have in `before`.
function unclaimed(
  before: Node,
  doc: Node,
  step: AddMarkStep | RemoveMarkStep,
  [start, end]: [number, number],
  spare: boolean,
): [number, number][] {
  const type = step.mark.type;
  const markOf = (node: Node | null | undefined) => type.isInSet(node?.marks ?? []);
  const out: [number, number][] = [];
  const shift = start - step.from;
  let open: number | null = null;
  for (let at = start; at < end; at++) {
    const now = markOf(doc.nodeAt(at));
    const was = markOf(before.nodeAt(at - shift));
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

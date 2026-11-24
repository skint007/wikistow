// The visual editor's formatting as something it can make again over other
// text (ADR 0015, **Decided while building it**): when its write of the
// formatting is taken out of a live session's `body` again, as
// `live-rebase.ts` does, and it has taken in someone else's text in its
// place, it adds and removes the same marks again, each over its range
// carried onto what it shows now, as prosemirror-collab maps its steps.
import type { Node } from '@milkdown/kit/prose/model';
import { Plugin, type Transaction } from '@milkdown/kit/prose/state';
import { AddMarkStep, RemoveMarkStep, StepMap } from '@milkdown/kit/prose/transform';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { diffChars } from 'diff';
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
 * `intents`' marks made again over the document `view` shows now, as one
 * edit of the person's own, each over its range carried from the document
 * it was made on. Text put in at either end of a range goes inside it, as
 * Yjs placed the text of the other person, the lower client, before this
 * one's tags in the merge it replaces.
 */
export function reformat(view: EditorView, intents: readonly unknown[]): void {
  const { tr } = view.state;
  for (const intent of intents) {
    if (!isFormatting(intent) || intent.before.type.schema !== tr.doc.type.schema) continue;
    const map = carried(intent.before, tr.doc);
    for (const step of intent.steps) {
      const from = map.map(step.from, 1);
      const to = map.map(step.to, 1);
      if (from >= to) continue;
      const Made = step instanceof AddMarkStep ? AddMarkStep : RemoveMarkStep;
      tr.maybeStep(new Made(from, to, step.mark));
    }
  }
  if (tr.docChanged) view.dispatch(tr);
}

// A document as one character for each place in it, as ProseMirror counts
// them, its marks left out: each node's start by its type and its end, each
// leaf, and its text as it is.
const LEAF = '￼';
const END = '';
function places(doc: Node): string {
  const types = Object.keys(doc.type.schema.nodes);
  const startOf = (name: string) => String.fromCharCode(0xe000 + types.indexOf(name));
  const parts: string[] = [];
  const walk = (node: Node) =>
    node.forEach((child) => {
      if (child.isText) parts.push(child.text ?? '');
      else if (child.isLeaf) parts.push(LEAF);
      else {
        parts.push(startOf(child.type.name));
        walk(child);
        parts.push(END);
      }
    });
  walk(doc);
  return parts.join('');
}

// A character diff of a few thousand places takes a millisecond or two;
// past this long it gives up, and what lies between the common start and
// end counts as replaced.
const DIFF_MS = 50;

/** How places in `a` are carried into `b`, by a diff of their places, marks aside. */
function carried(a: Node, b: Node): StepMap {
  const was = places(a);
  const now = places(b);
  let start = 0;
  const shortest = Math.min(was.length, now.length);
  while (start < shortest && was.charCodeAt(start) === now.charCodeAt(start)) start++;
  let [endA, endB] = [was.length, now.length];
  while (endA > start && endB > start && was.charCodeAt(endA - 1) === now.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return StepMap.empty;
  const parts = diffChars(was.slice(start, endA), now.slice(start, endB), { timeout: DIFF_MS }) ?? [
    { value: was.slice(start, endA), removed: true, added: false, count: 1 },
    { value: now.slice(start, endB), removed: false, added: true, count: 1 },
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

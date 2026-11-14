// The visual editor's own edits, as they go into a live session's `body`
// (ADR 0015 decision 3, **Its own edits**): each run of lines it changed,
// as the smallest change in characters from the text it last took in, and,
// where someone else's change has reached `body` but not the editor yet,
// carried onto `body` as it is now by a character diff, so both people's
// typing stays. Every change starts and ends between whole characters,
// never inside an emoji's two halves, which Yjs would store as two U+FFFD.
import { diffChars, diffLines, type ChangeObject } from 'diff';
import type * as Y from 'yjs';

/** A change to a text: delete `remove` UTF-16 units at `from`, then insert `insert` there. */
export type TextChange = {
  readonly from: number;
  readonly remove: number;
  readonly insert: string;
};

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
/** Whether `at` falls between the two halves of a surrogate pair in `text`. */
const splits = (text: string, at: number) =>
  at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));

// A diff of a few thousand characters takes a millisecond or two; one of
// very different texts grows with the square of their size, so it gives up
// after this long and the change goes in as one span.
const DIFF_MS = 50;

/**
 * Where `a` and `b` differ: the common start's length, and where each
 * one's common end begins, all between whole characters of both.
 */
function edges(a: string, b: string): { start: number; endA: number; endB: number } {
  const shortest = Math.min(a.length, b.length);
  let start = 0;
  while (start < shortest && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  while (start > 0 && (splits(a, start) || splits(b, start))) start--;
  while ((endA < a.length && splits(a, endA)) || (endB < b.length && splits(b, endB))) {
    endA++;
    endB++;
  }
  return { start, endA, endB };
}

/** The one span in which `before` and `after` differ, from `at` in a longer text, or null. */
function smallest(before: string, after: string, at: number): TextChange | null {
  if (before === after) return null;
  const { start, endA, endB } = edges(before, after);
  return { from: at + start, remove: endA - start, insert: after.slice(start, endB) };
}

/**
 * The changes that make `before` read `after`: one for each run of lines
 * that differ, in order, each the smallest within its lines, so blocks the
 * editor didn't change between two it did stay as they are in `body`.
 */
export function ownChanges(before: string, after: string): TextChange[] {
  if (before === after) return [];
  const { start, endA, endB } = edges(before, after);
  const was = before.slice(start, endA);
  const now = after.slice(start, endB);
  const whole = () => {
    const change = smallest(was, now, start);
    return change ? [change] : [];
  };
  // One line, or none, either side: one span.
  if (!was.includes('\n') || !now.includes('\n')) return whole();
  const parts = diffLines(was, now, { timeout: DIFF_MS });
  if (!parts) return whole();
  const changes: TextChange[] = [];
  let at = start;
  let removed = '';
  let added = '';
  const flush = () => {
    const change = smallest(removed, added, at);
    if (change) changes.push(change);
    at += removed.length;
    removed = '';
    added = '';
  };
  for (const part of parts) {
    if (part.removed) removed += part.value;
    else if (part.added) added += part.value;
    else {
      flush();
      at += part.value.length;
    }
  }
  flush();
  return changes;
}

/** A stretch of the text the editor took in, `held`, and what it is in `body` now. */
type Segment = {
  readonly held: number;
  readonly heldEnd: number;
  readonly body: number;
  readonly bodyEnd: number;
  /** The same characters in both, or a change someone else made. */
  readonly same: boolean;
};

/**
 * How the text the editor took in, `held`, became `body`, which others'
 * changes reached since: a character diff, from places in one to places in
 * the other. Their changes are usually a few characters in one place, so
 * only what lies between the common start and end is compared; past
 * `DIFF_MS` that's compared by lines, and failing that, taken as replaced.
 */
export class Mapping {
  readonly #segments: Segment[] = [];
  readonly held: string;
  readonly body: string;

  constructor(held: string, body: string) {
    this.held = held;
    this.body = body;
    const { start, endA, endB } = edges(held, body);
    const push = (segment: Segment) => {
      if (segment.heldEnd > segment.held || segment.bodyEnd > segment.body)
        this.#segments.push(segment);
    };
    push({ held: 0, heldEnd: start, body: 0, bodyEnd: start, same: true });
    const was = held.slice(start, endA);
    const now = body.slice(start, endB);
    const parts: ChangeObject<string>[] = (was === '' || now === ''
      ? null
      : (diffChars(was, now, { timeout: DIFF_MS }) ??
        diffLines(was, now, { timeout: DIFF_MS }))) ?? [
      { value: was, removed: true, added: false, count: 1 },
      { value: now, removed: false, added: true, count: 1 },
    ];
    let a = start;
    let b = start;
    for (const part of parts) {
      const size = part.value.length;
      if (part.removed) {
        push({ held: a, heldEnd: a + size, body: b, bodyEnd: b, same: false });
        a += size;
      } else if (part.added) {
        push({ held: a, heldEnd: a, body: b, bodyEnd: b + size, same: false });
        b += size;
      } else {
        push({ held: a, heldEnd: a + size, body: b, bodyEnd: b + size, same: true });
        a += size;
        b += size;
      }
    }
    push({ held: endA, heldEnd: held.length, body: endB, bodyEnd: body.length, same: true });
  }

  /**
   * Where `at`, a place in `held`, is in `body`: in text both have, the
   * same place there; in text someone else took out, where it was; after
   * what they added just before it.
   */
  toBody(at: number): number {
    for (const segment of this.#segments) {
      if (at < segment.held || at >= segment.heldEnd) continue;
      return segment.same ? segment.body + (at - segment.held) : segment.body;
    }
    return this.body.length;
  }

  /** Where `at`, a place in `body`, is in `held`: as `toBody`, the other way. */
  toHeld(at: number): number {
    for (const segment of this.#segments) {
      if (at < segment.body || at >= segment.bodyEnd) continue;
      return segment.same ? segment.held + (at - segment.body) : segment.held;
    }
    return this.held.length;
  }

  /**
   * `changes`, of `held`, carried onto `body`: each deletes only characters
   * both have, so what someone else added inside it stays and what they
   * took out isn't taken out again, and inserts where its start is there.
   * In order, none overlapping another, each between whole characters.
   */
  carry(changes: readonly TextChange[]): TextChange[] {
    const carried: TextChange[] = [];
    for (const change of changes) {
      const end = change.from + change.remove;
      const at = this.toBody(change.from);
      const deletes: { from: number; to: number }[] = [];
      for (const segment of this.#segments) {
        if (!segment.same || segment.heldEnd <= change.from || segment.held >= end) continue;
        const from = segment.body + Math.max(change.from, segment.held) - segment.held;
        const to = segment.body + Math.min(end, segment.heldEnd) - segment.held;
        if (to > from) deletes.push({ from, to });
      }
      // The insertion with the first deletion it touches, the rest alone.
      let inserted = false;
      for (const { from, to } of deletes) {
        const here: boolean = !inserted && from === at;
        carried.push({ from, remove: to - from, insert: here ? change.insert : '' });
        inserted ||= here;
      }
      if (!inserted && change.insert !== '') {
        carried.push({ from: at, remove: 0, insert: change.insert });
      }
    }
    // In order of place; an insertion before a deletion at the same place.
    return carried
      .map((change, i) => ({ change, i }))
      .toSorted((x, y) => x.change.from - y.change.from || x.i - y.i)
      .map(({ change }) => change);
  }
}

/** `text` with `changes`, in order and none overlapping, made. */
export function applyTo(text: string, changes: readonly TextChange[]): string {
  let out = '';
  let at = 0;
  for (const change of changes) {
    out += text.slice(at, change.from) + change.insert.toWellFormed();
    at = change.from + change.remove;
  }
  return out + text.slice(at);
}

/** Make `changes`, in order and none overlapping, to `text`: from the last, so each place holds. */
export function putInto(text: Y.Text, changes: readonly TextChange[]): void {
  for (const change of changes.toReversed()) {
    if (change.remove > 0) text.delete(change.from, change.remove);
    const insert = change.insert.toWellFormed();
    if (insert !== '') text.insert(change.from, insert);
  }
}

// The visual editor's own edits, as they go into a live session's `body`
// (ADR 0015 decision 3, **Its own edits**): each run of lines it changed,
// as the smallest change in characters from the text it last took in, and,
// where someone else's change has reached `body` but not the editor yet,
// carried onto `body` as it is now by a character diff, so both people's
// typing stays. Every change starts and ends between whole characters,
// never inside an emoji's two halves, which Yjs would store as two U+FFFD.
// A line whose formatting alone changed goes in whole, as one run (#720).
import { diffChars, diffLines, type ChangeObject } from 'diff';
import type * as Y from 'yjs';

/** A change to a text: delete `remove` UTF-16 units at `from`, then insert `insert` there. */
export type TextChange = {
  readonly from: number;
  readonly remove: number;
  readonly insert: string;
  /** A run whose formatting alone changed, put in whole (`ownChanges`). */
  readonly run?: true;
};

/**
 * The words `markdown` shows, without its formatting: HTML tags and the
 * characters emphasis, highlights, strikethrough, code and escapes are
 * written with taken out. Rough, but the same for the same words however
 * they're formatted, which is all it's for.
 */
export const wordsOf = (markdown: string) =>
  markdown.replace(/<\/?[A-Za-z][^<>]*>/g, '').replace(/[\\*_=~`]/g, '');

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
 * The run of `line` that becomes `next`'s, formatting alone changed: from
 * the first difference to the last, widened to whole words with their
 * marks, as spaces outside HTML tags part them. So two people formatting
 * the same word, whatever marks each adds or takes off, replace the same
 * characters, and two formatting part of a word, or one inside the
 * other's tags, never splice into each other's.
 */
function runOf(line: string, next: string, at: number): TextChange {
  const { start, endA, endB } = edges(line, next);
  const parts = new Uint8Array(line.length);
  let inTag = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '<' && /^<\/?[A-Za-z][^<>]*>/.test(line.slice(i, i + 512))) inTag = true;
    else if (char === '>') inTag = false;
    if (!inTag && /\s/.test(char ?? '')) parts[i] = 1;
  }
  let from = start;
  while (from > 0 && !parts[from - 1]) from--;
  let to = endA;
  while (to < line.length && !parts[to]) to++;
  return {
    from: at + from,
    remove: to - from,
    insert: next.slice(from, endB + to - endA),
    run: true,
  };
}

/**
 * `changes`, of the lines from `at` in a longer text that read `was` and
 * now `now`, with each line whose formatting alone changed, its words the
 * same (`wordsOf`), changed as one run (`runOf`, #720). Two people
 * formatting the same words at once then each put in a whole run of their
 * own, which the binding settles to one, where by character the changes
 * interleave into tags neither wrote. As they were if the lines don't
 * pair up, as the diff lined them up.
 */
function inRuns(changes: TextChange[], was: string, now: string, at: number): TextChange[] {
  const before = was.split('\n');
  const after = now.split('\n');
  if (before.length !== after.length) return changes;
  // Each line's place, from `at`, and its change as a run, if it is one.
  const lines: { from: number; to: number; run: TextChange | null }[] = [];
  let from = at;
  for (const [i, line] of before.entries()) {
    const next = after[i] ?? '';
    const to = from + line.length + (i < before.length - 1 ? 1 : 0);
    const formatted = line !== next && wordsOf(line) === wordsOf(next) && wordsOf(line) !== '';
    lines.push({ from, to, run: formatted ? runOf(line, next, from) : null });
    from = to;
  }
  if (!lines.some((line) => line.run)) return changes;
  // The changes on other lines, each by the line it starts on, and the runs.
  const on = (at: number) =>
    lines.find((line) => at >= line.from && (at < line.to || (at === line.to && at === from)));
  const out = changes.filter((change) => !on(change.from)?.run);
  for (const line of lines) if (line.run) out.push(line.run);
  const runs = out.toSorted((x, y) => x.from - y.from);
  // Only if the diff lined the lines up as they pair, as moving text from line to line doesn't.
  const local = runs.map((change) => ({ ...change, from: change.from - at }));
  return applyTo(was, local) === now ? runs : changes;
}

/**
 * The changes that make `before` read `after`, each the smallest in
 * characters: by a character diff of the lines between the common start and
 * end, so text the editor didn't change, between or within its changes,
 * stays as it is in `body`, and others' changes there with it. A line whose
 * formatting alone changed is one run (`inRuns`). Past `DIFF_MS`, by lines,
 * each run of lines that differ its smallest change; failing that, one span.
 */
export function ownChanges(before: string, after: string): TextChange[] {
  if (before === after) return [];
  let { start, endA, endB } = edges(before, after);
  // Whole lines, which the line diff, if it comes to that, lines up.
  start = start === 0 ? 0 : before.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = before.indexOf('\n', endA);
  const onward = (lineEnd < 0 ? before.length : lineEnd + 1) - endA;
  endA += onward;
  endB += onward;
  const was = before.slice(start, endA);
  const now = after.slice(start, endB);
  const changes: TextChange[] = [];
  let at = start;
  let removed = '';
  let added = '';
  const flush = (smallestOf: boolean) => {
    const change = smallestOf
      ? smallest(removed, added, at)
      : removed === '' && added === ''
        ? null
        : { from: at, remove: removed.length, insert: added };
    if (change) changes.push(change);
    at += removed.length;
    removed = '';
    added = '';
  };
  const byChars = diffChars(was, now, { timeout: DIFF_MS });
  const parts = byChars ?? diffLines(was, now, { timeout: DIFF_MS });
  if (!parts) {
    const change = smallest(was, now, start);
    return change ? [change] : [];
  }
  // Characters alike by chance, as the "r" of "world" and "there", are
  // left as they are: joining them into one change would undo what someone
  // else did to them meanwhile, which it can't see yet.
  for (const part of parts) {
    if (part.removed) removed += part.value;
    else if (part.added) added += part.value;
    else {
      flush(!byChars);
      at += part.value.length;
    }
  }
  flush(!byChars);
  return byChars ? inRuns(changes, was, now, start) : changes;
}

/**
 * A run of characters, as the text the editor took in (`held`) and `body`
 * now have them: in both, alike; in `held` only, which someone else took
 * out; or in `body` only, which someone else put in.
 */
type Piece = {
  readonly kind: 'same' | 'held' | 'body';
  readonly length: number;
  /** In `body` only, or in `held` only, by the editor's own writing rather than someone else's. */
  readonly mine?: true;
};

/** A stretch of `held`, and what it is in `body` now. */
type Segment = {
  readonly held: number;
  readonly heldEnd: number;
  readonly body: number;
  readonly bodyEnd: number;
  /** The same characters in both, or a change someone else made. */
  readonly same: boolean;
};

/** A change to `body` as Yjs tells it (`YTextEvent.delta`). */
export type Delta = readonly { insert?: unknown; delete?: number; retain?: number }[];

const lengthOf = (insert: unknown) => (typeof insert === 'string' ? insert.length : 1);

/** `pieces`, runs of a kind next to each other as one, none empty. */
function joined(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    const last = out.at(-1);
    if (last?.kind === piece.kind && last.mine === piece.mine)
      out[out.length - 1] = { ...last, length: last.length + piece.length };
    else out.push(piece);
  }
  return out;
}

// Past this many runs, following each change costs more than the diff
// that then stands in for it, which is bounded in time.
const MAX_PIECES = 2_000;

/** Pieces read from the front, a part of one at a time, without copying the rest. */
class Cursor {
  readonly #pieces: readonly Piece[];
  #at = 0;
  /** What's left of the piece at `#at`. */
  #left: number;
  constructor(pieces: readonly Piece[]) {
    this.#pieces = pieces;
    this.#left = pieces[0]?.length ?? 0;
  }
  peek(): Piece | undefined {
    const piece = this.#pieces[this.#at];
    return piece && { ...piece, length: this.#left };
  }
  /** Up to `length` of the piece in front, as a piece of its own. */
  take(length: number): Piece {
    const piece = this.#pieces[this.#at] as Piece;
    const used = Math.min(length, this.#left);
    this.#left -= used;
    if (this.#left === 0) this.#left = this.#pieces[++this.#at]?.length ?? 0;
    return { ...piece, length: used };
  }
  left(): Piece[] {
    const piece = this.peek();
    return piece ? [piece, ...this.#pieces.slice(this.#at + 1)] : [];
  }
}

/**
 * How the text the editor took in, `held`, became `body`, which others'
 * changes reached since, from places in one to places in the other: exactly,
 * as Yjs told each change (`remote`) and the editor's own were written
 * (`afterOwn`); or, where that wasn't followed, by a character diff
 * (`between`). A diff matches characters that are merely alike, so one of
 * someone's replacements can line up with what it replaced. Their changes
 * are usually a few characters in one place, so only what lies between the
 * common start and end is compared; past `DIFF_MS` that's compared by
 * lines, and failing that, taken as replaced.
 */
export class Mapping {
  readonly #pieces: readonly Piece[];
  #cached: Segment[] | null = null;
  /** How long `held` and `body` are. */
  readonly heldLength: number;
  readonly bodyLength: number;

  private constructor(pieces: readonly Piece[]) {
    this.#pieces = joined(pieces);
    let held = 0;
    let body = 0;
    for (const piece of this.#pieces) {
      if (piece.kind !== 'body') held += piece.length;
      if (piece.kind !== 'held') body += piece.length;
    }
    this.heldLength = held;
    this.bodyLength = body;
  }

  /** `held` and `body` the same, `length` long. */
  static identity(length: number): Mapping {
    return new Mapping([{ kind: 'same', length }]);
  }

  /** `held` against `body` by a character diff, for when how one became the other wasn't followed. */
  static between(held: string, body: string): Mapping {
    const { start, endA, endB } = edges(held, body);
    const was = held.slice(start, endA);
    const now = body.slice(start, endB);
    const parts: ChangeObject<string>[] = (was === '' || now === ''
      ? null
      : (diffChars(was, now, { timeout: DIFF_MS }) ??
        diffLines(was, now, { timeout: DIFF_MS }))) ?? [
      { value: was, removed: true, added: false, count: 1 },
      { value: now, removed: false, added: true, count: 1 },
    ];
    const pieces: Piece[] = [{ kind: 'same', length: start }];
    for (const part of parts) {
      const kind = part.removed ? 'held' : part.added ? 'body' : 'same';
      pieces.push({ kind, length: part.value.length });
    }
    pieces.push({ kind: 'same', length: held.length - endA });
    return new Mapping(pieces);
  }

  /**
   * As it is once someone else's change, `delta`, in places of `body`, went
   * into `body`: null once it has grown past `MAX_PIECES`, as so many
   * scattered changes would make following each one cost more than a diff.
   */
  remote(delta: Delta, mine = false): Mapping | null {
    const own = mine ? ({ mine: true } as const) : {};
    const out: Piece[] = [];
    const rest = new Cursor(this.#pieces);
    // Take `length` of `body` from `rest`, as `take` says, with what of
    // `held` only lies within it or just before.
    const walk = (length: number, take: (piece: Piece, length: number) => void) => {
      let left = length;
      for (let piece = rest.peek(); piece; piece = rest.peek()) {
        if (piece.kind === 'held') {
          out.push(rest.take(piece.length));
          continue;
        }
        if (left === 0) break;
        const used = Math.min(left, piece.length);
        take(rest.take(used), used);
        left -= used;
      }
    };
    for (const op of delta) {
      if (op.retain !== undefined) walk(op.retain, (piece) => out.push(piece));
      else if (op.delete !== undefined)
        // Alike, it's now in `held` only; theirs, it's gone.
        walk(op.delete, (piece, length) => {
          if (piece.kind === 'same') out.push({ kind: 'held', length, ...own });
        });
      else if (op.insert !== undefined) {
        // After what of `held` only lies here.
        while (rest.peek()?.kind === 'held') out.push(rest.take(Infinity));
        out.push({ kind: 'body', length: lengthOf(op.insert), ...own });
      }
      if (out.length > MAX_PIECES) return null;
    }
    return Mapping.#bounded([...out, ...rest.left()]);
  }

  /**
   * As it is once `changes`, of `held`, went into `body` as `carry` carries
   * them, and the editor's text became `held` with them: what's put in is
   * in both, what's taken out alike goes from both, and what someone else
   * put in inside it stays in `body` only. Null past `MAX_PIECES`.
   */
  afterOwn(changes: readonly TextChange[]): Mapping | null {
    const out: Piece[] = [];
    const rest = new Cursor(this.#pieces);
    let at = 0;
    // Pieces up to `to` in `held`: kept, or, in a range taken out, only
    // what's someone else's in `body`. Theirs at the very end of a range
    // taken out waits for what comes after it.
    const upTo = (to: number, takenOut: boolean) => {
      for (let piece = rest.peek(); piece; piece = rest.peek()) {
        if (piece.kind === 'body') {
          if (takenOut && at === to) break;
          out.push(rest.take(Infinity));
          continue;
        }
        if (at >= to) break;
        const used = Math.min(to - at, piece.length);
        const taken = rest.take(used);
        if (!takenOut) out.push(taken);
        at += used;
      }
    };
    for (const change of changes) {
      upTo(change.from, false);
      // Theirs just before an insertion's place comes before it, as `toBody` puts it.
      while (rest.peek()?.kind === 'body') out.push(rest.take(Infinity));
      out.push({ kind: 'same', length: change.insert.toWellFormed().length });
      upTo(change.from + change.remove, true);
      if (out.length > MAX_PIECES) return null;
    }
    return Mapping.#bounded([...out, ...rest.left()]);
  }

  static #bounded(pieces: readonly Piece[]): Mapping | null {
    const mapping = new Mapping(pieces);
    return mapping.#pieces.length > MAX_PIECES ? null : mapping;
  }

  /**
   * `held`, as `text` is, with the editor's own writing since (`remote`'s
   * `mine`) as `body`, now `body` has it, and how that became `body`: what
   * the editor shows of text it checked while it typed on, its typing where
   * `body` has it, others' changes since still to come.
   */
  withOwn(text: string, body: string): { text: string; map: Mapping } {
    let shown = '';
    const pieces: Piece[] = [];
    let [t, b] = [0, 0];
    for (const piece of this.#pieces) {
      const { length } = piece;
      if (piece.kind === 'same' || (piece.kind === 'body' && piece.mine)) {
        shown += body.slice(b, b + length);
        pieces.push({ kind: 'same', length });
      } else if (piece.kind === 'held' && !piece.mine) {
        shown += text.slice(t, t + length);
        pieces.push({ kind: 'held', length });
      } else if (piece.kind === 'body') pieces.push({ kind: 'body', length });
      if (piece.kind !== 'body') t += length;
      if (piece.kind !== 'held') b += length;
    }
    return { text: shown, map: new Mapping(pieces) };
  }

  /** Where in `body` what others put in, and the editor hasn't taken in, is: each run of it, in order. */
  added(): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    let body = 0;
    for (const piece of this.#pieces) {
      if (piece.kind === 'body' && !piece.mine) out.push({ from: body, to: body + piece.length });
      if (piece.kind !== 'held') body += piece.length;
    }
    return out;
  }

  get #segments(): Segment[] {
    if (this.#cached) return this.#cached;
    const segments: Segment[] = [];
    let held = 0;
    let body = 0;
    for (const piece of this.#pieces) {
      const heldEnd = held + (piece.kind === 'body' ? 0 : piece.length);
      const bodyEnd = body + (piece.kind === 'held' ? 0 : piece.length);
      segments.push({ held, heldEnd, body, bodyEnd, same: piece.kind === 'same' });
      held = heldEnd;
      body = bodyEnd;
    }
    return (this.#cached = segments);
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
    return this.bodyLength;
  }

  /** Where `at`, a place in `body`, is in `held`: as `toBody`, the other way. */
  toHeld(at: number): number {
    for (const segment of this.#segments) {
      if (at < segment.body || at >= segment.bodyEnd) continue;
      return segment.same ? segment.held + (at - segment.body) : segment.held;
    }
    return this.heldLength;
  }

  /**
   * `changes`, of `held`, carried onto `body`: each deletes only characters
   * both have, alike by this mapping, so what someone else added inside it
   * stays and what they took out isn't taken out again, and inserts where
   * its start is there.
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
      const run = change.run ? ({ run: true } as const) : {};
      for (const { from, to } of deletes) {
        const here: boolean = !inserted && from === at;
        carried.push({
          from,
          remove: to - from,
          ...(here ? { insert: change.insert, ...run } : { insert: '' }),
        });
        inserted ||= here;
      }
      if (!inserted && change.insert !== '') {
        carried.push({ from: at, remove: 0, insert: change.insert, ...run });
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

/**
 * Make `changes`, in order and none overlapping, to `text`: from the last,
 * so each place holds. A run goes in at the middle of what it replaces, not
 * its start (#720): typing someone does just before or after it meanwhile,
 * put in beside the same character, then stays on its side of the run,
 * where at either end Yjs could put it on the other. Two people's runs of
 * the same text, at once, go in at the same place, side by side.
 */
export function putInto(text: Y.Text, changes: readonly TextChange[]): void {
  const runs = changes.some((change) => change.run && change.remove > 1);
  const now = runs ? text.toJSON() : '';
  for (const change of changes.toReversed()) {
    const insert = change.insert.toWellFormed();
    let middle = change.run && insert !== '' ? change.remove >> 1 : 0;
    while (middle > 0 && splits(now, change.from + middle)) middle--;
    if (middle === 0) {
      if (change.remove > 0) text.delete(change.from, change.remove);
      if (insert !== '') text.insert(change.from, insert);
      continue;
    }
    // Put in while the characters each side are there: beside a deleted
    // one, Yjs may put it on either side of what's deleted.
    text.insert(change.from + middle, insert);
    text.delete(change.from + middle + insert.length, change.remove - middle);
    text.delete(change.from, middle);
  }
}

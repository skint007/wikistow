// The visual editor's own edits, as they go into a live session's `body`
// (ADR 0015 decision 3, **Its own edits**): each run of lines it changed,
// as the smallest change in characters from the text it last took in, and,
// where someone else's change has reached `body` but not the editor yet,
// carried onto `body` as it is now by a character diff, so both people's
// typing stays. Every change starts and ends between whole characters,
// never inside an emoji's two halves, which Yjs would store as two U+FFFD.
// A line whose formatting alone changed goes in whole, as one run (#720).
import { diffArrays, diffChars, diffLines, type ChangeObject } from 'diff';
import type * as Y from 'yjs';

/** A change to a text: delete `remove` UTF-16 units at `from`, then insert `insert` there. */
export type TextChange = {
  readonly from: number;
  readonly remove: number;
  readonly insert: string;
  /** A run whose formatting alone changed, put in whole (`ownChanges`). */
  readonly run?: true;
};

// A tag the visual editor writes a mark with, a highlight's or a colour's,
// opening or closing, not escaped: anywhere, or where a text starts.
const TAG = /(?<!(?<!\\)(?:\\\\)*\\)<\/?(?:mark|span)(?:\s[^<>]*)?>/g;
const TAG_HERE = new RegExp(`^${TAG.source}`);

/**
 * The words `markdown` shows, without its formatting: the tags of marks,
 * and the marks emphasis, highlights, strikethrough and code are written
 * with, taken out, an escaped character kept as itself. Rough, but the
 * same for the same words however they're formatted, which is all it's for.
 */
export const wordsOf = (markdown: string) =>
  markdown
    .replace(TAG, '')
    .replace(/\\([^\n])|==|~~|[*_`]/g, (_, escaped: string | undefined) => escaped ?? '');

// Text as a diff by tokens sees it: a tag, a run of marks, an escape, a
// run of spaces, a word (as `partsOf` parts them), or one character else.
const TOKEN = new RegExp(
  `${TAG.source}|\\\\[\\s\\S]|[*_=~\`]+|\\s+|[^\\s*_=~\`\\\\<\\-/\\u2010-\\u2015]+|[\\s\\S]`,
  'g',
);

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
 * Where `text` parts into words: 1 at each space, line break, hyphen, dash
 * or slash outside an HTML tag, so a tag's attributes stay with the word it
 * marks, and the two halves of `foo-bar` are two words. Other punctuation
 * stays with its word, as a selection of `world!` takes it in.
 */
function partsOf(text: string): Uint8Array {
  const parts = new Uint8Array(text.length);
  let inTag = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? '';
    if (char === '<' && TAG_HERE.test(text.slice(i, i + 512))) inTag = true;
    else if (char === '>') inTag = false;
    if (!inTag && /[\s\-/\u2010-\u2015]/.test(char)) parts[i] = 1;
  }
  return parts;
}

// A code span, its opening backticks not escaped, on one line or more
// with no blank one between; a fence's line, in a quote or a list item too.
const CODE_SPAN = /(?<!(?<!\\)(?:\\\\)*\\)(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;
const FENCE = /^((?:[ \t]*>)*)([ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})(.*)$/;
const fenceOf = (line: string) => {
  const [, , lead = '', fence = '', info = ''] = FENCE.exec(line.replace(/\r$/, '')) ?? [];
  // A backtick fence's info string has no backtick: ```code``` is a code span.
  return fence && !(fence[0] === '`' && info.includes('`')) ? { lead, fence, info } : null;
};

/** Whether `run`'s tags of marks don't all close in it, as one end of a tag over several words. */
export const endOfTag = (run: string) => {
  const tags = run.match(TAG) ?? [];
  return tags.filter((tag) => tag.startsWith('</')).length * 2 !== tags.length;
};

// A tag of a mark where a text ends.
const TAG_END = new RegExp(`(?:${TAG.source})$`);

/**
 * Whether `text` is shaped as the run of a highlight or colour is: a tag
 * of a mark at each end, or, one end of a tag over several words, at one.
 */
export const runShaped = (text: string) => {
  // Less punctuation outside its tags, as a selection of `world` leaves the `!`.
  const inner = text.replace(/^[^\p{L}\p{N}\s<>*_=~`\\]+|[^\p{L}\p{N}\s<>*_=~`\\]+$/gu, '');
  return endOfTag(inner)
    ? TAG_HERE.test(inner) || TAG_END.test(inner)
    : TAG_HERE.test(inner) && TAG_END.test(inner);
};
const fenced = (text: string) => text.split('\n').some((line) => fenceOf(line));

/**
 * Whether `text` ends in a fenced code block: one opened and not yet
 * closed, by a fence as long or longer of its character, or by the end of
 * the quote or list item it's in.
 */
function inFence(text: string, next = ''): boolean {
  let open: { fence: string; depth: number; indent: number } | null = null;
  // Whole lines only: what follows the last break is the line being read.
  for (const line of text.split('\n').slice(0, -1)) {
    const quote = /^(?:[ \t]*>)*/.exec(line)?.[0] ?? '';
    const depth = quote.split('>').length - 1;
    const rest = line.slice(quote.length);
    const indent = rest.length - rest.trimStart().length;
    if (open && (depth < open.depth || (rest.trim() !== '' && indent < open.indent))) open = null;
    const found = fenceOf(line);
    if (!found) continue;
    const { lead, fence, info } = found;
    if (!open) open = { fence, depth, indent: /[-*+.)]/.test(lead) ? lead.length : 0 };
    else if (fence[0] === open.fence[0] && fence.length >= open.fence.length && !info.trim())
      open = null;
  }
  if (!open) return false;
  // Ended by the next line, as a quote's or a list item's end ends it.
  const line = next.split('\n', 1)[0]?.replace(/\r$/, '') ?? '';
  const quote = /^(?:[ \t]*>)*/.exec(line)?.[0] ?? '';
  const rest = line.slice(quote.length);
  const indent = rest.length - rest.trimStart().length;
  return !(
    quote.split('>').length - 1 < open.depth ||
    (rest.trim() !== '' && indent < open.indent)
  );
}

/**
 * `now`, the text `was` became, as changes by whole tokens (`TOKEN`) from
 * `at`: so a word is never lined up with a tag's name, as `mark` with
 * `<mark`. Null if the diff takes too long.
 */
function byTokens(was: string, now: string, at: number): TextChange[] | null {
  const parts = diffArrays(was.match(TOKEN) ?? [], now.match(TOKEN) ?? [], { timeout: DIFF_MS });
  if (!parts) return null;
  const changes: TextChange[] = [];
  let [from, remove, insert] = [at, 0, ''];
  for (const part of parts) {
    const text = part.value.join('');
    if (part.removed) remove += text.length;
    else if (part.added) insert += text;
    else {
      if (remove > 0 || insert !== '') changes.push({ from, remove, insert });
      from += remove + text.length;
      [remove, insert] = [0, ''];
    }
  }
  if (remove > 0 || insert !== '') changes.push({ from, remove, insert });
  return changes;
}

/**
 * Changes of whole words: from `from` to `to` in the text they change, and
 * from `nowFrom` to `nowTo` in what it becomes.
 */
type Stretch = { from: number; to: number; nowFrom: number; nowTo: number; changes: TextChange[] };

/**
 * `changes`, of the lines from `at` in a longer text that read `was` and
 * now `now`, with formatting put in as runs (#720). A stretch of whole
 * words, parted by spaces outside HTML tags, whose words stay the same
 * (`wordsOf`) while two marks or more change, as a mark has two ends, or a
 * tag does (outside code), goes in as one run: of a tag over several
 * words, each end's word its own. So two people formatting the same words
 * at once, whatever marks each adds or takes off, each put in a whole run
 * in place of the same characters, which the binding settles to one,
 * where by character the changes interleave into tags neither wrote.
 * Typing, one mark typed, as `_` in code, and a mark over several words,
 * whose ends are a mark each, go in by character as before, so what
 * someone else does among the words a mark covers stays as they did it.
 */
function inRuns(
  changes: TextChange[],
  was: string,
  now: string,
  at: number,
  before: string,
): TextChange[] {
  const parts = partsOf(was);
  const stretches: Stretch[] = [];
  let shift = 0;
  for (const change of byTokens(was, now, at) ?? changes) {
    let from = change.from - at;
    let to = from + change.remove;
    while (from > 0 && !parts[from - 1]) from--;
    while (to < was.length && !parts[to]) to++;
    let stretch = stretches.at(-1);
    if (stretch && from < stretch.to) {
      stretch.to = Math.max(stretch.to, to);
      stretch.changes.push(change);
    } else {
      stretch = { from, to, nowFrom: from + shift, nowTo: 0, changes: [change] };
      stretches.push(stretch);
    }
    shift += change.insert.length - change.remove;
    stretch.nowTo = stretch.to + shift;
  }
  const formatted = (stretch: Stretch) => {
    const words = wordsOf(was.slice(stretch.from, stretch.to));
    return words !== '' && words === wordsOf(now.slice(stretch.nowFrom, stretch.nowTo));
  };
  // A tag of a mark changed in it, as a highlight or colour put on or
  // taken off. Marks written with characters, as `**` or `==`, go in by
  // character, as typed ones do: each end outside the word, they go
  // around another's run, not into it.
  const tags = (text: string) => text.match(TAG)?.join('') ?? '';
  const whole = (s: Stretch) =>
    tags(was.slice(s.from, s.to)) !== tags(now.slice(s.nowFrom, s.nowTo));
  // The whole stretch, punctuation and all, so another's run of the
  // word, whatever their selection took in, replaces the same characters.
  const run = (stretch: Stretch): TextChange => ({
    from: stretch.from + at,
    remove: stretch.to - stretch.from,
    insert: now.slice(stretch.nowFrom, stretch.nowTo),
    run: true,
  });
  // Text in code is text, whatever it looks like: no run that changes
  // anything inside a code span's backticks. Tags around one are marks.
  let spans: [number, number][] | null = null;
  const inCode = (s: Stretch) => {
    spans ??= [...was.matchAll(CODE_SPAN)].map((m) => [m.index, m.index + m[0].length]);
    return s.changes.some((change) => {
      const [from, to] = [change.from - at, change.from - at + change.remove];
      return (spans ?? []).some(([start, end]) => from > start && to < end);
    });
  };
  const runs = stretches.filter((s) => formatted(s) && whole(s));
  if (runs.length === 0) return changes;
  // In a fenced block, or one starting or ending here: none at all.
  if (fenced(was) || fenced(now) || inFence(before.slice(0, at), was)) return changes;
  const kept = runs.filter((stretch) => !inCode(stretch));
  if (kept.length === 0) return changes;
  // The rest by character, as before, each stretch apart, as the diff of
  // the whole can line a run's characters up with another stretch's.
  const out = stretches.flatMap((stretch) =>
    kept.includes(stretch)
      ? [run(stretch)]
      : ownChanges(
          was.slice(stretch.from, stretch.to),
          now.slice(stretch.nowFrom, stretch.nowTo),
          false,
        ).map((change) => ({ ...change, from: change.from + stretch.from + at })),
  );
  // Only as the changes were: each run makes what they made.
  const local = out.map((change) => ({ ...change, from: change.from - at }));
  return applyTo(was, local) === now ? out : changes;
}

/**
 * The changes that make `before` read `after`, each the smallest in
 * characters: by a character diff of the lines between the common start and
 * end, so text the editor didn't change, between or within its changes,
 * stays as it is in `body`, and others' changes there with it. A word
 * whose formatting alone changed is one run (`inRuns`), unless `runs` is
 * false. Past `DIFF_MS`, by lines, each run of lines that differ its
 * smallest change; failing that, one span.
 */
export function ownChanges(before: string, after: string, runs = true): TextChange[] {
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
  return byChars && runs ? inRuns(changes, was, now, start, before) : changes;
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
    if (!change.run || insert === '') {
      if (change.remove > 0) text.delete(change.from, change.remove);
      if (insert !== '') text.insert(change.from, insert);
      continue;
    }
    let middle = change.remove >> 1;
    while (middle > 0 && splits(now, change.from + middle)) middle--;
    // Put in while the characters each side are there: beside a deleted
    // one, Yjs may put it on either side of what's deleted.
    text.insert(change.from + middle, insert);
    text.delete(change.from + middle + insert.length, change.remove - middle);
    if (middle > 0) text.delete(change.from, middle);
  }
}

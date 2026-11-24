// Formatting two people put on the same text at once, which Yjs merged
// into HTML neither wrote (#720; ADR 0015, **Decided while building it**).
// The merge itself stays as it is: most such merges read as both meant,
// as a capital letter typed in a word someone highlights. Before the visual
// editor's binding takes in someone else's change, it looks at each block
// the change touched. One that no longer reads cleanly, where this app's
// own writing of it, made in the last few seconds, did, goes back to that
// writing on the lines that don't read cleanly, by one app only: the one
// with the highest Yjs client among those with text on those lines the
// others hadn't. Every app works that out from the same text.
import { isColor, parseMarkdown } from '@wikistow/client/markdown';
import type { Nodes } from 'mdast';
import * as Y from 'yjs';
import type { Mapping, TextChange, Theirs } from './live-text';

/** Characters of one Yjs client, from `clock`, `length` of them, deleted or put in `at`. */
type Clocks = {
  readonly client: number;
  readonly clock: number;
  readonly length: number;
  readonly at: number;
};

/**
 * A stretch of this app's writing into `body` with nobody else's change
 * between: its Yjs client, the state of `body` it was written on, and the
 * text it put in and deleted in the last `REPAIR_MS` (deletions null once
 * too many to keep).
 */
export type Writing = {
  readonly client: number;
  readonly seen: ReadonlyMap<number, number>;
  put: Clocks[];
  deleted: Clocks[] | null;
};

// Past this many, older writings are forgotten, and so are deletions of one.
export const WRITINGS = 64;
const DELETIONS = 256;
/**
 * How long after it wrote a block an app may repair it. Two people's
 * changes to it in this time can be at once, as each reaches the other
 * within a second or two; after it, someone else's change was most likely
 * made knowing this app's, as by hand in source mode, and stays.
 */
export const REPAIR_MS = 3_000;
// The reader is used on a block no longer than this, as it reads it quickly.
const READ_AT_MOST = 1_024;

/** The writing to put text in as: `last`, while nobody else changed `body` since, else one anew. */
export function writingOf(doc: Y.Doc, last: Writing | undefined, heard: boolean): Writing {
  if (last && !heard && last.client === doc.clientID) return last;
  return {
    client: doc.clientID,
    seen: Y.decodeStateVector(Y.encodeStateVector(doc)),
    put: [],
    deleted: [],
  };
}

/** Keep with `writing` what `put` puts into `doc` in `transaction`, at `now`. */
export function wrote(
  writing: Writing,
  doc: Y.Doc,
  transaction: Y.Transaction,
  now: number,
  put: () => void,
): void {
  const from = Y.getState(doc.store, writing.client);
  put();
  const to = Y.getState(doc.store, writing.client);
  // What went in longer ago than a repair looks back is forgotten.
  const since = (c: Clocks) => now - c.at <= REPAIR_MS;
  writing.put = writing.put.filter(since);
  if (to > from)
    writing.put.push({ client: writing.client, clock: from, length: to - from, at: now });
  if (!writing.deleted) return;
  writing.deleted = writing.deleted.filter(since);
  for (const [client, items] of transaction.deleteSet.clients)
    for (const { clock, len } of items) {
      if (writing.deleted.length >= DELETIONS) return void (writing.deleted = null);
      writing.deleted.push({ client, clock, length: len, at: now });
    }
}

/** `writings`, with only what they put in and deleted within `REPAIR_MS` of `now`; none left with nothing. */
function recentOf(writings: readonly Writing[], now: number): Writing[] {
  const since = (c: Clocks) => now - c.at <= REPAIR_MS;
  return writings.flatMap((w) => {
    const put = w.put.filter(since);
    const deleted = w.deleted?.filter(since) ?? null;
    return put.length > 0 || deleted?.length !== 0 ? [{ ...w, put, deleted }] : [];
  });
}

// --- Whether text reads cleanly -------------------------------------------

const NAMES = ['span', 'mark'] as const;
// Characters that make Markdown, or a new line, inside a colour's HTML,
// where a mark could start in it and end outside, or the other way.
const MARKING = new Set('*_~=[]!`\\|$\n<>');
// The longest colour tag the visual editor writes, `<mark data-color="purple">`, and some.
const LONGEST_TAG = 32;
// A colour's opening tag, exactly as the visual editor writes it and the reader reads it.
const COLOR_TAG = /^<(span|mark) data-color="([a-z]+)">$/;
// A line that may start code or HTML of its own: four spaces or a tab, or `<`.
const CODE_OR_HTML = /^(?: {4}|\t| {0,3}<)/;

const isNameChar = (code: number) =>
  (code >= 97 && code <= 122) ||
  (code >= 65 && code <= 90) ||
  (code >= 48 && code <= 57) ||
  code === 45;

/** Whether the character at `at` is escaped, by an odd number of backslashes before it. */
function escaped(text: string, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && text.charCodeAt(i) === 92 && slashes < 64; i--) slashes++;
  return slashes % 2 === 1;
}

/** The tag named `span` or `mark`, any case, that `text` starts at `at`, not escaped; else null. */
function tagAt(text: string, at: number): { name: 'span' | 'mark'; closing: boolean } | null {
  if (text.charCodeAt(at) !== 60 || escaped(text, at)) return null;
  const closing = text.charCodeAt(at + 1) === 47;
  const start = at + (closing ? 2 : 1);
  for (const name of NAMES) {
    if (text.slice(start, start + 4).toLowerCase() !== name) continue;
    return isNameChar(text.charCodeAt(start + 4)) ? null : { name, closing };
  }
  return null;
}

/**
 * Whether `text` from `at` starts three or more `=` beside a character
 * that isn't a space: a highlight's `==` written twice (`====world====`),
 * which the reader shows as text, as no Markdown makes it.
 */
function equalsAt(text: string, at: number): boolean {
  if (text.charCodeAt(at) !== 61 || text.charCodeAt(at - 1) === 61) return false;
  let end = at;
  while (text.charCodeAt(end) === 61) end++;
  if (end - at < 3 || escaped(text, at)) return false;
  const solid = (i: number) => i >= 0 && i < text.length && !/\s/.test(text[i] as string);
  return solid(at - 1) || solid(end);
}

/** Whether `text` holds anything that may not read cleanly (`tagAt`, `equalsAt`). */
function suspect(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if ((code === 60 && tagAt(text, at)) || (code === 61 && equalsAt(text, at))) return true;
  }
  return false;
}

/** Whether text reads cleanly; `unsure` where the scan can't tell and the block is too long to read. */
export type Reading = 'clean' | 'broken' | 'unsure';

/**
 * How `block` reads, by one scan of it, or null where only the reader can
 * tell, as where Markdown marks lie inside a colour's HTML, or code may
 * hold what looks like a tag. It reads cleanly where every tag named
 * `span` or `mark` is a colour's, as the visual editor writes it, opened
 * and closed in turn, none inside one of its own kind, and no run of `=`
 * is a highlight's written twice.
 */
function scanned(block: string): Reading | null {
  const open: ('span' | 'mark')[] = [];
  let clean = true;
  // Something only the reader can tell: a mark inside a colour, or a tag written otherwise.
  let unsure = false;
  let code = CODE_OR_HTML.test(block.slice(0, 4));
  for (let at = 0; at < block.length; at++) {
    const char = block.charCodeAt(at);
    if (char === 96 || char === 126) code = true;
    else if (char === 10 && CODE_OR_HTML.test(block.slice(at + 1, at + 5))) code = true;
    else if (char === 61 && equalsAt(block, at)) clean = false;
    const tag = tagAt(block, at);
    if (!tag) {
      if (open.length > 0 && MARKING.has(block[at] as string)) unsure = true;
      continue;
    }
    if (tag.closing) {
      if (block.slice(at, at + 7) !== `</${tag.name}>`) unsure = true;
      else if (open.pop() !== tag.name) clean = false;
      else at += 6;
      continue;
    }
    const end = block.slice(at, at + LONGEST_TAG).indexOf('>');
    const named = end < 0 ? null : COLOR_TAG.exec(block.slice(at, at + end + 1));
    if (!named || !isColor(named[2]) || open.includes(tag.name)) {
      clean = false;
      continue;
    }
    open.push(tag.name);
    at += end;
  }
  if (open.length > 0) clean = false;
  // Code may hold any of it; where none can, a tag as written is as read.
  if (code) return null;
  if (!clean) return 'broken';
  return unsure ? null : 'clean';
}

const COLORED = new Set(['colorHighlight', 'highlight']);

/**
 * How the reader reads `block`: broken where a tag named `span` or `mark`
 * is left as HTML or as text, which the visual editor shows as written, a
 * highlight's `==` written twice is shown as text, or a highlight is in a
 * highlight or a colour in a colour, which it shows as one.
 */
function read(block: string): Reading {
  let tree: Nodes;
  try {
    tree = parseMarkdown(block);
  } catch {
    return 'broken';
  }
  const stack: { node: Nodes; marked: boolean; colored: boolean }[] = [
    { node: tree, marked: false, colored: false },
  ];
  for (let at = stack.pop(); at; at = stack.pop()) {
    const { node } = at;
    if (node.type === 'html' || node.type === 'text') {
      // As written, so an escaped `\<span` is text as it means to be.
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const written =
        start === undefined || end === undefined ? node.value : block.slice(start, end);
      if (suspect(written)) return 'broken';
    }
    const marks = COLORED.has(node.type);
    const colors = node.type === 'textColor';
    if ((marks && at.marked) || (colors && at.colored)) return 'broken';
    if (!('children' in node)) continue;
    for (const child of node.children)
      stack.push({ node: child, marked: at.marked || marks, colored: at.colored || colors });
  }
  return 'clean';
}

/**
 * How `block` reads, as the reader reads colour: by one scan, and where
 * that can't tell, by the reader, if it's short enough to read quickly.
 * One with nothing that may not read cleanly is decided in one look at it.
 */
export function readingOf(block: string): Reading {
  if (!suspect(block)) return 'clean';
  const scan = scanned(block);
  if (scan) return scan;
  return block.length <= READ_AT_MOST ? read(block) : 'unsure';
}

/** Whether `block` reads cleanly (`readingOf`). */
export const readsCleanly = (block: string) => readingOf(block) === 'clean';

// --- Blocks, lines and fences -----------------------------------------------

const isBlank = (text: string, from: number, to: number) => {
  for (let at = from; at < to; at++) {
    const code = text.charCodeAt(at);
    if (code !== 32 && code !== 9 && code !== 13) return false;
  }
  return true;
};
const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;
const lineEnd = (text: string, at: number) => {
  const end = text.indexOf('\n', at);
  return end < 0 ? text.length : end;
};

/** A stretch of a text. */
type Span = { from: number; to: number };

/**
 * The blocks of `text` that `spans`, in order, touch, each its lines
 * between blank ones, in order, none overlapping: so each character is
 * looked at once.
 */
export function blocksOf(text: string, spans: readonly Span[]): Span[] {
  const blocks: Span[] = [];
  for (const span of spans) {
    const last = blocks.at(-1);
    if (last && span.from <= last.to) {
      if (span.to > last.to) last.to = paragraphEnd(text, span.to);
      continue;
    }
    let from = lineStart(text, span.from);
    while (from > 0) {
      const above = lineStart(text, from - 1);
      if (isBlank(text, above, from - 1) || (last && above <= last.to)) break;
      from = above;
    }
    blocks.push({ from, to: paragraphEnd(text, span.to) });
  }
  return blocks;
}

function paragraphEnd(text: string, at: number): number {
  let to = lineEnd(text, at);
  while (to < text.length) {
    const next = lineEnd(text, to + 1);
    if (isBlank(text, to + 1, next)) break;
    to = next;
  }
  return to;
}

/** The lines of `text` from `from` to `to`, each without its line break. */
function linesOf(text: string, from: number, to: number): Span[] {
  const lines: Span[] = [];
  for (let at = from; at <= to;) {
    const end = Math.min(lineEnd(text, at), to);
    lines.push({ from: at, to: end });
    at = end + 1;
  }
  return lines;
}

// A fence's or a math block's line, after what may stand before it: spaces,
// quote markers and list markers. Run on one line at a time.
const FENCE = /^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])[ \t]?)*[ \t]*(`{3,}|~{3,}|\$\$)/;

/**
 * Whether places of `text`, asked in order, lie in a code fence or a math
 * block left open above them, read once from the top: a block between
 * blank lines may be part of one, whose text is no Markdown.
 */
class Fences {
  readonly #text: string;
  #at = 0;
  #open: string | null = null;
  constructor(text: string) {
    this.#text = text;
  }
  inside(place: number): boolean {
    while (this.#at < place) {
      const end = lineEnd(this.#text, this.#at);
      const fence = FENCE.exec(this.#text.slice(this.#at, Math.min(end, this.#at + 200)))?.[1];
      if (fence) {
        const open = this.#open;
        if (open === null) this.#open = fence.startsWith('$') ? '$$' : fence;
        else if (fence[0] === open[0] && fence.length >= open.length) this.#open = null;
      }
      this.#at = end + 1;
    }
    return this.#open !== null;
  }
}

// --- Who repairs, and what -------------------------------------------------

/** An item of `body` in a block: whose, its clocks, where it is, and what it was put in beside. */
type Found = {
  readonly client: number;
  readonly clock: number;
  readonly length: number;
  readonly at: number;
  readonly deleted: boolean;
  readonly beside: readonly (Y.ID | null)[];
};

/** The items of `text` in each of `spans`, in order and none overlapping, read in one walk. */
function itemsIn(text: Y.Text, spans: readonly Span[]): Found[][] {
  const found: Found[][] = spans.map(() => []);
  let at = 0;
  let next = 0;
  for (let item = text._start; item && next < spans.length; item = item.right) {
    if (!item.countable) continue;
    const length = item.deleted ? 0 : item.length;
    while (next < spans.length && at > (spans[next] as Span).to) next++;
    for (let i = next; i < spans.length; i++) {
      const { from, to } = spans[i] as Span;
      if (from > at + length) break;
      const inside = item.deleted ? at >= from && at <= to : at + length > from && at < to;
      if (!inside) continue;
      found[i]?.push({
        client: item.id.client,
        clock: item.id.clock,
        length: item.length,
        at,
        deleted: item.deleted,
        beside: [item.origin, item.rightOrigin],
      });
    }
    at += length;
  }
  return found;
}

const touches = (span: Span, at: number, end: number) => end >= span.from && at <= span.to;
const onAny = (spans: readonly Span[], at: number, end: number) =>
  spans.some((span) => touches(span, at, end));

/** Whether `clocks` hold some of `client`'s from `clock` to `end`. */
const holds = (clocks: readonly Clocks[], client: number, clock: number, end: number) =>
  clocks.some((c) => c.client === client && c.clock < end && c.clock + c.length > clock);

/** The first of `writings` that put in some of `client`'s clocks `clock` to `end`, or -1. */
const writingWith = (writings: readonly Writing[], client: number, clock: number, end: number) =>
  writings.findIndex((w) => holds(w.put, client, clock, end));

/**
 * Whether this app is the one to repair a block whose `items` these are,
 * where `broken` are the lines that don't read cleanly: if it put text on
 * them in its `recent` writing, and every other app with text on them it
 * hadn't when it first wrote there has a lower Yjs client. Not if someone
 * changed the block knowing what it wrote: putting text in beside its
 * writing, or deleting some, which a repair would undo; nor if the person
 * changed it from elsewhere in this app, as the source pane of split view.
 */
function repairs1(
  items: readonly Found[],
  broken: readonly Span[],
  recent: readonly Writing[],
  clients: ReadonlySet<number>,
): boolean {
  if (recent.some((w) => w.deleted === null)) return false;
  const deleted = recent.flatMap((w) => w.deleted ?? []);
  const end = (item: Found) => item.clock + item.length;
  const deletedBy = (item: Found) => holds(deleted, item.client, item.clock, end(item));
  // The first recent writing with text on the broken lines.
  let first = -1;
  for (const item of items) {
    if (item.deleted || !onAny(broken, item.at, item.at + item.length)) continue;
    const i = writingWith(recent, item.client, item.clock, end(item));
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  const writing = recent[first];
  if (!writing) return false;
  const fresh = (client: number, clock: number, to: number) =>
    writingWith(recent, client, clock, to) >= 0;
  const unseen = (item: Found) => end(item) > (writing.seen.get(item.client) ?? 0);
  for (const item of items) {
    if (fresh(item.client, item.clock, end(item))) {
      // Its own text, deleted by someone who had it.
      if (item.deleted && !deletedBy(item)) return false;
      continue;
    }
    if (!unseen(item)) continue;
    // The person's own, from elsewhere in this app.
    if (clients.has(item.client)) return false;
    if (item.beside.some((id) => id !== null && fresh(id.client, id.clock, id.clock + 1)))
      return false;
    if (item.deleted || !onAny(broken, item.at, item.at + item.length)) continue;
    if (item.client > writing.client) return false;
  }
  return true;
}

/** `theirs`, others' changes in `body`, undone: what they put in out, what they took out back in. */
function undone(theirs: readonly Theirs[], held: string): TextChange[] {
  return theirs.map((change) => ({
    from: change.body,
    remove: change.bodyEnd - change.body,
    insert: held.slice(change.held, change.heldEnd),
  }));
}

/** `text`, which starts at `at` in a longer one, with `changes`, in places of that, made. */
function applied(text: string, at: number, changes: readonly TextChange[]): string {
  let out = '';
  let from = 0;
  for (const change of changes) {
    out += text.slice(from, change.from - at) + change.insert;
    from = change.from - at + change.remove;
  }
  return out + text.slice(from);
}

/** A block to repair, if this app is the one to. */
type Candidate = { block: Span; broken: Span[]; theirs: Theirs[] };

/**
 * The changes to `body` that put back what others' changes, merged with
 * this app's, left not reading cleanly, as this app wrote it (`held`):
 * each block someone else's change touched since this app took one in,
 * which reads cleanly as it wrote it within the last `REPAIR_MS`, but no
 * longer does, if it is the one to repair it. On each line that doesn't
 * read cleanly, the others' changes are undone, so it reads as this app
 * wrote it; theirs on other lines stay. If the block still doesn't read
 * cleanly, all theirs in it are undone.
 */
export function repairs(
  text: Y.Text,
  body: string,
  held: string,
  map: Mapping,
  writings: readonly Writing[],
  now: number,
): TextChange[] {
  const recent = recentOf(writings, now);
  if (recent.length === 0) return [];
  const theirs = map.theirs();
  if (theirs.length === 0) return [];
  const candidates: Candidate[] = [];
  const fences = new Fences(body);
  let next = 0;
  for (const block of blocksOf(
    body,
    theirs.map((change) => ({ from: change.body, to: change.bodyEnd })),
  )) {
    const inside: Theirs[] = [];
    let across = false;
    for (; next < theirs.length && (theirs[next] as Theirs).body <= block.to; next++) {
      const change = theirs[next] as Theirs;
      if (change.bodyEnd > block.to || change.body < block.from) across = true;
      inside.push(change);
    }
    if (across || inside.length === 0) continue;
    const shown = body.slice(block.from, block.to);
    if (readingOf(shown) !== 'broken') continue;
    if (readingOf(applied(shown, block.from, undone(inside, held))) !== 'clean') continue;
    if (fences.inside(block.from)) continue;
    const lines = linesOf(body, block.from, block.to);
    const broken = lines.filter((line) => readingOf(body.slice(line.from, line.to)) !== 'clean');
    candidates.push({ block, broken: broken.length > 0 ? broken : lines, theirs: inside });
  }
  if (candidates.length === 0) return [];
  const clients = new Set(writings.map((w) => w.client));
  const items = itemsIn(
    text,
    candidates.map((c) => c.block),
  );
  const out: TextChange[] = [];
  for (const [i, { block, broken, theirs: inside }] of candidates.entries()) {
    if (!repairs1(items[i] ?? [], broken, recent, clients)) continue;
    const shown = body.slice(block.from, block.to);
    const onBroken = undone(
      inside.filter((c) => onAny(broken, c.body, c.bodyEnd)),
      held,
    );
    const all = undone(inside, held);
    out.push(...(readingOf(applied(shown, block.from, onBroken)) === 'clean' ? onBroken : all));
  }
  return out;
}

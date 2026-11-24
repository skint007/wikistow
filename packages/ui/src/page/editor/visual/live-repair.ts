// Formatting two people put on the same text at once, which Yjs merged
// into HTML neither wrote (#720; ADR 0015, **Decided while building it**).
// The merge itself stays as it is: most such merges read as both meant,
// as a capital letter typed in a word someone highlights. Before the visual
// editor's binding takes in someone else's change, it looks at each block
// the change touched. One that no longer reads cleanly, where this app's
// own writing of it, made in the last few seconds, did, goes back to that
// writing on the lines that don't read cleanly, by one app only: the one
// with the highest Yjs client among those whose text, the others hadn't,
// touches what doesn't read cleanly. Every app works that out from the same text.
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
  /** When `deleted` became too many to keep. */
  full: number;
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
    full: 0,
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
  if (!writing.deleted && now - writing.full > REPAIR_MS) writing.deleted = [];
  if (!writing.deleted) return;
  writing.deleted = writing.deleted.filter(since);
  for (const [client, items] of transaction.deleteSet.clients)
    for (const { clock, len } of items) {
      if (writing.deleted.length >= DELETIONS) {
        writing.deleted = null;
        writing.full = now;
        return;
      }
      writing.deleted.push({ client, clock, length: len, at: now });
    }
}

/** `writings`, with only what they put in and deleted within `REPAIR_MS` of `now`; none left with nothing. */
function recentOf(writings: readonly Writing[], now: number): Writing[] {
  const since = (c: Clocks) => now - c.at <= REPAIR_MS;
  return writings.flatMap((w) => {
    const put = w.put.filter(since);
    // Too many to keep, a while ago: nothing it deleted is recent now.
    const deleted = w.deleted?.filter(since) ?? (now - w.full > REPAIR_MS ? [] : null);
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
 * The end of the run of exactly four `=` that `text` starts at `at`,
 * beside a character that isn't a space, not escaped: a highlight's `==`
 * written twice (`====world====`), which the reader shows as text. Else -1.
 * The visual editor writes three or more as text (`x===y`), but never four
 * against a word with nothing else between.
 */
function equalsAt(text: string, at: number): number {
  if (text.charCodeAt(at) !== 61 || text.charCodeAt(at - 1) === 61) return -1;
  let end = at;
  while (text.charCodeAt(end) === 61 && end - at < 5) end++;
  if (end - at !== 4 || escaped(text, at)) return -1;
  const solid = (i: number) => i >= 0 && i < text.length && !/\s/.test(text[i] as string);
  return solid(at - 1) || solid(end) ? end : -1;
}

/** Whether `text` holds anything that may not read cleanly (`tagAt`, `equalsAt`). */
function suspect(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if ((code === 60 && tagAt(text, at)) || (code === 61 && equalsAt(text, at) >= 0)) return true;
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
    else if (char === 61 && equalsAt(block, at) >= 0) clean = false;
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

/**
 * Where a line of `text`, from `from` to `to`, that doesn't read cleanly
 * may: each tag named `span` or `mark` on it, and each highlight's `==`
 * written twice. In order, none overlapping.
 */
function suspectsOn(text: string, from: number, to: number): Span[] {
  const spans: Span[] = [];
  for (let at = from; at < to; at++) {
    const code = text.charCodeAt(at);
    if (code === 60 && tagAt(text, at)) {
      const end = text.slice(at + 1, Math.min(to, at + LONGEST_TAG)).indexOf('>');
      const tagEnd = end < 0 ? Math.min(to, at + 6) : at + end + 2;
      spans.push({ from: at, to: tagEnd });
      at = tagEnd - 1;
    } else if (code === 61) {
      const end = equalsAt(text, at);
      if (end < 0) continue;
      spans.push({ from: at, to: end });
      at = end - 1;
    }
  }
  return spans;
}

/** Whether a stretch `from` to `to` touches any of `spans`, in order and none overlapping. */
function touchesAny(spans: readonly Span[], from: number, to: number): boolean {
  // The first that ends at `from` or later.
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((spans[mid] as Span).to < from) low = mid + 1;
    else high = mid;
  }
  const span = spans[low];
  return span !== undefined && span.from <= to;
}

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

/**
 * A fence's or a math block's line, `text` from `at` to `end`: its run of
 * backticks or tildes, or `$$`, after spaces, quote markers and list
 * markers, and whether those stood before it; or null. One look at each
 * character.
 */
function fenceOn(
  text: string,
  at: number,
  end: number,
): { run: string; nested: boolean; bare: boolean } | null {
  let i = at;
  let nested = false;
  const spaces = () => {
    const start = i;
    while (i < end && (text[i] === ' ' || text[i] === '\t')) i++;
    return i - start;
  };
  for (;;) {
    if (spaces() > 3) nested = true;
    const char = text[i];
    if (char === '>') {
      i++;
      nested = true;
      continue;
    }
    if ((char === '-' || char === '*' || char === '+') && /[ \t]/.test(text[i + 1] ?? '')) {
      i++;
      nested = true;
      continue;
    }
    let digits = i;
    while (digits < end && digits - i < 9 && /[0-9]/.test(text[digits] as string)) digits++;
    if (digits > i && /[.)]/.test(text[digits] ?? '') && /[ \t]/.test(text[digits + 1] ?? '')) {
      i = digits + 1;
      nested = true;
      continue;
    }
    break;
  }
  const char = text[i];
  if (char !== '`' && char !== '~' && char !== '$') return null;
  let runEnd = i;
  while (runEnd < end && text[runEnd] === char) runEnd++;
  const length = runEnd - i;
  if (char === '$' ? length !== 2 : length < 3) return null;
  // A closing fence has nothing after it but spaces.
  let rest = runEnd;
  while (rest < end && (text[rest] === ' ' || text[rest] === '\t' || text[rest] === '\r')) rest++;
  return { run: text.slice(i, runEnd), nested, bare: rest === end };
}

/**
 * Whether places of `text`, asked in order, lie in a code fence or a math
 * block left open above them, read once from the top: a block between
 * blank lines may be part of one, whose text is no Markdown. A fence in a
 * quote or a list item counts for the lines that go on in it, indented
 * or quoted, and ends at the first that doesn't.
 */
class Fences {
  readonly #text: string;
  #at = 0;
  #open: { run: string; nested: boolean } | null = null;
  constructor(text: string) {
    this.#text = text;
  }
  #inIt(at: number) {
    const char = this.#text[at];
    return char === ' ' || char === '\t' || char === '>';
  }
  inside(place: number): boolean {
    const text = this.#text;
    while (this.#at < place) {
      const end = lineEnd(text, this.#at);
      let open = this.#open;
      // The quote or list item it's in ended.
      if (open?.nested && !isBlank(text, this.#at, end) && !this.#inIt(this.#at)) open = null;
      const fence = fenceOn(text, this.#at, end);
      if (fence && !open) {
        // `$$` with more on its line is math within the line.
        if (fence.run !== '$$' || fence.bare) open = fence;
      } else if (fence?.bare && open && fence.run[0] === open.run[0]) {
        if (fence.run.length >= open.run.length) open = null;
      }
      this.#open = open;
      this.#at = end + 1;
    }
    const open = this.#open;
    return open !== null && (!open.nested || this.#inIt(place));
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

/** Whether `clocks` hold some of `client`'s from `clock` to `end`. */
const holds = (clocks: readonly Clocks[], client: number, clock: number, end: number) =>
  clocks.some((c) => c.client === client && c.clock < end && c.clock + c.length > clock);

/** The last of `writings` whose `clocks` hold some of `client`'s from `clock` to `end`, or -1. */
function lastWith(
  writings: readonly Writing[],
  of: (w: Writing) => readonly Clocks[] | null,
  item: Found,
): number {
  for (let i = writings.length - 1; i >= 0; i--)
    if (holds(of(writings[i] as Writing) ?? [], item.client, item.clock, item.clock + item.length))
      return i;
  return -1;
}

/**
 * Whether this app is the one to repair a block whose `items` these are,
 * where `suspects` are what may not read cleanly on its lines that don't
 * (`suspectsOn`). Its writing there is the latest of its `recent` ones
 * whose text or deletions touch them; it is the one if that put text
 * touching them, and every other app with text touching them that it
 * hadn't then has a lower Yjs client. Not if someone changed the block
 * knowing what it wrote: putting text in beside its recent text, or
 * deleting some, which a repair would undo; nor if the person changed it
 * from elsewhere in this app, as the source pane of split view. If it is,
 * where others put text in at the same time that touches none of them,
 * which the repair keeps; else null.
 */
function repairs1(
  items: readonly Found[],
  suspects: readonly Span[],
  recent: readonly Writing[],
  clients: ReadonlySet<number>,
): Span[] | null {
  if (recent.some((w) => w.deleted === null)) return null;
  const near = (item: Found) =>
    touchesAny(suspects, item.at, item.at + (item.deleted ? 0 : item.length));
  const put = (item: Found) => lastWith(recent, (w) => w.put, item);
  const took = (item: Found) => lastWith(recent, (w) => w.deleted, item);
  let latest = -1;
  for (const item of items)
    if (near(item)) latest = Math.max(latest, item.deleted ? took(item) : put(item));
  const writing = recent[latest];
  if (!writing) return null;
  // Only deletions of its own touch them: Yjs doesn't say whose those are, so the others can't tell.
  if (
    !items.some(
      (item) =>
        !item.deleted &&
        near(item) &&
        holds(writing.put, item.client, item.clock, item.clock + item.length),
    )
  )
    return null;
  const fresh = (id: Y.ID | null) =>
    id !== null && recent.some((w) => holds(w.put, id.client, id.clock, id.clock + 1));
  const formatters = new Set<number>();
  const unseen: Found[] = [];
  for (const item of items) {
    if (put(item) >= 0) {
      // Its own recent text, deleted by someone who had it.
      if (item.deleted && took(item) < 0) return null;
      continue;
    }
    if (item.clock + item.length <= (writing.seen.get(item.client) ?? 0)) continue;
    // The person's own, from elsewhere in this app.
    if (clients.has(item.client)) return null;
    if (item.beside.some(fresh)) return null;
    if (item.deleted) continue;
    unseen.push(item);
    if (!near(item)) continue;
    if (item.client > writing.client) return null;
    formatters.add(item.client);
  }
  return unseen
    .filter((item) => !formatters.has(item.client))
    .map((item) => ({ from: item.at, to: item.at + item.length }));
}

/**
 * `theirs`, others' changes in `body`, undone within `lines`, in order and
 * none overlapping: what they put in there out, but for what lies in
 * `kept`, and what they took out there back in. What they put in or took
 * out across a line break stays.
 */
function undoneOn(
  theirs: readonly Theirs[],
  lines: readonly Span[],
  kept: readonly Span[],
  held: string,
): TextChange[] {
  const out: TextChange[] = [];
  // `from` to `to` taken out, but for what's kept, in order.
  let k = 0;
  const takeOut = (from: number, to: number) => {
    while (k < kept.length && (kept[k] as Span).to <= from) k++;
    let at = from;
    for (let i = k; i < kept.length && (kept[i] as Span).from < to; i++) {
      const span = kept[i] as Span;
      if (span.from > at) out.push({ from: at, remove: span.from - at, insert: '' });
      at = Math.max(at, span.to);
    }
    if (to > at) out.push({ from: at, remove: to - at, insert: '' });
  };
  let first = 0;
  for (const change of theirs) {
    while (first < lines.length && (lines[first] as Span).to < change.body) first++;
    for (let i = first; i < lines.length; i++) {
      const line = lines[i] as Span;
      if (line.from > change.bodyEnd) break;
      if (change.bodyEnd > change.body) {
        const from = Math.max(change.body, line.from);
        const to = Math.min(change.bodyEnd, line.to);
        if (to > from) takeOut(from, to);
        continue;
      }
      const was = held.slice(change.held, change.heldEnd);
      if (!was.includes('\n')) out.push({ from: change.body, remove: 0, insert: was });
      break;
    }
  }
  return out;
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
type Candidate = { block: Span; broken: Span[]; suspects: Span[]; theirs: Theirs[] };

/**
 * The changes to `body` that put back what others' changes, merged with
 * this app's, left not reading cleanly, as this app wrote it (`held`):
 * each block someone else's change touched since this app took one in,
 * which reads cleanly as it wrote it within the last `REPAIR_MS`, but no
 * longer does, if it is the one to repair it (`repairs1`). On each line
 * that doesn't read cleanly, the others' changes are undone, so it reads
 * as this app wrote it; theirs on other lines, or across a line break,
 * stay. If the block then still doesn't read cleanly, it is left.
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
    const failing = lines.filter((line) => readingOf(body.slice(line.from, line.to)) !== 'clean');
    const broken = failing.length > 0 ? failing : lines;
    const suspects = broken.flatMap((line) => suspectsOn(body, line.from, line.to));
    candidates.push({ block, broken, suspects, theirs: inside });
  }
  if (candidates.length === 0) return [];
  const clients = new Set(writings.map((w) => w.client));
  const items = itemsIn(
    text,
    candidates.map((c) => c.block),
  );
  const out: TextChange[] = [];
  for (const [i, { block, broken, suspects, theirs: inside }] of candidates.entries()) {
    const kept = repairs1(items[i] ?? [], suspects, recent, clients);
    if (!kept) continue;
    const changes = undoneOn(inside, broken, kept, held);
    if (readingOf(applied(body.slice(block.from, block.to), block.from, changes)) === 'clean')
      out.push(...changes);
  }
  return out;
}

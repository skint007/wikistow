// Formatting two people put on the same text at once, which Yjs merged
// into HTML neither wrote (#720; ADR 0015, **Decided while building it**).
// The merge itself stays as it is: most such merges read as both meant,
// as a capital letter typed in a word someone highlights. After the visual
// editor's binding has someone else's change in `body`, and before it
// takes it in, it looks at each block the change touched. One that now
// shows a colour's HTML as text, when this app's own writing of it didn't,
// is put back as this app wrote it, by one app only: the one with the
// highest Yjs client among those whose text in the block went in at once.
// Every app works that out the same way, so none undoes another's repair.
import { isColor, parseMarkdown } from '@wikistow/client/markdown';
import type { Nodes } from 'mdast';
import * as Y from 'yjs';
import type { Mapping, TextChange, Theirs } from './live-text';

/** Characters deleted by one Yjs client, from `clock`, `length` of them. */
type Deleted = { readonly client: number; readonly clock: number; readonly length: number };

/**
 * A stretch of this app's writing into `body` with nobody else's change
 * between: its Yjs client, from which clock on, the state of `body` it was
 * written on, and what it deleted (null once too much to keep).
 */
export type Writing = {
  readonly client: number;
  readonly from: number;
  readonly seen: ReadonlyMap<number, number>;
  deleted: Deleted[] | null;
};

// Past this many, older writings are forgotten, and so are deletions of one.
export const WRITINGS = 64;
const DELETIONS = 256;

/** The writing `transaction` goes in as: `last`, while nobody else changed `body` since, else one anew. */
export function writingOf(doc: Y.Doc, last: Writing | undefined, heard: boolean): Writing {
  if (last && !heard && last.client === doc.clientID) return last;
  return {
    client: doc.clientID,
    from: Y.getState(doc.store, doc.clientID),
    seen: Y.decodeStateVector(Y.encodeStateVector(doc)),
    deleted: [],
  };
}

/** Keep what `transaction` deleted with `writing`. */
export function noteDeleted(writing: Writing, transaction: Y.Transaction): void {
  for (const [client, items] of transaction.deleteSet.clients)
    for (const { clock, len } of items) {
      if (!writing.deleted) return;
      if (writing.deleted.length >= DELETIONS) return void (writing.deleted = null);
      writing.deleted.push({ client, clock, length: len });
    }
}

// --- Whether a block reads cleanly ---------------------------------------

// A colour's HTML as the visual editor writes it, read by the reader as
// colour, and its end.
const NAMES = ['span', 'mark'] as const;
// Characters that make Markdown, or a new line, inside a colour's HTML,
// where a mark could start in it and end outside, or the other way.
const MARKING = new Set('*_~=[]!`\\|$\n<>');

const isNameChar = (code: number) =>
  (code >= 97 && code <= 122) ||
  (code >= 65 && code <= 90) ||
  (code >= 48 && code <= 57) ||
  code === 45;

/** Whether `text` from `at` starts `<span`, `<mark`, `</span` or `</mark`, as a tag's name, any case. */
function tagAt(text: string, at: number): { name: 'span' | 'mark'; closing: boolean } | null {
  if (text.charCodeAt(at) !== 60) return null;
  const closing = text.charCodeAt(at + 1) === 47;
  const start = at + (closing ? 2 : 1);
  for (const name of NAMES) {
    if (text.slice(start, start + 4).toLowerCase() !== name) continue;
    return isNameChar(text.charCodeAt(start + 4)) ? null : { name, closing };
  }
  return null;
}

/** Whether `text` holds `data-color`, in any case, from `at`. */
const namesColor = (text: string, at: number) =>
  text.slice(at, at + 10).toLowerCase() === 'data-color';

// The longest colour tag the visual editor writes, `<mark data-color="purple">`, and some.
const LONGEST_TAG = 32;
// A colour's opening tag, exactly as the visual editor writes it and the reader reads it.
const COLOR_TAG = /^<(span|mark) data-color="([a-z]+)">$/;
// A line that may start code or HTML of its own: four spaces or a tab, or `<`.
const CODE_OR_HTML = /^(?: {4}|\t| {0,3}<)/;

/**
 * Whether `block` reads cleanly, by one scan of it: true, false, or null
 * where only the reader can tell, as where Markdown marks lie inside a
 * colour's HTML, or code may hold what looks like a tag. It reads cleanly
 * where every tag named `span` or `mark` is a colour's, as the visual
 * editor writes it, opened and closed in turn, none inside one of its own
 * kind, and `data-color` is only in them.
 */
function scanned(block: string): boolean | null {
  const open: ('span' | 'mark')[] = [];
  let clean = true;
  // Something only the reader can tell: a mark inside a colour, or a tag written otherwise.
  let unsure = false;
  let code = CODE_OR_HTML.test(block.slice(0, 4));
  for (let at = 0; at < block.length; at++) {
    const char = block.charCodeAt(at);
    if (char === 96 || char === 126) code = true;
    else if (char === 10 && CODE_OR_HTML.test(block.slice(at + 1, at + 5))) code = true;
    if ((char === 100 || char === 68) && namesColor(block, at)) clean = false;
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
  if (!clean) return false;
  return unsure ? null : true;
}

/** Whether `text` holds a tag named `span` or `mark` anywhere, or `data-color`. */
function namesTag(text: string): boolean {
  for (let at = text.indexOf('<'); at >= 0; at = text.indexOf('<', at + 1))
    if (tagAt(text, at)) return true;
  return text.toLowerCase().includes('data-color');
}

const COLORED = new Set(['colorHighlight', 'highlight']);

/**
 * Whether the reader reads `block` cleanly: no tag named `span` or `mark`
 * left as HTML or as text, which the visual editor shows as written, and
 * no highlight in a highlight or colour in a colour, which it shows as one.
 */
function readCleanly(block: string): boolean {
  let tree: Nodes;
  try {
    tree = parseMarkdown(block);
  } catch {
    return false;
  }
  const stack: { node: Nodes; marked: boolean; colored: boolean }[] = [
    { node: tree, marked: false, colored: false },
  ];
  for (let at = stack.pop(); at; at = stack.pop()) {
    const { node } = at;
    if ((node.type === 'html' || node.type === 'text') && namesTag(node.value)) return false;
    const marks = COLORED.has(node.type);
    const colors = node.type === 'textColor';
    if ((marks && at.marked) || (colors && at.colored)) return false;
    if (!('children' in node)) continue;
    for (const child of node.children)
      stack.push({ node: child, marked: at.marked || marks, colored: at.colored || colors });
  }
  return true;
}

/**
 * Whether `block` reads cleanly as the reader reads colour (`scanned`,
 * then the reader where the scan can't tell). One that names no such tag
 * is decided in one look at it.
 */
export function readsCleanly(block: string): boolean {
  if (!namesTag(block)) return true;
  return scanned(block) ?? readCleanly(block);
}

// --- Which blocks, and who repairs them -----------------------------------

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

/**
 * The blocks of `text` that `spans` touch, each its lines between blank
 * ones, in order, none overlapping: so each character is looked at once.
 */
export function blocksOf(
  text: string,
  spans: readonly { from: number; to: number }[],
): { from: number; to: number }[] {
  const blocks: { from: number; to: number }[] = [];
  for (const span of spans) {
    const last = blocks.at(-1);
    if (last && span.from <= last.to) {
      if (span.to <= last.to) continue;
      last.to = paragraphEnd(text, span.to);
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

/** An item of `body` in a block: whose, its clocks, where it is, and what it was put in beside. */
type Found = {
  readonly client: number;
  readonly clock: number;
  readonly length: number;
  readonly at: number;
  readonly deleted: boolean;
  readonly beside: readonly (Y.ID | null)[];
};

/** The items of `text` that lie in `from` to `to`, a deleted one where it was. */
function itemsIn(text: Y.Text, from: number, to: number): Found[] {
  const found: Found[] = [];
  let at = 0;
  for (let item = text._start; item && at <= to; item = item.right) {
    if (!item.countable) continue;
    const length = item.deleted ? 0 : item.length;
    const inside = item.deleted ? at >= from : at + length > from && at < to;
    if (inside)
      found.push({
        client: item.id.client,
        clock: item.id.clock,
        length: item.length,
        at,
        deleted: item.deleted,
        beside: [item.origin, item.rightOrigin],
      });
    at += length;
  }
  return found;
}

const overlaps = (deleted: readonly Deleted[], item: Found) =>
  deleted.some(
    (d) =>
      d.client === item.client &&
      d.clock < item.clock + item.length &&
      d.clock + d.length > item.clock,
  );

/** A stretch of `body` and the Yjs client that put it in. */
type Put = { readonly client: number; readonly from: number; readonly to: number };

/**
 * Where in `from` to `to` this app wrote in its latest writing there, and
 * what others put in there that it hadn't then, if it is the one to repair
 * it: null if it put nothing in there; if another app whose text in it
 * this app hadn't when it wrote has a higher Yjs client; or if someone
 * changed the block knowing what this app wrote, as by typing beside it or
 * deleting it, which a repair would undo.
 */
function repairer(
  text: Y.Text,
  from: number,
  to: number,
  writings: readonly Writing[],
): { from: number; to: number; theirs: Put[] } | null {
  const items = itemsIn(text, from, to);
  const mine = new Set(writings.map((w) => w.client));
  // The latest writing with text in the block.
  let latest = -1;
  for (const item of items) {
    if (!mine.has(item.client)) continue;
    for (let i = writings.length - 1; i > latest; i--) {
      const w = writings[i] as Writing;
      if (w.client !== item.client || w.from >= item.clock + item.length) continue;
      latest = i;
      break;
    }
  }
  const writing = writings[latest];
  if (!writing) return null;
  const since = writings.slice(latest);
  if (since.some((w) => w.deleted === null)) return null;
  const deleted = since.flatMap((w) => w.deleted ?? []);
  const fresh = (item: Found) =>
    item.client === writing.client && item.clock + item.length > writing.from;
  const knewFresh = (id: Y.ID | null) =>
    id !== null && id.client === writing.client && id.clock >= writing.from;
  let start = Infinity;
  let end = -Infinity;
  const mark = (a: number, b: number) => {
    start = Math.min(start, Math.max(a, from));
    end = Math.max(end, Math.min(b, to));
  };
  let put = false;
  const theirs: Put[] = [];
  for (const item of items) {
    if (fresh(item)) {
      if (item.deleted) {
        // Its own text, deleted by someone who had it.
        if (!overlaps(deleted, item)) return null;
        mark(item.at, item.at);
        continue;
      }
      const skip = Math.max(0, writing.from - item.clock);
      mark(item.at + skip, item.at + item.length);
      put = true;
      continue;
    }
    if (mine.has(item.client)) {
      if (item.deleted && overlaps(deleted, item)) mark(item.at, item.at);
      continue;
    }
    if (item.beside.some(knewFresh)) return null;
    if (item.deleted && overlaps(deleted, item)) mark(item.at, item.at);
    // Theirs, put in on what this app hadn't, from a higher client: theirs to repair.
    const unseen = item.clock + item.length > (writing.seen.get(item.client) ?? 0);
    if (unseen && item.client > writing.client) return null;
    if (unseen && !item.deleted)
      theirs.push({ client: item.client, from: item.at, to: item.at + item.length });
  }
  return put ? { from: start, to: end, theirs } : null;
}

/** `theirs`, others' changes in `body`, undone: what they put in out, what they took out back in. */
function undone(theirs: readonly Theirs[], held: string): TextChange[] {
  return theirs.map((change) => ({
    from: change.body,
    remove: change.bodyEnd - change.body,
    insert: held.slice(change.held, change.heldEnd),
  }));
}

function applied(text: string, at: number, changes: readonly TextChange[]): string {
  let out = '';
  let from = 0;
  for (const change of changes) {
    out += text.slice(from, change.from - at) + change.insert;
    from = change.from - at + change.remove;
  }
  return out + text.slice(from);
}

/**
 * The changes to `body`, if any, that put back blocks others' changes,
 * merged with this app's, left not reading cleanly, where this app's
 * writing of them, `held`, did and it is the one to repair them
 * (`repairer`). In each, only the others' changes within or beside the
 * stretch this app wrote are undone; what they typed farther off in the
 * block stays. Where that still doesn't read cleanly, the block is left.
 */
export function repairs(
  text: Y.Text,
  body: string,
  held: string,
  map: Mapping,
  writings: readonly Writing[],
): TextChange[] {
  if (writings.length === 0) return [];
  const theirs = map.theirs();
  if (theirs.length === 0) return [];
  const out: TextChange[] = [];
  const spans = theirs.map((change) => ({ from: change.body, to: change.bodyEnd }));
  let next = 0;
  for (const block of blocksOf(body, spans)) {
    const inside: Theirs[] = [];
    let across = false;
    for (; next < theirs.length && (theirs[next] as Theirs).body <= block.to; next++) {
      const change = theirs[next] as Theirs;
      if (change.bodyEnd > block.to || change.body < block.from) across = true;
      inside.push(change);
    }
    if (across || inside.length === 0) continue;
    const shown = body.slice(block.from, block.to);
    if (readsCleanly(shown)) continue;
    if (!readsCleanly(applied(shown, block.from, undone(inside, held)))) continue;
    const wrote = repairer(text, block.from, block.to, writings);
    if (!wrote) continue;
    // Theirs within or beside what it wrote; then with formatting farther
    // off put in by whoever put some in there, as a highlight's end.
    const near = (a: number, b: number) => b >= wrote.from && a <= wrote.to;
    const formatters = new Set(wrote.theirs.filter((p) => near(p.from, p.to)).map((p) => p.client));
    const by = wrote.theirs.filter((p) => formatters.has(p.client));
    const ends = (c: Theirs) =>
      c.bodyEnd > c.body &&
      putBy(by, c.body, c.bodyEnd) &&
      formatting(body.slice(c.body, c.bodyEnd));
    const sets = [inside.filter((c) => near(c.body, c.bodyEnd))];
    if (inside.some((c) => !near(c.body, c.bodyEnd) && ends(c)))
      sets.push(inside.filter((c) => near(c.body, c.bodyEnd) || ends(c)));
    for (const set of sets) {
      const changes = undone(set, held);
      if (changes.length === 0 || !readsCleanly(applied(shown, block.from, changes))) continue;
      out.push(...changes);
      break;
    }
  }
  return out;
}

/** Whether `puts`, none overlapping, cover `from` to `to`. */
function putBy(puts: readonly Put[], from: number, to: number): boolean {
  let covered = 0;
  for (const put of puts) covered += Math.max(0, Math.min(to, put.to) - Math.max(from, put.from));
  return covered === to - from;
}

const MARKERS = new Set('*_~=');

/** Whether `text` is only colour tags, whole, and the marks of emphasis, a strike or a highlight. */
function formatting(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    const tag = tagAt(text, at);
    if (tag?.closing && text.slice(at, at + 7) === `</${tag.name}>`) {
      at += 6;
      continue;
    }
    const end = tag && !tag.closing ? text.slice(at, at + LONGEST_TAG).indexOf('>') : -1;
    const named = end < 0 ? null : COLOR_TAG.exec(text.slice(at, at + end + 1));
    if (named && isColor(named[2])) {
      at += end;
      continue;
    }
    if (!MARKERS.has(text[at] as string)) return false;
  }
  return true;
}

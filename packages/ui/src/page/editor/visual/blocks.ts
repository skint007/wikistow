import type { Node, Slice } from '@milkdown/kit/prose/model';
import { Transform } from '@milkdown/kit/prose/transform';
import { normalizeIdentifier } from 'micromark-util-normalize-identifier';
import { BLOCK_TIMED, withLf } from './fidelity';
import { inText, spansOf, type Span } from './sources';

// Text from outside taken into the visual editor a block at a time (ADR
// 0015 decision 3, step 2): only the top-level blocks a change touches are
// read again, with those beside them, as a paste is, not the whole page.

/** A run of a document's top-level blocks that writes as something, and where it is in the page. */
export type Run = {
  /** Its first block, by index, and how many it has. */
  readonly first: number;
  readonly count: number;
  readonly from: number;
  readonly to: number;
};

/** Top-level blocks to put in place of some of a document's, and where every block then is. */
export type Taken = {
  /** The blocks replaced: `count` from the one at index `first`. */
  readonly first: number;
  readonly count: number;
  /** What replaces them, as read from the text taken in. */
  readonly nodes: readonly Node[];
  /** Where each top-level block of the document then is in that text. */
  readonly spans: readonly (Span | null)[];
};

/** `doc` with no link's `id`, which each reading gives anew: two readings of the same text are then the same. */
export function unnumbered(doc: Node): Node {
  const type = doc.type.schema.marks['link'];
  if (!type) return doc;
  const tr = new Transform(doc);
  doc.descendants((node, pos) => {
    const link = type.isInSet(node.marks);
    if (link && link.attrs['id'] !== null)
      tr.addMark(pos, pos + node.nodeSize, type.create({ ...link.attrs, id: null }));
  });
  return tr.doc;
}

const linkOf = (node: Node | null | undefined) =>
  node?.marks.find((mark) => mark.type.name === 'link');

// `next` from `start` to `b`, to stand for `doc` from `start` to `a`, with
// each link running on past either end given the id it has there in `doc`,
// so text changed inside a link leaves it one.
function inPlace(doc: Node, next: Node, start: number, a: number, b: number): Slice {
  const ids = new Map<unknown, unknown>();
  for (const [kept, read] of [
    [doc.resolve(start).nodeBefore, next.resolve(start).nodeBefore],
    [doc.resolve(a).nodeAfter, next.resolve(b).nodeAfter],
  ]) {
    const [mine, theirs] = [linkOf(kept), linkOf(read)];
    if (mine && theirs) ids.set(theirs.attrs['id'], mine.attrs['id']);
  }
  const tr = new Transform(next);
  next.nodesBetween(start, b, (node, pos) => {
    const link = linkOf(node);
    const id = link && ids.get(link.attrs['id']);
    if (!link || id === undefined) return;
    const [from, to] = [Math.max(pos, start), Math.min(pos + node.nodeSize, b)];
    tr.addMark(from, to, link.type.create({ ...link.attrs, id }));
  });
  return tr.doc.slice(start, b);
}

/**
 * The least change that makes `doc` show as `next`, a reading of other
 * text: from `from` to `to` in `doc`, `slice` in their place, links it
 * changes inside keeping their ids; null if they show the same.
 */
export function replacement(
  doc: Node,
  next: Node,
): { from: number; to: number; slice: Slice } | null {
  const mine = unnumbered(doc);
  const read = unnumbered(next);
  const start = mine.content.findDiffStart(read.content);
  const end = mine.content.findDiffEnd(read.content);
  if (start === null || !end) return null;
  let { a, b } = end;
  const overlap = start - Math.min(a, b);
  if (overlap > 0) [a, b] = [a + overlap, b + overlap];
  return { from: start, to: a, slice: inPlace(doc, next, start, a, b) };
}

/** Whether two blocks show the same, whatever ids their links were given. */
export function same(a: Node, b: Node): boolean {
  if (a === b || a.eq(b)) return true;
  const { schema } = a.type;
  const doc = (node: Node) => unnumbered(schema.topNodeType.create(null, node));
  return doc(a).eq(doc(b));
}

const DEFINITION = 'footnote_definition';

// What's read again, the blocks a change touches and those beside them,
// is at most this long: longer, it's checked off the page's thread, read
// whole, as checking it here would hold up the next key. A list of 1,000
// links beside a change takes about 70 to 100 ms to read again, and a list
// of 3,000 items about half a second to check.
const REGION_MAX = 16_000;

// An empty paragraph, which writes as nothing.
const blank = (node: Node) => node.type.name === 'paragraph' && node.content.size === 0;

// The labels of the footnotes `nodes` define, as written, by label as matched.
function definedIn(nodes: readonly Node[]): Map<string, string> {
  const defined = new Map<string, string>();
  const note = (node: Node) => {
    if (node.type.name === DEFINITION) {
      const label = String(node.attrs['label']);
      defined.set(normalizeIdentifier(label), label);
    }
    // Definitions are blocks: only blocks that hold blocks can hold one.
    return !node.isTextblock && !node.isAtom;
  };
  for (const node of nodes) if (note(node)) node.descendants(note);
  return defined;
}

const sameKeys = (a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>) =>
  a.size === b.size && [...a.keys()].every((key) => b.has(key));

/** What's to be read again, checked as `check`, and then read (`finish`): null if it must be read whole. */
export type Plan = { readonly check: string; finish(): Taken | null };

/**
 * How `doc`, written as `page`, its blocks in `runs` and each one's place
 * there in `spans`, takes in `text` a block at a time: the blocks the
 * characters that differ fall in, read again from `text` with the block
 * beside them each side, by `parse`, which notes where each block came
 * from (`spansOf`). Footnotes the rest of the page defines have stubs, as
 * the writer reads blocks with (`Writer`). What's read again must be one
 * the editor keeps whole (`check`, checked as a paste is); and once read
 * (`finish`), it must end where the page did: the blocks beside the change
 * read as they were, where they were, and the footnotes defined there the
 * same. Null if it must be read whole: as a fence or HTML left open takes
 * in the block after it, a footnote is defined or no longer is, 1 KB or
 * more of text is new (`BLOCK_TIMED`), or the blocks it touches are, with
 * those beside them, 16 KB or more (`REGION_MAX`).
 */
export function planBlocks({
  doc,
  page,
  runs,
  spans,
  text,
  parse,
}: {
  doc: Node;
  page: string;
  runs: readonly Run[];
  spans: readonly (Span | null)[];
  text: string;
  parse: (markdown: string) => Node;
}): Plan | null {
  const last = runs.length - 1;
  if (last < 0) return null;
  // The characters that differ: from `start` to `end` in `page`, and to as
  // far from its end in `text`.
  const shorter = Math.min(page.length, text.length);
  let start = 0;
  while (start < shorter && page.charCodeAt(start) === text.charCodeAt(start)) start++;
  let tail = 0;
  while (
    tail < shorter - start &&
    page.charCodeAt(page.length - 1 - tail) === text.charCodeAt(text.length - 1 - tail)
  )
    tail++;
  const end = page.length - tail;
  if (text.length - tail - start >= BLOCK_TIMED) return null;
  // The runs it touches, and one each side. A change starting in the text
  // between two runs may go on the one before, as a line added to it does,
  // and one ending there may start the one after: each counts as touched.
  const touched = runs.findIndex((run) => run.to >= start);
  const between = (at: number) => !runs.some((run) => run.from <= at && at <= run.to);
  const lo = (touched < 0 ? runs.length : touched) - (between(start) ? 1 : 0);
  const reached = runs.findLastIndex((run) => run.from <= end);
  const hi = reached + (between(end) && reached < last ? 1 : 0);
  const [a, b] = [Math.max(0, lo - 1), Math.min(last, Math.max(hi, lo) + 1)];
  const [before, after] = [runs[a], runs[b]];
  if (!before || !after) return null;
  // From the page's start, or its end, if no run is beside it there.
  const from = a === 0 ? 0 : before.from;
  const to = b === last ? page.length : after.to;
  const first = a === 0 ? 0 : before.first;
  const past = b === last ? doc.childCount : after.first + after.count;
  if (from > start || end > to) return null;
  const shift = text.length - page.length;
  const region = text.slice(from, to + shift);
  if (region.length >= REGION_MAX) return null;
  const replaced = doc.content.content.slice(first, past);
  // Footnotes, if any are in it: the rest of the page's, as stubs, and those
  // it defines must stay the same.
  const notes = page.slice(from, to).includes('[^') || region.includes('[^');
  const outside = notes
    ? definedIn([...doc.content.content.slice(0, first), ...doc.content.content.slice(past)])
    : new Map<string, string>();
  const stubs = [...outside.values()].map((label) => `[^${label}]: x`);
  const lf = [withLf(region), ...stubs].join('\n\n');
  const finish = (): Taken | null => {
    let read: Node;
    try {
      read = parse(lf);
    } catch {
      return null;
    }
    const found = spansOf(read);
    let nodes = [...read.content.content];
    let at: readonly (Span | null)[] = found ?? [];
    // Nothing but space, read as an empty paragraph.
    if (!found) {
      if (withLf(region).trim() !== '' || stubs.length > 0) return null;
      nodes = [];
    }
    // Without the stubs, each where it was put.
    const ends = nodes.slice(nodes.length - stubs.length);
    const stubbed = ends.every(
      (node, i) =>
        node.type.name === DEFINITION &&
        normalizeIdentifier(String(node.attrs['label'])) === [...outside.keys()][i],
    );
    if (!stubbed || ends.length !== stubs.length) return null;
    nodes = nodes.slice(0, nodes.length - stubs.length);
    at = at.slice(0, nodes.length);
    if (notes && !sameKeys(definedIn(nodes), definedIn(replaced))) return null;
    const placed = inText(region, at).map(
      (span) => span && { from: span.from + from, to: span.to + from },
    );
    // The blocks beside it as they were, where they were, each side the
    // page goes on: read from the same place, the same text reads, and
    // ends, the same.
    const shownIn = (run: Run) =>
      doc.content.content.slice(run.first, run.first + run.count).filter((node) => !blank(node));
    if (a < lo) {
      const was = shownIn(before);
      if (!was.every((node, i) => nodes[i] && same(node, nodes[i] as Node))) return null;
      if (placed[was.length - 1]?.to !== before.to) return null;
    }
    if (b > hi) {
      const was = shownIn(after);
      const offset = nodes.length - was.length;
      if (offset < 0 || !was.every((node, i) => same(node, nodes[offset + i] as Node))) return null;
      if (placed[offset]?.from !== after.from + shift) return null;
    }
    if (first === 0 && past === doc.childCount && nodes.length === 0) return null;
    const moved = (span: Span | null) => span && { from: span.from + shift, to: span.to + shift };
    return {
      first,
      count: past - first,
      nodes,
      spans: [...spans.slice(0, first), ...placed, ...spans.slice(past).map(moved)],
    };
  };
  return { check: lf, finish };
}

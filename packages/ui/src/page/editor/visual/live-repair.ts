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

/** The state of `doc`, by Yjs client, as a writing keeps what it was written on. */
export const stateOf = (doc: Y.Doc): ReadonlyMap<number, number> =>
  Y.decodeStateVector(Y.encodeStateVector(doc));

/**
 * The writing to put text in as: `last`, while nobody else changed `body`
 * since, else one anew, written on `seen`, the state of `body` its editor
 * last took in: what `body` had then is what the person had seen.
 */
export function writingOf(
  doc: Y.Doc,
  last: Writing | undefined,
  heard: boolean,
  seen: ReadonlyMap<number, number>,
): Writing {
  if (last && !heard && last.client === doc.clientID) return last;
  return {
    client: doc.clientID,
    // Its own text is all seen, whenever it went in.
    seen: new Map([...seen, [doc.clientID, Y.getState(doc.store, doc.clientID)]]),
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
  // What went in longer ago than a repair looks back is forgotten, oldest first.
  const since = (c: Clocks) => now - c.at <= REPAIR_MS;
  const forget = (clocks: Clocks[]) => {
    let old = 0;
    while (old < clocks.length && !since(clocks[old] as Clocks)) old++;
    if (old > 0) clocks.splice(0, old);
  };
  forget(writing.put);
  if (to > from)
    writing.put.push({ client: writing.client, clock: from, length: to - from, at: now });
  if (!writing.deleted && now - writing.full > REPAIR_MS) writing.deleted = [];
  if (!writing.deleted) return;
  forget(writing.deleted);
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
const CODE_OR_HTML = /^(?: {4}| {0,3}\t| {0,3}<)/;

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

/** Whether `text` at `at` starts `<`, then up to four marks, then a tag's name: a tag split by a merge. */
function splitTagAt(text: string, at: number): boolean {
  if (text.charCodeAt(at) !== 60 || escaped(text, at)) return false;
  let i = at + 1;
  if (text[i] === '/') i++;
  const start = i;
  while (i - start < 4 && (PAIRED.has(text[i] as string) || SINGLE.has(text[i] as string))) i++;
  if (i === start) return false;
  const name = text.slice(i, i + 4).toLowerCase();
  return (name === 'mark' || name === 'span') && !isNameChar(text.charCodeAt(i + 4));
}

/** Whether `text` holds a tag named `span` or `mark` (`tagAt`), which may not read cleanly. */
function suspect(text: string): boolean {
  for (let at = text.indexOf('<'); at >= 0; at = text.indexOf('<', at + 1))
    if (tagAt(text, at)) return true;
  return false;
}

/** Whether text reads cleanly; `unsure` where the scan can't tell and the block is too long to read. */
export type Reading = 'clean' | 'broken' | 'unsure';

/**
 * How `block` reads, by one scan of it, or null where only the reader can
 * tell, as where Markdown marks lie inside a colour's HTML, or code may
 * hold what looks like a tag. It reads cleanly where every tag named
 * `span` or `mark` is a colour's, as the visual editor writes it, opened
 * and closed in turn, none inside one of its own kind.
 */
function scanned(block: string): Reading | null {
  const open: string[] = [];
  let clean = true;
  // Something only the reader can tell: a mark inside a colour, or a tag written otherwise.
  let unsure = false;
  let code = CODE_OR_HTML.test(block.slice(0, 4));
  for (let at = 0; at < block.length; at++) {
    const char = block.charCodeAt(at);
    // A backtick or tilde may start code, and `$` maths, whose text is no HTML.
    if (char === 96 || char === 126 || char === 36) code = true;
    else if (char === 10 && CODE_OR_HTML.test(block.slice(at + 1, at + 5))) code = true;
    const tag = tagAt(block, at);
    if (!tag) {
      if (open.length > 0 && MARKING.has(block[at] as string)) unsure = true;
      continue;
    }
    if (tag.closing) {
      if (block.slice(at, at + 7) !== `</${tag.name}>`) unsure = true;
      else if (open.pop()?.split(':')[0] !== tag.name) clean = false;
      else at += 6;
      continue;
    }
    // Right after `(`, it may be a link's address, as `[a](<Mark Twain.md>)`.
    if (block[at - 1] === '(') code = true;
    const end = block.slice(at, at + LONGEST_TAG).indexOf('>');
    const named = end < 0 ? null : COLOR_TAG.exec(block.slice(at, at + end + 1));
    const key = `${tag.name}:${named?.[2] ?? ''}`;
    // One inside one the same, of the same colour, the editor shows as one.
    if (!named || !isColor(named[2]) || open.includes(key)) {
      clean = false;
      continue;
    }
    open.push(key);
    at += end;
  }
  if (open.length > 0) clean = false;
  // Code may hold any of it; where none can, a tag as written is as read.
  if (code) return null;
  if (!clean) return 'broken';
  return unsure ? null : 'clean';
}

/**
 * How the reader reads `block`: broken where a tag named `span` or `mark`
 * is left as HTML or as text, which the visual editor shows as written, or
 * a highlight is in a highlight or a colour in a colour, which it shows as one.
 */
function read(block: string): Reading {
  let tree: Nodes;
  try {
    tree = parseMarkdown(block);
  } catch {
    return 'broken';
  }
  const stack: { node: Nodes; around: readonly string[] }[] = [{ node: tree, around: [] }];
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
    const kind = kindOf(node);
    if (kind && at.around.includes(kind)) return 'broken';
    if (!('children' in node)) continue;
    const around = kind ? [...at.around, kind] : at.around;
    for (const child of node.children) stack.push({ node: child, around });
  }
  return 'clean';
}

/** A highlight or colour as the editor tells them apart: its kind and colour; else null. */
function kindOf(node: Nodes): string | null {
  if (node.type === 'highlight') return 'mark:';
  if (node.type === 'colorHighlight') return `mark:${node.color}`;
  if (node.type === 'textColor') return `span:${node.color}`;
  return null;
}

/**
 * The tags of `block`, which reads cleanly, that make a colour, as the
 * reader reads them: not text in code or maths that looks like one. None
 * where it's too long to read quickly.
 */
function colourTagsOf(block: string): Span[] {
  if (scanned(block) === 'clean') return tagsIn(block, 0, block.length);
  if (block.length > READ_AT_MOST) return [];
  let tree: Nodes;
  try {
    tree = parseMarkdown(block);
  } catch {
    return [];
  }
  const tags: Span[] = [];
  const stack: Nodes[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      (node.type === 'colorHighlight' || node.type === 'textColor') &&
      start !== undefined &&
      end !== undefined
    ) {
      tags.push({ from: start, to: block.indexOf('>', start) + 1 }, { from: end - 7, to: end });
    }
    if ('children' in node) for (const child of node.children) stack.push(child);
  }
  return tags.sort((a, b) => a.from - b.from);
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
 * Each tag named `span` or `mark` in `text` from `from` to `to`, in order,
 * none overlapping; `loose`, also one with marks put in between its `<`
 * and its name (`<**mark`), as a merge can leave it.
 */
function tagsIn(text: string, from: number, to: number, loose = false): Span[] {
  const spans: Span[] = [];
  for (let at = text.indexOf('<', from); at >= 0 && at < to; at = text.indexOf('<', at + 1)) {
    if (!tagAt(text, at) && !(loose && splitTagAt(text, at))) continue;
    const end = text.slice(at + 1, Math.min(to, at + LONGEST_TAG)).indexOf('>');
    const tagEnd = end < 0 ? Math.min(to, at + 6) : at + end + 2;
    spans.push({ from: at, to: tagEnd });
    at = tagEnd - 1;
  }
  return spans;
}

// Marks a formatting change may put beside a tag: bold, a strike or a
// highlight as two of a kind, a link's brackets, code and maths.
const PAIRED = new Set('*_~=');
const SINGLE = new Set('[]`$');
// How far past a link's text its address is looked for.
const LINK_AT_MOST = 256;

/**
 * How many characters of a mark lie beside `at` in `text`, going `way`
 * (-1 before, 1 after) and not past `limit`: a run of two or more of `*`,
 * `_`, `~` or `=`, or one of `[`, `]`, a backtick or `$`; else 0. A single
 * `*` or `=` may as well be text, as `score=`.
 */
function markRun(text: string, at: number, way: 1 | -1, limit: number): number {
  const first = way === 1 ? at : at - 1;
  const char = text[first];
  if (char === undefined || (way === 1 ? first >= limit : first < limit)) return 0;
  if (SINGLE.has(char)) return 1;
  if (!PAIRED.has(char)) return 0;
  let run = 0;
  for (let i = first; way === 1 ? i < limit : i >= limit; i += way) {
    if (text[i] !== char) break;
    run++;
  }
  return run >= 2 ? run : 0;
}

/**
 * The tags of `line` that pair as a browser pairs them, and those that
 * don't: one not a colour's as the editor writes it, closing nothing,
 * crossed by another, left open, or inside one of its own kind.
 */
function pairsOf(line: string): { pairs: [Span, Span][]; bad: Span[] } {
  const open: { name: string; key: string; tag: Span }[] = [];
  const pairs: [Span, Span][] = [];
  const bad: Span[] = [];
  for (const tag of tagsIn(line, 0, line.length, true)) {
    const named0 = tagAt(line, tag.from);
    if (!named0) {
      bad.push(tag);
      continue;
    }
    const { name, closing } = named0;
    const written = line.slice(tag.from, tag.to);
    if (closing) {
      const at = open.findLastIndex((o) => o.name === name);
      if (written !== `</${name}>` || at < 0) {
        bad.push(tag);
        continue;
      }
      for (const crossed of open.splice(at + 1)) bad.push(crossed.tag);
      pairs.push([(open.pop() as { tag: Span }).tag, tag]);
      continue;
    }
    const named = COLOR_TAG.exec(written);
    const key = `${name}:${named?.[2] ?? ''}`;
    if (!named || !isColor(named[2]) || open.some((o) => o.key === key)) bad.push(tag);
    else open.push({ name, key, tag });
  }
  for (const left of open) bad.push(left.tag);
  return { pairs, bad: bad.sort((a, b) => a.from - b.from) };
}

/**
 * The tags the reader leaves as HTML or text in `line`, or that make a
 * highlight in a highlight or a colour in a colour; null if it fails.
 */
function readerBad(line: string): Span[] | null {
  let tree: Nodes;
  try {
    tree = parseMarkdown(line);
  } catch {
    return null;
  }
  const bad: Span[] = [];
  const stack: { node: Nodes; around: readonly string[] }[] = [{ node: tree, around: [] }];
  for (let at = stack.pop(); at; at = stack.pop()) {
    const { node } = at;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if ((node.type === 'html' || node.type === 'text') && start !== undefined && end !== undefined)
      bad.push(...tagsIn(line, start, end, true));
    const kind = kindOf(node);
    if (kind && at.around.includes(kind) && start !== undefined && end !== undefined)
      bad.push({ from: start, to: line.indexOf('>', start) + 1 }, { from: end - 7, to: end });
    if (!('children' in node)) continue;
    const around = kind ? [...at.around, kind] : at.around;
    for (const child of node.children) stack.push({ node: child, around });
  }
  return bad.sort((a, b) => a.from - b.from);
}

/**
 * What doesn't read cleanly in a block of `text` from `from` to `to`, as
 * the reader would have it: each tag that doesn't pair (`pairsOf`), or
 * that the reader leaves as HTML, and each pair with one of those inside
 * it, each with the marks right beside it (`markRun`), as the `**` of bold
 * put on around a highlight. Other tags on the line, which read as a
 * colour, aren't. In order, none overlapping; null where it can't tell.
 */
function conflictOn(text: string, from: number, to: number): Conflict | null {
  const line = text.slice(from, to);
  if (!suspect(line)) return { tags: [], spans: [] };
  const { pairs, bad: unpaired } = pairsOf(line);
  let bad = unpaired;
  if (scanned(line) === null) {
    if (line.length > READ_AT_MOST) return null;
    const read = readerBad(line);
    if (!read) return null;
    bad = read;
  }
  if (bad.length === 0) return { tags: [], spans: [] };
  const tags = [...bad];
  for (const [open, close] of pairs)
    if (overlapsAny(bad, open.from, close.to)) tags.push(open, close);
  const shift = (span: Span) => ({ from: span.from + from, to: span.to + from });
  const all = merged(tags, []);
  return { tags: all.map(shift), spans: besideOf(line, all, 0, line.length).map(shift) };
}

/** What doesn't read cleanly: its tags, and those with the marks beside them. */
type Conflict = { tags: Span[]; spans: Span[] };

/** `tags`, tags of `text` from `from` to `to`, each with the marks right beside it, those that meet made one. */
function besideOf(text: string, tags: readonly Span[], from: number, to: number): Span[] {
  const spans: Span[] = [];
  for (const tag of tags) {
    let start = tag.from;
    for (let run = markRun(text, start, -1, from); run > 0; run = markRun(text, start, -1, from))
      start -= run;
    let end = tag.to;
    for (let run = markRun(text, end, 1, to); run > 0; run = markRun(text, end, 1, to)) end += run;
    // A link's address after its text: `](x.md)`.
    if (text[end - 1] === ']' && text[end] === '(') {
      const close = text.slice(end, Math.min(to, end + LINK_AT_MOST)).indexOf(')');
      if (close >= 0) end += close + 1;
    }
    const last = spans.at(-1);
    if (last && last.to >= start) last.to = Math.max(last.to, end);
    else spans.push({ from: Math.max(start, last?.to ?? start), to: end });
  }
  return spans;
}

/** `a` and `b`, spans each in order, as one list in order, those that overlap or meet made one. */
function merged(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const span of [...a, ...b].sort((x, y) => x.from - y.from)) {
    const last = out.at(-1);
    if (last && last.to >= span.from) last.to = Math.max(last.to, span.to);
    else out.push({ ...span });
  }
  return out;
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

/** What a fence's line stands in: the page itself, a quote, or a list item (or code indented). */
type Container = 'page' | 'quote' | 'list';

/**
 * A fence's or a math block's line, `text` from `at` to `end`: its run of
 * backticks or tildes, or `$$`, after spaces, quote markers and list
 * markers; what it stands in; and whether nothing follows the run; or
 * null. One look at each character.
 */
function fenceOn(
  text: string,
  at: number,
  end: number,
): { run: string; container: Container; bare: boolean } | null {
  let i = at;
  let container: Container = 'page';
  const spaces = () => {
    const start = i;
    while (i < end && (text[i] === ' ' || text[i] === '\t')) i++;
    return i - start;
  };
  for (;;) {
    if (spaces() > 3 && container === 'page') container = 'list';
    const char = text[i];
    if (char === '>') {
      i++;
      if (container === 'page') container = 'quote';
      continue;
    }
    if ((char === '-' || char === '*' || char === '+') && /[ \t]/.test(text[i + 1] ?? '')) {
      i++;
      if (container === 'page') container = 'list';
      continue;
    }
    let digits = i;
    while (digits < end && digits - i < 9 && /[0-9]/.test(text[digits] as string)) digits++;
    if (digits > i && /[.)]/.test(text[digits] ?? '') && /[ \t]/.test(text[digits + 1] ?? '')) {
      i = digits + 1;
      if (container === 'page') container = 'list';
      continue;
    }
    break;
  }
  const char = text[i];
  if (char !== '`' && char !== '~' && char !== '$') return null;
  let runEnd = i;
  while (runEnd < end && text[runEnd] === char) runEnd++;
  const length = runEnd - i;
  if (length < (char === '$' ? 2 : 3)) return null;
  let rest = runEnd;
  while (rest < end && (text[rest] === ' ' || text[rest] === '\t' || text[rest] === '\r')) rest++;
  return { run: text.slice(i, runEnd), container, bare: rest === end };
}

/** Whether the line of `text` from `at` goes on in `container`: quoted, or indented. */
function goesOn(text: string, at: number, end: number, container: Container): boolean {
  let i = at;
  while (i < end && i - at < 4 && text[i] === ' ') i++;
  if (container === 'quote') return text[i] === '>';
  if (container === 'list') return isBlank(text, at, end) || text[at] === ' ' || text[at] === '\t';
  return true;
}

/**
 * Whether places of `text`, asked in order, lie in a code fence or a math
 * block left open above them, read once from the top: a block between
 * blank lines may be part of one, whose text is no Markdown. A fence in a
 * quote ends at the first line that isn't quoted, and one in a list item
 * at the first, not blank, that isn't indented; one on the page closes
 * only on a run of its own with nothing after it, on the page.
 */
class Fences {
  readonly #text: string;
  #at = 0;
  #open: { run: string; container: Container } | null = null;
  constructor(text: string) {
    this.#text = text;
  }
  inside(place: number): boolean {
    const text = this.#text;
    while (this.#at < place) {
      const end = lineEnd(text, this.#at);
      let open = this.#open;
      if (open && !goesOn(text, this.#at, end, open.container)) open = null;
      const fence = fenceOn(text, this.#at, end);
      if (fence && !open) {
        // `$$` with more on its line is math within the line.
        if (fence.run[0] !== '$' || fence.bare) open = fence;
      } else if (fence?.bare && open && open.container === 'page' && fence.container === 'page') {
        // One in a quote or a list item ends with it: what looks like its end may be its text.
        if (fence.run[0] === open.run[0] && fence.run.length >= open.run.length) open = null;
      }
      this.#open = open;
      this.#at = end + 1;
    }
    const open = this.#open;
    return open !== null && goesOn(text, place, lineEnd(text, place), open.container);
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

/** The first of `clocks`, in order of clock, that ends after `clock`. */
function firstAfter(clocks: readonly Clocks[], clock: number): number {
  let low = 0;
  let high = clocks.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const c = clocks[mid] as Clocks;
    if (c.clock + c.length <= clock) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Whether `clocks`, in order of clock, hold some of `client`'s from `clock` to `end`. */
function holds(clocks: readonly Clocks[], client: number, clock: number, end: number): boolean {
  for (let i = firstAfter(clocks, clock); i < clocks.length; i++) {
    const c = clocks[i] as Clocks;
    if (c.clock >= end) break;
    if (c.client === client) return true;
  }
  return false;
}

/** Whether `clocks`, in any order, hold some of `client`'s from `clock` to `end`. */
const holdsAny = (clocks: readonly Clocks[], client: number, clock: number, end: number) =>
  clocks.some((c) => c.client === client && c.clock < end && c.clock + c.length > clock);

/** The last of `writings` whose text put in holds some of `item`, or -1. */
function putBy(writings: readonly Writing[], item: Found): number {
  for (let i = writings.length - 1; i >= 0; i--) {
    const w = writings[i] as Writing;
    if (w.client === item.client && holds(w.put, item.client, item.clock, item.clock + item.length))
      return i;
  }
  return -1;
}

/** The last of `writings` that deleted some of `item`, or -1. */
function deletedBy(writings: readonly Writing[], item: Found): number {
  for (let i = writings.length - 1; i >= 0; i--)
    if (
      holdsAny(
        (writings[i] as Writing).deleted ?? [],
        item.client,
        item.clock,
        item.clock + item.length,
      )
    )
      return i;
  return -1;
}

/**
 * Whether this app is the one to repair a block whose `items` these are,
 * where `suspects` are what doesn't read cleanly. Its writing there is the
 * latest of its `recent` ones that put text in one of them or deleted
 * beside one; it is the one if that put text in one, and every other app
 * with text in one, which it hadn't then, has a lower Yjs client. Not if
 * someone changed the block knowing what it wrote: putting text in beside
 * its recent text, or deleting some, which a repair would undo; nor if the
 * person changed it from elsewhere in this app. If it is, the others'
 * text it hadn't, and where of that lies in none of them, which the repair
 * keeps; else null.
 */
function repairs1(
  text: (from: number, to: number) => string,
  items: readonly Found[],
  conflict: Conflict,
  recent: readonly Writing[],
  clients: ReadonlySet<number>,
): { kept: Span[]; own: Span[]; formatters: number } | null {
  if (recent.some((w) => w.deleted === null)) return null;
  const { tags, spans } = conflict;
  // In a tag, or all of it in a tag and the marks beside it: not text that only meets one.
  const inOne = (item: Found) => {
    if (item.deleted) return touchesAny(spans, item.at, item.at);
    const end = item.at + item.length;
    if (overlapsAny(tags, item.at, end)) return true;
    const span = spans[firstEnding(spans, item.at)];
    return span !== undefined && span.from <= item.at && span.to >= end;
  };
  let latest = -1;
  for (const item of items)
    if (inOne(item))
      latest = Math.max(latest, item.deleted ? deletedBy(recent, item) : putBy(recent, item));
  const writing = recent[latest];
  if (!writing) return null;
  // Only deletions of its own there: Yjs doesn't say whose those are, so the others can't tell.
  const putThere = items.some(
    (item) =>
      !item.deleted &&
      item.client === writing.client &&
      holds(writing.put, item.client, item.clock, item.clock + item.length) &&
      inOne(item),
  );
  if (!putThere) return null;
  const fresh = (id: Y.ID | null) =>
    id !== null &&
    recent.some((w) => w.client === id.client && holds(w.put, id.client, id.clock, id.clock + 1));
  const formatters = new Set<number>();
  const unseen: Found[] = [];
  for (const item of items) {
    if (putBy(recent, item) >= 0) {
      // Its own recent text, deleted by someone who had it.
      if (item.deleted && deletedBy(recent, item) < 0) return null;
      continue;
    }
    if (item.clock + item.length <= (writing.seen.get(item.client) ?? 0)) continue;
    // The person's own, from elsewhere in this app.
    if (clients.has(item.client)) return null;
    if (item.beside.some(fresh)) return null;
    if (item.deleted) continue;
    unseen.push(item);
    if (!inOne(item)) continue;
    if (item.client > writing.client) return null;
    formatters.add(item.client);
  }
  // Theirs not in the conflict stays: all of a bystander's, and the other
  // formatter's plain text, as a sentence it typed on the line offline;
  // not its pieces of tags or marks the merge left apart.
  const kept = unseen
    .filter(
      (item) =>
        !inOne(item) &&
        (!formatters.has(item.client) || plain(text(item.at, item.at + item.length))),
    )
    .map((item) => ({ from: item.at, to: item.at + item.length }));
  // Where it put text in, in that writing.
  const own = items
    .filter(
      (item) =>
        !item.deleted && holds(writing.put, item.client, item.clock, item.clock + item.length),
    )
    .map((item) => ({ from: item.at, to: item.at + item.length }));
  return { kept, own, formatters: formatters.size };
}

// Characters that make HTML or Markdown marks, as pieces of a tag or a mark have.
const MARKUP = /[<>="*_~[\]()`$\\/]/;

/** Whether `text` is plain: none of the characters of tags or marks in it. */
const plain = (text: string) => !MARKUP.test(text);

/** The first of `spans`, in order and none overlapping, that ends after `from`. */
function firstEnding(spans: readonly Span[], from: number): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((spans[mid] as Span).to <= from) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Whether a stretch `from` to `to` overlaps any of `spans`, in order and none overlapping. */
function overlapsAny(spans: readonly Span[], from: number, to: number): boolean {
  const span = spans[firstEnding(spans, from)];
  return span !== undefined && span.from < to;
}

/**
 * `theirs`, others' changes in a block of `body` from `at`, undone within
 * `lines`, in order and none overlapping: what they put in there out, but
 * for what lies in `kept`, and what they took out of a tag in `mine`, the
 * block as this app wrote it, or of the marks beside one, beside one of
 * `conflicts`, back in. What
 * they put in or took out across a line break stays, and so does other
 * text they took out, as a word deleted elsewhere on the line.
 */
function undoneOn(
  bodyText: string,
  theirs: readonly Theirs[],
  at: number,
  lines: readonly Span[],
  conflicts: readonly Span[],
  mine: string,
  kept: readonly Span[],
  held: string,
): TextChange[] {
  const tags = besideOf(mine, colourTagsOf(mine), 0, mine.length);
  // How far `mine` is behind `body`, before the change in turn.
  let shift = 0;
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
    const inMine = change.body - at - shift;
    shift += change.bodyEnd - change.body - (change.heldEnd - change.held);
    while (first < lines.length && (lines[first] as Span).to < change.body) first++;
    for (let i = first; i < lines.length; i++) {
      const line = lines[i] as Span;
      if (line.from > change.bodyEnd) break;
      if (change.bodyEnd > change.body) {
        // What went in across a line break, as a new line, stays whole.
        if (bodyText.slice(change.body, change.bodyEnd).includes('\n')) break;
        const from = Math.max(change.body, line.from);
        const to = Math.min(change.bodyEnd, line.to);
        if (to > from) takeOut(from, to);
        continue;
      }
      const was = held.slice(change.held, change.heldEnd);
      if (was.includes('\n') || !touchesAny(conflicts, change.body, change.body)) break;
      // Only what was in a tag: what else was taken out with it may be someone else's.
      let back = '';
      for (let t = firstEnding(tags, inMine); t < tags.length; t++) {
        const tag = tags[t] as Span;
        if (tag.from >= inMine + was.length) break;
        const from = Math.max(tag.from, inMine);
        const to = Math.min(tag.to, inMine + was.length);
        if (to > from) back += was.slice(from - inMine, to - inMine);
      }
      if (back) out.push({ from: change.body, remove: 0, insert: back });
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
type Candidate = { block: Span; shown: string; mine: string; theirs: Theirs[] };

/**
 * The changes to `body` that put back what others' changes, merged with
 * this app's, left not reading cleanly, as this app wrote it (`held`):
 * each block someone else's change touched since this app took one in,
 * which reads cleanly as it wrote it within the last `REPAIR_MS`, but no
 * longer does, if it is the one to repair it (`repairs1`). On each line
 * that doesn't read cleanly, what the others with text in its conflict
 * (`conflictOn`) put in is taken out, and what anyone took out of a
 * colour's tag there is put back, so it reads as this app wrote it; what
 * anyone else put in or took out stays, and so does what went in or out
 * across a line break. If the block then still doesn't read cleanly, it
 * is left.
 */
export function repairs(
  text: Y.Text,
  body: string,
  held: string,
  map: () => Mapping,
  writings: readonly Writing[],
  now: number,
): TextChange[] {
  const recent = recentOf(writings, now);
  if (recent.length === 0) return [];
  const theirs = map().theirs();
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
    const mine = applied(shown, block.from, undone(inside, held));
    if (readingOf(mine) !== 'clean') continue;
    const reading = readingOf(shown);
    if (reading !== 'broken') continue;
    if (fences.inside(block.from)) continue;
    candidates.push({ block, shown, mine, theirs: inside });
  }
  if (candidates.length === 0) return [];
  const clients = new Set(writings.map((w) => w.client));
  const items = itemsIn(
    text,
    candidates.map((c) => c.block),
  );
  const out: TextChange[] = [];
  for (const [i, { block, shown, mine, theirs: inside }] of candidates.entries()) {
    const found = items[i] ?? [];
    // What doesn't read cleanly, over the block, as a highlight may go on past a line.
    const conflict = conflictOn(body, block.from, block.to);
    if (!conflict || conflict.tags.length === 0) continue;
    const failing = linesOf(body, block.from, block.to).filter((line) =>
      overlapsAny(conflict.spans, line.from, line.to + 1),
    );
    const repairer = repairs1((a, b) => body.slice(a, b), found, conflict, recent, clients);
    if (!repairer) continue;
    // Others only took text out: only if beside what it put in, made at once, not knowing it.
    const own = merged(repairer.own, []);
    if (
      repairer.formatters === 0 &&
      !inside.some((c) => c.bodyEnd === c.body && touchesAny(own, c.body, c.body))
    )
      continue;
    // Its own text in the conflict, as its letters of a tag the other took out, for what to put back.
    const conflicts = merged(conflict.spans, own);
    const changes = undoneOn(
      body,
      inside,
      block.from,
      failing,
      conflicts,
      mine,
      repairer.kept,
      held,
    );
    const result = applied(shown, block.from, changes);
    // No pieces of the other's tags left as text: no more colours named than it wrote.
    const named = (text: string) => text.split('data-color').length;
    if (changes.length > 0 && readingOf(result) === 'clean' && named(result) <= named(mine))
      out.push(...changes);
  }
  return out;
}

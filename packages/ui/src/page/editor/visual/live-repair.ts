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
// How much the reader reads, in all and how many times, for one take-in's repairs.
const REPAIR_READS = 64;
const REPAIR_READ_AT_MOST = 32 * READ_AT_MOST;
// What's left of that while `repairs` runs; elsewhere, null, as there's no bound.
let budget: { reads: number; chars: number } | null = null;

/** `text` read, or null if the reader fails or has read all it may for this take-in. */
function readerOf(text: string): Nodes | null {
  if (budget) {
    if (budget.reads === 0 || budget.chars < text.length) return null;
    budget.reads--;
    budget.chars -= text.length;
  }
  try {
    return parseMarkdown(text);
  } catch {
    return null;
  }
}

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
  // In order of time: the old ones found by halving, and taken off once
  // they're half of them, so a long burst of typing costs no more per key.
  const forget = (clocks: Clocks[]) => {
    let low = 0;
    let high = clocks.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (since(clocks[mid] as Clocks)) high = mid;
      else low = mid + 1;
    }
    if (low * 2 > clocks.length) clocks.splice(0, low);
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
/**
 * Whether the line of `text` at `at` may start code or HTML of its own:
 * past its quote and list markers, four columns of space or a tab, as
 * `>     code`, or `<`.
 */
function codeOrHtmlAt(text: string, at: number): boolean {
  const { rest } = lineStartOf(text, at, lineEnd(text, at));
  let columns = 0;
  for (let i = rest - 1; i >= at && (text[i] === ' ' || text[i] === '\t'); i--) {
    if (text[i] === '\t') return true;
    columns++;
  }
  return columns >= 4 || text[rest] === '<';
}

/** Whether the character at `at` is escaped, by an odd number of backslashes before it. */
function escaped(text: string, at: number): boolean {
  let slashes = 0;
  // Each run of backslashes is counted once, by the `<` right after it.
  for (let i = at - 1; i >= 0 && text.charCodeAt(i) === 92; i--) slashes++;
  return slashes % 2 === 1;
}

/** The tag named `span` or `mark`, any case, that `text` starts at `at`, not escaped; else null. */
function tagAt(text: string, at: number): { name: 'span' | 'mark'; closing: boolean } | null {
  if (text.charCodeAt(at) !== 60 || escaped(text, at)) return null;
  const closing = text.charCodeAt(at + 1) === 47;
  const start = at + (closing ? 2 : 1);
  for (const name of NAMES) {
    if (text.slice(start, start + 4).toLowerCase() !== name) continue;
    return endsName(text, start + 4) ? { name, closing } : null;
  }
  return null;
}

/** Whether a tag's name ends at `at` in `text`: at a space, `>` or `/`, as HTML's do, not as `<span@x.com>`. */
function endsName(text: string, at: number): boolean {
  const char = text[at];
  return char === undefined || char === '>' || char === '/' || /\s/.test(char);
}

/** Whether `text` at `at` starts `<`, then up to four marks, then a tag's name: a tag split by a merge. */
function splitTagAt(text: string, at: number): boolean {
  if (text.charCodeAt(at) !== 60 || escaped(text, at)) return false;
  let i = at + 1;
  if (text[i] === '/') i++;
  // The name's four letters, with up to six marks among them and after
  // them, as `<m**ark`, and a link's address, as `<m[ark](x.md)`.
  let name = '';
  let marks = 0;
  for (;;) {
    const char = text[i];
    if (char === undefined || marks > 6) return false;
    if (PAIRED.has(char) || SINGLE.has(char)) {
      marks++;
      i++;
      if (char === ']' && text[i] === '(') {
        const close = addressAfter(text, i, text.length);
        if (close < 0) return false;
        i = close;
      }
      continue;
    }
    if (name.length === 4) break;
    name += char.toLowerCase();
    i++;
  }
  return marks > 0 && marks <= 6 && (name === 'mark' || name === 'span') && endsName(text, i);
}

/**
 * The tags of `pairs`, pairs of tags of `text`, that put a colour on
 * twice: a pair right inside one the same, its ends against the other's,
 * as `<mark data-color="red"><mark data-color="red">world</mark></mark>`,
 * which the editor shows as one. A colour inside a longer one of its own
 * reads as the longer one, and isn't.
 */
function doubled(text: string, pairs: readonly [Span, Span][]): Span[] {
  const byEnd = new Map(pairs.map((pair) => [pair[0].to, pair]));
  const out: Span[] = [];
  for (const [open, close] of pairs) {
    const outer = byEnd.get(open.from);
    if (!outer || outer[1].from !== close.to) continue;
    if (text.slice(outer[0].from, outer[0].to) !== text.slice(open.from, open.to)) continue;
    out.push(outer[0], open, close, outer[1]);
  }
  return out.sort((x, y) => x.from - y.from);
}

/** The colour nodes of `tree` that are all of another the same, as the reader reads a colour put on twice. */
function doubledNodes(tree: Nodes): Nodes[] {
  const out: Nodes[] = [];
  const stack: Nodes[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!('children' in node)) continue;
    const [only] = node.children;
    if (
      node.children.length === 1 &&
      only &&
      (node.type === 'colorHighlight' || node.type === 'textColor') &&
      only.type === node.type &&
      only.color === node.color
    )
      out.push(node, only);
    for (const child of node.children) stack.push(child);
  }
  return out;
}

/** A colour node's opening and closing tags, as `block` has them. */
function tagsOfNode(block: string, node: Nodes): Span[] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return [];
  return [
    { from: start, to: block.indexOf('>', start) + 1 },
    { from: end - 7, to: end },
  ];
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
  let code = codeOrHtmlAt(block, 0);
  for (let at = 0; at < block.length; at++) {
    const char = block.charCodeAt(at);
    // A backtick or tilde may start code, and `$` maths, whose text is no HTML.
    if (char === 96 || char === 126 || char === 36) code = true;
    else if (char === 10 && codeOrHtmlAt(block, at + 1)) code = true;
    // After a link's `](`, a reference's `][`, a definition's `]:` or a
    // wikilink's `[[`, a tag may be in its address, title or label, as
    // `[a](x "title <mark>")`, which the reader keeps whole.
    else if (char === 93 && /[(:[]/.test(block[at + 1] ?? '')) code = true;
    else if (char === 91 && block[at + 1] === '[') code = true;
    const tag = tagAt(block, at);
    if (!tag) {
      // Other HTML, whose attributes may hold what looks like a tag.
      if (char === 60 && /[A-Za-z/!?]/.test(block[at + 1] ?? '')) code = true;
      if (open.length > 0 && MARKING.has(block[at] as string)) unsure = true;
      continue;
    }
    if (tag.closing) {
      if (block.slice(at, at + 7) !== `</${tag.name}>`) unsure = true;
      else if (open.pop()?.split(':')[0] !== tag.name) clean = false;
      else at += 6;
      continue;
    }
    const end = block.slice(at, at + LONGEST_TAG).indexOf('>');
    const named = end < 0 ? null : COLOR_TAG.exec(block.slice(at, at + end + 1));
    const key = `${tag.name}:${named?.[2] ?? ''}`;
    if (!named || !isColor(named[2])) {
      clean = false;
      continue;
    }
    open.push(key);
    at += end;
  }
  // A colour put on twice the editor shows as one.
  if (open.length > 0) clean = false;
  else if (clean && !code) {
    const { pairs } = pairsOf(block);
    if (doubled(block, pairs).length > 0) clean = false;
  }
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
  const tree = readerOf(block);
  if (!tree) return 'unsure';
  if (rawTags(block, tree, false).length > 0) return 'broken';
  return doubledNodes(tree).length > 0 ? 'broken' : 'clean';
}

/**
 * The tags of `text` (`tagsIn`, split ones too where `loose`) that the
 * reader, which read it as `tree`, leaves as HTML or text: some of it in
 * text, or an HTML node of its own. Not text held in another tag's
 * attribute, a link's address or title, an image's alt text or a
 * wikilink, which the reader keeps whole, as the person wrote it.
 */
function rawTags(text: string, tree: Nodes, loose: boolean): Span[] {
  const texts: Span[] = [];
  const html = new Set<number>();
  const stack: Nodes[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === 'text') texts.push({ from: start, to: end });
      else if (node.type === 'html') html.add(start);
    }
    if ('children' in node) for (const child of node.children) stack.push(child);
  }
  const inText = merged(texts, []);
  // As written, so an escaped `\<span` is text as it means to be.
  return tagsIn(text, 0, text.length, loose).filter(
    (tag) => html.has(tag.from) || overlapsAny(inText, tag.from, tag.to),
  );
}

/**
 * The tags of `block`, which reads cleanly, that make a colour, as the
 * reader reads them: not text in code or maths that looks like one. Null
 * where it's too long to read quickly, or the reader can't.
 */
function colourTagsOf(block: string): Span[] | null {
  if (scanned(block) === 'clean') return tagsIn(block, 0, block.length);
  if (block.length > READ_AT_MOST) return null;
  const tree = readerOf(block);
  if (!tree) return null;
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

/** Whether `char` may be in a link's address as written bare: not a space or a bracket. */
const inAddress = (char: string | undefined) => char !== undefined && !/[\s()[\]<>]/.test(char);

/** Where the link's address `(…)` that starts at `at` in `text` ends, past its `)`, not past `to`; or -1. */
function addressAfter(text: string, at: number, to: number): number {
  for (let i = at + 1; i < Math.min(to, at + LINK_AT_MOST); i++) {
    if (text[i] === ')') return i + 1;
    if (!inAddress(text[i])) return -1;
  }
  return -1;
}

/**
 * Whether the link whose text ends with the `]` at `close` in `text`
 * crosses `tags`: an odd number of them start in its text, so one of them
 * lies across its `[` or its `]`, as `<mark>[world</mark>](x.md)`. Not one
 * whose tags all lie in its text, as `[<mark><span>world</mark></span>](x)`,
 * nor a link of its own beside them, as `[score](old)<mark>`: its address
 * is the link's, and someone's change to it stays.
 */
function crossesLink(text: string, close: number, from: number, tags: readonly Span[]): boolean {
  let starts = 0;
  for (let i = close - 1; i >= Math.max(from, close - LINK_AT_MOST); i--) {
    if (text[i] === ']') return false;
    if (text[i] === '[') return starts % 2 === 1;
    if (text[i] === '<' && overlapsAny(tags, i, i + 1) && (tagAt(text, i) || splitTagAt(text, i)))
      starts++;
  }
  return false;
}

/** Where the `](` of a link's address that ends with the `)` at `close` in `text` starts, not before `from`; or -1. */
function addressBefore(text: string, close: number, from: number): number {
  for (let i = close - 1; i > Math.max(from, close - LINK_AT_MOST); i--) {
    if (text[i] === '(' && text[i - 1] === ']') return i - 1;
    if (!inAddress(text[i])) return -1;
  }
  return -1;
}

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
  // How many of each name are open, so one that closes nothing is told at once.
  const opened = new Map<string, number>();
  for (const tag of tagsIn(line, 0, line.length, true)) {
    const named0 = tagAt(line, tag.from);
    if (!named0) {
      bad.push(tag);
      continue;
    }
    const { name, closing } = named0;
    const written = line.slice(tag.from, tag.to);
    if (closing) {
      // Only one written as the editor writes it looks for what it closes,
      // and those it crosses are taken off as it's found, so each is looked at once.
      const at =
        written === `</${name}>` && (opened.get(name) ?? 0) > 0
          ? open.findLastIndex((o) => o.name === name)
          : -1;
      if (at < 0) {
        bad.push(tag);
        continue;
      }
      for (const crossed of open.splice(at + 1)) {
        bad.push(crossed.tag);
        opened.set(crossed.name, (opened.get(crossed.name) ?? 1) - 1);
      }
      pairs.push([(open.pop() as { tag: Span }).tag, tag]);
      opened.set(name, (opened.get(name) ?? 1) - 1);
      continue;
    }
    const named = COLOR_TAG.exec(written);
    const key = `${name}:${named?.[2] ?? ''}`;
    if (!named || !isColor(named[2])) bad.push(tag);
    else {
      open.push({ name, key, tag });
      opened.set(name, (opened.get(name) ?? 0) + 1);
    }
  }
  for (const left of open) bad.push(left.tag);
  bad.push(...doubled(line, pairs));
  return { pairs, bad: merged(bad, []) };
}

/**
 * The tags the reader leaves as HTML or text in `line`, or that make a
 * highlight in a highlight or a colour in a colour; null if it fails.
 */
function readerBad(line: string): Span[] | null {
  const tree = readerOf(line);
  if (!tree) return null;
  // The tags the reader read as a colour, and what it read as code or maths.
  const good = new Set<number>();
  const code: Span[] = [];
  const stack: Nodes[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === 'colorHighlight' || node.type === 'textColor')
      for (const tag of tagsOfNode(line, node)) good.add(tag.from);
    else if (
      (node.type === 'inlineCode' ||
        node.type === 'code' ||
        node.type === 'inlineMath' ||
        node.type === 'math') &&
      start !== undefined &&
      end !== undefined
    )
      code.push({ from: start, to: end });
    if ('children' in node) for (const child of node.children) stack.push(child);
  }
  code.sort((a, b) => a.from - b.from);
  // Every other tag, split ones too, not wholly in code: as one a mark of code split, `<mark\``.
  const inCode = (tag: Span) => {
    const span = code[firstEnding(code, tag.from)];
    return span !== undefined && span.from <= tag.from && span.to >= tag.to;
  };
  const bad = rawTags(line, tree, true).filter((tag) => !good.has(tag.from) && !inCode(tag));
  for (const node of doubledNodes(tree)) bad.push(...tagsOfNode(line, node));
  return merged(bad, []);
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

/**
 * `tags`, tags of `text` from `from` to `to`, each with the marks right
 * beside it, those that meet made one; and a link's address before or
 * after one, where the link crosses `linked` (`crossesLink`).
 */
function besideOf(
  text: string,
  tags: readonly Span[],
  from: number,
  to: number,
  linked: readonly Span[] = tags,
): Span[] {
  const spans: Span[] = [];
  for (const tag of tags) {
    let start = tag.from;
    // A link's address before a tag, as `[<mark>world](x.md)</mark>`.
    if (text[start - 1] === ')') {
      const address = addressBefore(text, start - 1, from);
      if (address >= 0 && crossesLink(text, address, from, linked)) start = address;
    }
    for (let run = markRun(text, start, -1, from); run > 0; run = markRun(text, start, -1, from))
      start -= run;
    let end = tag.to;
    for (let run = markRun(text, end, 1, to); run > 0; run = markRun(text, end, 1, to)) end += run;
    // A link's address after its text: `](x.md)`.
    if (text[end - 1] === ']' && text[end] === '(' && crossesLink(text, end - 1, from, linked)) {
      const close = addressAfter(text, end, to);
      if (close >= 0) end = close;
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

/** What a line of `text` from `at` to `end` starts with, past spaces, tabs and quote and list markers. */
function lineStartOf(
  text: string,
  at: number,
  end: number,
): { indent: number; marked: boolean; rest: number } {
  let i = at;
  let marked = false;
  for (;;) {
    while (i < end && (text[i] === ' ' || text[i] === '\t')) i++;
    const char = text[i];
    if (char === '>') {
      i++;
      marked = true;
      continue;
    }
    const after = i + 1 >= end ? '' : (text[i + 1] as string);
    if ((char === '-' || char === '*' || char === '+') && (after === '' || /[ \t]/.test(after))) {
      i++;
      marked = true;
      continue;
    }
    let digits = i;
    while (digits < end && digits - i < 9 && /[0-9]/.test(text[digits] as string)) digits++;
    const next = digits + 1 >= end ? '' : (text[digits + 1] as string);
    if (digits > i && /[.)]/.test(text[digits] ?? '') && (next === '' || /[ \t]/.test(next))) {
      i = digits + 1;
      marked = true;
      continue;
    }
    break;
  }
  let indent = at;
  while (indent < end && (text[indent] === ' ' || text[indent] === '\t')) indent++;
  return { indent: indent - at, marked, rest: i };
}

/** The run of backticks, tildes or `$` at `at` in `text`, before `end`: its length, if a fence's or maths' could be. */
function runAt(text: string, at: number, end: number): number {
  const char = text[at];
  if (char !== '`' && char !== '~' && char !== '$') return 0;
  let run = at;
  while (run < end && text[run] === char) run++;
  return run - at >= (char === '$' ? 2 : 3) ? run - at : 0;
}

// A line starting with a colour's tag, or one closing, and more after it: a
// paragraph's, as no HTML block starts with that.
const TAG_THEN_TEXT = /^(?:<(?:span|mark) data-color="[a-z]+">|<\/(?:span|mark)>)\S/;
// The start of an HTML block that may go on past a blank line, as `<pre>`
// or a comment; any other ends at one.
const LONG_HTML = /^<(?:(?:pre|script|style|textarea)(?:[\s>]|$)|[!?])/i;
// How much of the page the reader reads, in all and how many times, to tell what's open above blocks.
const CONTEXT_AT_MOST = 16 * READ_AT_MOST;
const CONTEXT_READS = 32;

/**
 * Where in `tree`, read from `text`, code, maths or HTML lies, from `from`
 * on: each node's type and its place from `from`, as one string; or null
 * where one starts before `from` and goes on past it.
 */
function codeFrom(tree: Nodes, from: number): string[] | null {
  const out: string[] = [];
  const stack: Nodes[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      (node.type === 'code' ||
        node.type === 'inlineCode' ||
        node.type === 'math' ||
        node.type === 'inlineMath' ||
        node.type === 'html') &&
      start !== undefined &&
      end !== undefined &&
      end > from
    ) {
      if (start < from) return null;
      out.push(`${node.type}:${start - from}:${end - from}`);
    }
    if ('children' in node) for (const child of node.children) stack.push(child);
  }
  return out.sort();
}

/**
 * Whether blocks of `text`, asked in order, read in their place on the
 * page as they read alone: not in a code fence, maths or HTML left open
 * above them, with the code, maths and HTML in them the same. Read once
 * from the top, by line. The scan is sure only of a fence that starts at a
 * line's very start, on the page, of backticks or tildes, and of its
 * closing line. Any other line that may start a fence, maths or an HTML
 * block that may go on past a blank line, as one in a list item or a
 * quote, or indented, or a fence's line in HTML, leaves it unsure until
 * the reader reads the page from where it was last sure, at most 1 KB of
 * it, and finds nothing open; where that's too long, or the reader has
 * read 16 KB of the page in all or 32 times, the blocks are taken as not
 * reading alone.
 */
class Context {
  readonly #text: string;
  #at = 0;
  // A fence the scan is sure of, left open: its character and length.
  #fence: { char: string; length: number } | null = null;
  // The start of the last line the scan was sure of, with nothing open
  // above it, and whether it has been unsure since.
  #sure = 0;
  #unsure = false;
  // How much the reader last read to find it sure again, to read twice as much the next time.
  #tried = 0;
  // How much more of the page the reader may read, and how many more times.
  #left = CONTEXT_AT_MOST;
  #reads = CONTEXT_READS;
  #blank = true;
  // In an HTML block that ends at a blank line, where a fence's line is its text.
  #html = false;

  constructor(text: string) {
    this.#text = text;
  }

  /** Whether the line at `at`, ending at `end`, starts the page's own text after a blank line: no list item or quote goes on past it. */
  #plain(at: number, end: number): boolean {
    if (!this.#blank || at >= end) return false;
    const { indent, marked, rest } = lineStartOf(this.#text, at, end);
    const char = this.#text[at] as string;
    return indent === 0 && !marked && runAt(this.#text, rest, end) === 0 && char !== '<';
  }

  /** `text` from `from` to `to` read, if the reader may read that much more. */
  #read(from: number, to: number): Nodes | null {
    if (to - from > this.#left || this.#reads === 0) return null;
    this.#left -= to - from;
    this.#reads--;
    return readerOf(this.#text.slice(from, to));
  }

  /** Whether nothing the reader reads from the line the scan was sure of is open at `at`. */
  #nothingOpen(at: number): boolean {
    const tree = this.#read(this.#sure, lineEnd(this.#text, at));
    return tree !== null && codeFrom(tree, at - this.#sure) !== null;
  }

  #scan(place: number): void {
    const text = this.#text;
    while (this.#at < place) {
      const at = this.#at;
      const end = lineEnd(text, at);
      this.#at = end + 1;
      const blank = isBlank(text, at, end);
      if (!blank && this.#plain(at, end)) {
        if (!this.#unsure && !this.#fence) this.#sure = at;
        else if (
          this.#unsure &&
          end - this.#sure <= READ_AT_MOST &&
          at - this.#sure >= this.#tried * 2
        ) {
          this.#tried = at - this.#sure;
          if (this.#nothingOpen(at)) {
            this.#unsure = false;
            this.#sure = at;
            this.#tried = 0;
          }
        }
      }
      this.#blank = blank;
      if (blank) this.#html = false;
      if (this.#unsure || blank) continue;
      const fence = this.#fence;
      if (fence) {
        // Its closing line: up to three spaces, then a run as long, alone.
        let i = at;
        while (i < end && i - at < 3 && text[i] === ' ') i++;
        let run = i;
        while (run < end && text[run] === fence.char) run++;
        if (run - i >= fence.length && isBlank(text, run, end)) this.#fence = null;
        continue;
      }
      const { indent, marked, rest } = lineStartOf(text, at, end);
      const run = runAt(text, rest, end);
      const char = text[rest];
      if (run > 0) {
        const info = text.slice(rest + run, end);
        const own =
          indent === 0 && !marked && char !== '$' && !(char === '`' && info.includes('`'));
        if (own && !this.#html) this.#fence = { char: char as string, length: run };
        else this.#unsure = true;
      } else if (char === '<') {
        const start = text.slice(rest, rest + LONGEST_TAG + 1);
        if (LONG_HTML.test(start)) this.#unsure = true;
        else if (!TAG_THEN_TEXT.test(start)) this.#html = true;
      }
    }
  }

  /** Whether `block`, the next asked, reads in its place as it reads alone. */
  alone(block: Span): boolean {
    this.#scan(block.from);
    if (!this.#unsure) return this.#fence === null;
    if (block.to - this.#sure > READ_AT_MOST) return false;
    const context = this.#read(this.#sure, block.to);
    const alone = context && readerOf(this.#text.slice(block.from, block.to));
    if (!context || !alone) return false;
    const there = codeFrom(context, block.from - this.#sure);
    return there !== null && there.join() === codeFrom(alone, 0)?.join();
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
  const near = (item: Found) => {
    if (item.deleted) return touchesAny(spans, item.at, item.at);
    const end = item.at + item.length;
    if (overlapsAny(tags, item.at, end)) return true;
    const span = spans[firstEnding(spans, item.at)];
    return span !== undefined && span.from <= item.at && span.to >= end;
  };
  // A single `$`, backtick or bracket beside a tag may be a third person's,
  // as `$` typed before `50`: it counts only where its writer has text in
  // a tag there, or put its other half in the block in the same unseen
  // change, as code's closing backtick or a link's `](x.md)`.
  const lone = (item: Found) =>
    !item.deleted &&
    item.length === 1 &&
    !overlapsAny(tags, item.at, item.at + 1) &&
    SINGLE.has(text(item.at, item.at + 1));
  // New: this app's recent text, or text one of its recent writings hadn't.
  const isNew = (item: Found) =>
    putBy(recent, item) >= 0 ||
    recent.some((w) => item.clock + item.length > (w.seen.get(item.client) ?? 0));
  const written = new Map<number, string>();
  const more = new Set<number>();
  for (const item of items) {
    if (item.deleted || !isNew(item)) continue;
    const put = text(item.at, item.at + item.length);
    written.set(item.client, (written.get(item.client) ?? '') + put);
    if (near(item) && !lone(item)) more.add(item.client);
  }
  const halfOf: Record<string, string> = { '[': ']', ']': '[', '`': '`', $: '$' };
  const paired = (item: Found) => {
    const char = text(item.at, item.at + 1);
    const half = halfOf[char] as string;
    const all = written.get(item.client) ?? '';
    return half === char ? all.split(char).length > 2 : all.includes(half);
  };
  const inOne = (item: Found) =>
    near(item) && (!lone(item) || more.has(item.client) || paired(item));
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
  // Theirs not in the conflict stays: all of a bystander's, and what the
  // other formatter put in before its text there, by Yjs's clock, away
  // from it, that reads as words, as a sentence it typed on the line
  // offline. What it put in with or after that, as pieces of its tags the
  // merge left apart, goes. (Yjs puts a change's last piece in first, so a
  // write's own pieces can come before by clock: hence the words.)
  const first = new Map<number, number>();
  for (const item of unseen)
    if (formatters.has(item.client) && inOne(item))
      first.set(item.client, Math.min(first.get(item.client) ?? Infinity, item.clock));
  const kept = unseen
    .filter(
      (item) =>
        !inOne(item) &&
        (!formatters.has(item.client) ||
          (item.clock + item.length <= (first.get(item.client) ?? -Infinity) &&
            !touchesAny(spans, item.at, item.at + item.length) &&
            prose(text(item.at, item.at + item.length)))),
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

// What pieces of a tag or a mark have, and words don't.
const PIECE = /[<>"`$]|data-|\]\(|\*\*|==|~~|__/;

/**
 * Whether `text` reads as words: some, a letter or digit and a space
 * between, and nothing of a tag's or a mark's pieces. A piece of a change
 * the merge split, as `md)` of a link's `](x.md)`, is no words.
 */
const prose = (text: string) =>
  /[\p{L}\p{N}]/u.test(text) && /\S\s|\s\S/.test(text) && !PIECE.test(text);

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
 * block as this app wrote it, whose colour tags are `mineTags`, or of the
 * marks beside one, beside one of
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
  mineTags: readonly Span[],
  kept: readonly Span[],
  held: string,
): TextChange[] {
  // A link beside a tag in it is its own, as all its tags pair.
  const tags = besideOf(mine, mineTags, 0, mine.length, []);
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

/**
 * The words of `text`, runs of letters and digits, outside its tags,
 * counted; with `loose`, also those in a tag not written as the editor
 * writes a colour's, as letters of a word a merge took into one.
 */
function wordsOf(text: string, loose = false): Map<string, number> {
  const words = new Map<string, number>();
  let from = 0;
  const count = (part: string) => {
    for (const word of part.match(/[\p{L}\p{N}]+/gu) ?? [])
      words.set(word, (words.get(word) ?? 0) + 1);
  };
  for (const tag of tagsIn(text, 0, text.length, true)) {
    count(text.slice(from, tag.from));
    const written = text.slice(tag.from, tag.to);
    if (loose && !COLOR_TAG.test(written) && !/^<\/(?:span|mark)>$/.test(written)) count(written);
    from = tag.to;
  }
  count(text.slice(from));
  return words;
}

/**
 * Whether `result` has each word of `mine` as often as both it and
 * `merged` have it, in `merged` counting what's in its tags not written as
 * a colour's too, as a word a merge took for letters of one.
 */
function keepsWords(mine: string, merged: string, result: string): boolean {
  const there = wordsOf(merged, true);
  const after = wordsOf(result);
  for (const [word, times] of wordsOf(mine))
    if ((after.get(word) ?? 0) < Math.min(times, there.get(word) ?? 0)) return false;
  return true;
}

/**
 * Whether each mark `changes` put back, as a `**` someone took out beside
 * a tag, is in `result` as often as in `mine`, and a link's brackets with
 * its parentheses: so a repair never leaves half of a pair someone else
 * took out whole, as `big**` from `**big**`, or `[world]` from a link.
 */
function marksAsMine(changes: readonly TextChange[], mine: string, result: string): boolean {
  const count = (text: string, char: string) => text.split(char).length;
  const back = new Set<string>();
  for (const change of changes)
    for (const char of change.insert) if (PAIRED.has(char) || SINGLE.has(char)) back.add(char);
  // A link's brackets come back only with its address, as `[world](x.md)`.
  if (back.has('[') || back.has(']')) for (const char of '()') back.add(char);
  for (const char of back) if (count(result, char) !== count(mine, char)) return false;
  return true;
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
  // The reader reads only so much for one take-in; past it, blocks are left.
  budget = { reads: REPAIR_READS, chars: REPAIR_READ_AT_MOST };
  try {
    return repairsIn(text, body, held, map, writings, now);
  } finally {
    budget = null;
  }
}

function repairsIn(
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
  const context = new Context(body);
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
    if (!context.alone(block)) continue;
    candidates.push({ block, shown, mine, theirs: inside });
  }
  if (candidates.length === 0) return [];
  // A byte order mark or a lone carriage return, which the reader reads as
  // a line's end, puts lines where the scan doesn't look; a definition
  // anywhere may make a bracket in a block a link: left as main merges them.
  if (body.includes('\uFEFF') || /\r(?!\n)/.test(body)) return [];
  const defined = body.includes(']:');
  const clients = new Set(writings.map((w) => w.client));
  const items = itemsIn(
    text,
    candidates.map((c) => c.block),
  );
  const out: TextChange[] = [];
  for (const [i, { block, shown, mine, theirs: inside }] of candidates.entries()) {
    const found = items[i] ?? [];
    // What doesn't read cleanly, over the block, as a highlight may go on past a line.
    if (defined && shown.includes('[')) continue;
    const conflict = conflictOn(body, block.from, block.to);
    if (!conflict || conflict.tags.length === 0) continue;
    const failing = linesOf(body, block.from, block.to).filter((line) =>
      overlapsAny(conflict.spans, line.from, line.to + 1),
    );
    // Only colour formatting, which the visual editor writes with
    // `data-color`, in its own writing or what doesn't read cleanly (where
    // someone's typing may have split it, as `dabig ta-color`): not
    // other HTML a merge of letters made one named so, as `<mrk value>`
    // and `<mak value>` merged to `<mark value>`.
    if (
      !mine.includes('data-color') &&
      !failing.some((line) => /data|color/.test(body.slice(line.from, line.to)))
    )
      continue;
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
    const mineTags = colourTagsOf(mine);
    if (!mineTags) continue;
    const changes = undoneOn(
      body,
      inside,
      block.from,
      failing,
      conflicts,
      mine,
      mineTags,
      repairer.kept,
      held,
    );
    const result = applied(shown, block.from, changes);
    // No pieces of the other's tags left as text: no more colours named than
    // it wrote; and no word it wrote that's still there lost, as a merge that
    // took a word for letters of a tag can leave a repair rebuilding the tag
    // around nothing.
    const named = (text: string) => text.split('data-color').length;
    if (
      changes.length > 0 &&
      readingOf(result) === 'clean' &&
      named(result) <= named(mine) &&
      keepsWords(mine, shown, result) &&
      marksAsMine(changes, mine, result)
    )
      out.push(...changes);
  }
  return out;
}

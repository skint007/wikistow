import type { Mark, Node } from '@milkdown/kit/prose/model';
import type { Root, RootContent } from 'mdast';
import { MarkdownTimeout, READ_BUDGET_MS } from '../../markdown-worker';
import { checkReader } from '../../page-reader';
import { lineBreakFor, type LineBreak } from '../surface';
import { holds, transformer, type Transformer } from './config';
import {
  meaningOf,
  readerFidelity,
  stays,
  TOO_DEEP,
  withLf,
  type Fidelity,
} from './reader-fidelity';

export { withLf, type Fidelity } from './reader-fidelity';

/** Whether `page` ends in a line break, as one written anew does: one empty does too. */
export const endsInLine = (page: string) => page === '' || /\n$/.test(page);

/** `markdown`, in LF, with a final line break if `final`, else with none. */
export function ending(markdown: string, final: boolean): string {
  if (!final) return markdown.replace(/\n$/, '');
  return markdown && !/\n$/.test(markdown) ? `${markdown}\n` : markdown;
}

/** `written`, in LF, in `page`'s line break (`lineBreak` if it has none yet). */
export const inLineBreaks = (written: string, page: string, lineBreak?: LineBreak) =>
  lineBreakFor(page, lineBreak) === '\r\n' ? written.replace(/\n/g, '\r\n') : written;

/**
 * `written`, the document as Markdown, in the ways `page` writes its own:
 * its line break, and no final one if it has none.
 */
export const asPage = (written: string, page: string) =>
  inLineBreaks(ending(written, endsInLine(page)), page);

// `body` as the visual editor reads and writes it back, as the visual
// surface does, in the page's ways; null if Milkdown fails on it, which is
// a change too.
function rewritten(body: string, { parse, serialize }: Transformer): string | null {
  try {
    return asPage(serialize(parse(withLf(body))), body);
  } catch {
    return null;
  }
}

/**
 * Whether the visual editor keeps everything `body` (frontmatter split off)
 * says: it holds only syntax the editor has nodes for, and the editor's
 * reading and writing it back, as the visual surface does, reads the same,
 * by the reader's own syntax (`readerFidelity`). Anything else stays in
 * source mode, with the reason.
 */
export function fidelityOf(body: string, milkdown: Transformer): Fidelity {
  const read = readerFidelity(body);
  if ('visual' in read) return read;
  const written = rewritten(body, milkdown);
  try {
    if (written !== null && meaningOf(written) === read.meaning) return { visual: true };
  } catch {
    // Written past the parser's stack.
  }
  return stays('formatting');
}

// What the editor shows of a mark or node, without how Markdown writes it
// (`*` or `_`, a link bare), list looseness and labels it doesn't show, ids
// it works out, whether it made a link of an autolink literal, or the text
// a link was read with. A link shows which of its block's links it is.
const UNSHOWN = new Set(['marker', 'spread', 'label', 'listType', 'id', 'auto', 'bare', 'read']);
const attrsOf = (attrs: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(attrs).filter(([name]) => !UNSHOWN.has(name)));

type Shown = { text: string; marks: string } | { type: string; attrs: object; marks: string } | ' ';

const marksOf = (marks: readonly Mark[], link: number) =>
  JSON.stringify(
    marks.map((mark) => [
      mark.type.name,
      { ...attrsOf(mark.attrs), ...(mark.type.name === 'link' ? { link } : {}) },
    ]),
  );

const isBreak = (item: Shown | undefined) =>
  typeof item === 'object' && 'type' in item && item.type === 'hardbreak';

/**
 * A text block's content as shown: words with their marks, and whitespace
 * as one space between them, none at a line's ends, which Markdown doesn't
 * keep. A soft line break shows as a space; a hard one ends a line, and at
 * the block's end, nothing. A hard break shows no marks, and one at a
 * mark's end is written without it. Other atoms show the marks Markdown
 * can hold on them (`holds`). Links are numbered in turn, so one written
 * as two, or two as one, doesn't show the same.
 */
function inline(block: Node): Shown[] {
  const shown: Shown[] = [];
  let space = false;
  let links = 0;
  let previous: Mark | undefined;
  const add = (item: Shown) => {
    if (space && shown.length > 0 && !isBreak(item) && !isBreak(shown.at(-1))) shown.push(' ');
    space = false;
    const last = shown.at(-1);
    const joins = typeof last === 'object' && 'text' in last && typeof item === 'object';
    if (joins && 'text' in item && last.marks === item.marks) last.text += item.text;
    else shown.push(item);
  };
  block.forEach((child) => {
    const held = child.marks.filter((mark) => child.isText || holds(child, mark));
    const link = held.find((mark) => mark.type.name === 'link');
    const going = !!link && !!previous && link.eq(previous);
    // Spaces and line breaks start no link, as none is written on them at
    // its ends (`writable`), but they part one from another.
    const blank = child.type.name === 'hardbreak' || (child.isText && !child.text?.trim());
    if (link && !blank && !going) links++;
    previous = blank && !going ? undefined : link;
    if (child.isText) {
      const marks = marksOf(child.marks, links);
      for (const part of (child.text ?? '').split(/([ \t\r\n]+)/))
        if (/^[ \t\r\n]+$/.test(part)) space = true;
        else if (part) add({ text: part, marks });
    } else if (child.type.name === 'hardbreak' && child.attrs['isInline']) {
      space = true;
    } else {
      const hard = child.type.name === 'hardbreak';
      const marks = marksOf(hard ? [] : held, links);
      add({ type: child.type.name, attrs: attrsOf(child.attrs), marks });
    }
  });
  while (isBreak(shown.at(-1))) shown.pop();
  return shown;
}

/**
 * What `node` shows, as Markdown can hold it. An empty paragraph shows
 * nothing, save as a list item's first, its empty text; an empty task
 * item, no box.
 */
export function shownOf(node: Node, parent?: Node): object | null {
  const attrs = attrsOf(node.attrs);
  if (node.type.spec.code || node.isLeaf)
    return { type: node.type.name, attrs, text: node.textContent };
  if (node.isTextblock) {
    const content = inline(node);
    const kept = parent?.type.name === 'list_item' && parent.firstChild === node;
    if (content.length === 0 && node.type.name === 'paragraph' && !kept) return null;
    return { type: node.type.name, attrs, content };
  }
  const content: object[] = [];
  node.forEach((child) => {
    const shown = shownOf(child, node);
    if (shown) content.push(shown);
  });
  const [first] = content;
  const blank = first && 'content' in first && Array.isArray(first.content) && !first.content[0];
  if (node.type.name === 'list_item' && content.length === 1 && blank) attrs['checked'] = null;
  return { type: node.type.name, attrs, content };
}

/**
 * Whether `markdown`, the visual editor's writing of `doc`, reads back as
 * the document it shows: the guard on each edit it writes. Its own reading
 * is the reader's syntax; what differs only as Markdown can't hold it
 * (whitespace at a line's ends, an empty paragraph) is the same.
 */
export function writesAsShown(doc: Node, markdown: string, parse: Transformer['parse']): boolean {
  try {
    return JSON.stringify(shownOf(parse(markdown))) === JSON.stringify(shownOf(doc));
  } catch {
    return false;
  }
}

/**
 * How long the reader may take over a body, in its worker once loaded, for
 * the visual editor to open on it. The check's Milkdown reading and writing
 * and the editor's own reading then take about as long each, or longer, on
 * the page's thread; some text takes the parser far longer than its size
 * suggests (#87), and would hold up the page that long each time. A long,
 * ordinary page takes about a second on a laptop.
 */
const VISUAL_READ_MS = 2_000;

/**
 * How long the reader may take over a top-level block of a body with those
 * beside it, in its worker, for the visual editor to open on it. Each edit
 * reads its block back with those on the page's thread (`Writer`), in 1 to
 * 2 times this, so a key typed there waits about as long. A list of 1,000
 * links takes about 75 ms on a laptop; 24 KB of `*a` in one paragraph, over
 * a second (#134).
 */
export const BLOCK_READ_MS = 250;

/**
 * Text shorter than this reads quickly even as the parser is slowest: 4 KB
 * of `*a` takes about 50 ms. A shorter block isn't timed, and a shorter
 * paste is read on the page's thread at once (`pasting`).
 */
export const BLOCK_TIMED = 1_024;

/**
 * Whether each top-level block of `body`, read by the reader as `blocks`,
 * reads within `BLOCK_READ_MS` with those beside it, as an edit to it is
 * read back: each block of `BLOCK_TIMED` or more read alone, by `time`,
 * which rejects past that too. A block with no position, should a plugin
 * of the reader's make one anew, is what lies between those beside it.
 */
async function editsInTime(
  body: string,
  blocks: readonly RootContent[],
  time: (text: string) => Promise<number>,
): Promise<boolean> {
  const took: number[] = [];
  let from = 0;
  for (const [i, block] of blocks.entries()) {
    const start = block.position?.start.offset ?? from;
    const end =
      block.position?.end.offset ??
      blocks.slice(i + 1).find((next) => next.position)?.position?.start.offset ??
      body.length;
    from = end;
    const text = body.slice(start, end);
    took.push(text.length < BLOCK_TIMED ? 0 : await time(text));
  }
  return took.every((ms, i) => (took[i - 1] ?? 0) + ms + (took[i + 1] ?? 0) <= BLOCK_READ_MS);
}

const SLOW_PAGE: Fidelity = {
  visual: false,
  reason: 'This page stays in source mode, because it takes too long to read to show formatted.',
};

const SLOW_BLOCK: Fidelity = {
  visual: false,
  reason:
    'This page stays in source mode, because part of it takes too long to read to edit formatted.',
};

// The check under way, which the next waits for: a read timing out ends
// the worker, which the next check's loading then counts.
let checking: Promise<unknown> = Promise.resolve();

/**
 * `fidelityOf` with the visual editor's own reading and writing, for a body
 * the reader reads within `VISUAL_READ_MS` in `checkReader`, each block
 * within `BLOCK_READ_MS`. One it takes longer over stays in source mode.
 * The reader's reads run in `checkReader` too, so only Milkdown's run on
 * the page's thread (#184). One check at a time.
 */
export function checkFidelity(body: string): Promise<Fidelity> {
  const checked = checking.then(() => check(body));
  checking = checked.catch(() => {});
  return checked;
}

async function check(body: string): Promise<Fidelity> {
  const slow = await readsInTime(body);
  if (slow) return slow;
  const loaded = { budgetMs: READ_BUDGET_MS };
  const read = await checkReader
    .run('fidelity', body, loaded)
    .catch((error: unknown) => unread(error, SLOW_PAGE));
  if ('visual' in read) return read;
  const written = rewritten(body, await transformer());
  try {
    if (written !== null && (await checkReader.run('meaning', written, loaded)) === read.meaning)
      return { visual: true };
  } catch (error) {
    // Written past the parser's stack is a change too.
    if (error instanceof MarkdownTimeout) return SLOW_PAGE;
  }
  return stays('formatting');
}

/** Why `body` stays in source mode, if the reader can't read it in time; else null. */
async function readsInTime(body: string): Promise<Fidelity | null> {
  // Loaded first, given as long as the reader, so loading isn't counted.
  // Without it, or once the vault locks, nothing is read here either.
  try {
    await checkReader.run('body', '', { budgetMs: READ_BUDGET_MS });
  } catch {
    return { visual: false, reason: 'The visual editor could not be loaded. Try again.' };
  }
  let tree: Root;
  const started = performance.now();
  try {
    tree = await checkReader.run('body', body, { budgetMs: VISUAL_READ_MS });
  } catch (error) {
    return unread(error, SLOW_PAGE);
  }
  // No blocks of a page read this soon take longer apart.
  if (performance.now() - started <= BLOCK_READ_MS) return null;
  const time = async (text: string) => {
    const begun = performance.now();
    await checkReader.run('body', text, { budgetMs: BLOCK_READ_MS });
    return performance.now() - begun;
  };
  try {
    return (await editsInTime(body, tree.children, time)) ? null : SLOW_BLOCK;
  } catch (error) {
    return unread(error, SLOW_BLOCK);
  }
}

// Not read in time, or not at all: as nested past the parser's stack, or
// the vault locked. Read on the page's thread, it would hold up the page
// as long.
const unread = (error: unknown, slow: Fidelity) =>
  error instanceof MarkdownTimeout ? slow : TOO_DEEP;

// A page body cut into blocks (ADR 0013, decision 3): each block is its
// exact source text, so joining them gives the body back byte for byte,
// and has a key that says what it reads as, so two blocks written in
// different styles (an aligned table row, a renumbered item, `*` for `-`)
// compare as the same.
import type { Blockquote, Nodes, Parents, Root } from 'mdast';
import { markdownText, parseMarkdown } from '../markdown/index.ts';
import { alertOf } from '../reader/alerts.ts';

/** What kind of block it is, as joining and writing blocks need to know. */
export type BlockKind = 'blank' | 'item' | 'row' | 'table' | 'heading' | 'other';

/** A container a block sits in, outermost first. */
export type Container =
  | { kind: 'list'; ordered: boolean }
  | { kind: 'quote'; alert: string | null }
  | { kind: 'footnote'; label: string };

export type Block = {
  /** Its exact source, markers, indentation and line ending included. */
  readonly text: string;
  /** What it reads as, with its place: blocks with the same key read the same. */
  readonly key: string;
  readonly kind: BlockKind;
  /** The containers it sits in, outermost first. */
  readonly place: readonly Container[];
  /** A heading's text as the reader shows it, else null. */
  readonly heading: string | null;
  /**
   * A list item's list, as an ID that only blocks from the same parse
   * compare by; null for any other block.
   */
  readonly list: number | null;
};

/**
 * `body` (front matter already split off) as blocks: one per leaf block
 * (paragraph, heading, code, math, HTML, thematic break), list item at any
 * depth (its own lines only, not its nested list's), and table row, with
 * a table's header and delimiter rows as one block, and every block inside
 * a block quote or an alert. Each blank line between them is a block of
 * its own. Joined, the blocks' texts are `body`.
 */
export function blocksOf(body: string): Block[] {
  const tree = parseMarkdown(body);
  const starts = startsOf(tree, body);
  const cuts = [...new Set([0, ...starts.keys()])].sort((a, b) => a - b);
  cuts.push(body.length);
  const blocks: Block[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const from = cuts[i] ?? 0;
    const slice = body.slice(from, cuts[i + 1]);
    if (slice === '') continue;
    // The block's own lines, then each blank line after it as a block.
    const own = ownLines(slice);
    if (own !== '') blocks.push(blockAt(own, starts.get(from)));
    for (const line of linesOf(slice.slice(own.length))) blocks.push(blankBlock(line));
  }
  return blocks;
}

/**
 * A blank line's block. Blank lines read the same as each other, but a
 * line of only `>` is one inside that many block quotes.
 */
export const blankBlock = (text: string): Block => ({
  text,
  key: `blank:${text.split('>').length - 1}`,
  kind: 'blank',
  place: [],
  heading: null,
  list: null,
});

// A blank line, or one with only block quote markers, which separates
// blocks inside a quote as a blank line does outside one.
const isBlank = (text: string) => /^[ \t>]*\r?\n?$/.test(text);

// `slice` up to its trailing blank lines, keeping its last line ending.
function ownLines(slice: string): string {
  const lines = linesOf(slice);
  let end = lines.length;
  while (end > 0 && isBlank(lines[end - 1] ?? '')) end--;
  return lines.slice(0, end).join('');
}

/** `text`'s lines, each with its line ending. */
export function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// What starts at a line: the content read there and the place it sits in.
type Start = {
  content: unknown[];
  place: Container[];
  kind: BlockKind;
  heading: string | null;
  list: number | null;
};

function blockAt(text: string, start: Start | undefined): Block {
  // Text no node starts on, such as a blank-looking line of spaces in a
  // code block's indentation, is compared by its characters.
  if (!start) {
    return {
      text,
      key: `text:${withLf(text)}`,
      kind: 'other',
      place: [],
      heading: null,
      list: null,
    };
  }
  const key = JSON.stringify({ place: start.place, content: start.content }, (name, value) =>
    name === 'position' ? undefined : typeof value === 'string' ? withLf(value) : value,
  );
  const { kind, place, heading, list } = start;
  return { text, key, kind, place, heading, list };
}

const withLf = (text: string) => text.replace(/\r\n?/g, '\n');

const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1;

// For each line a block starts on, what it reads as: the nodes that start
// there, outermost first, each without its children that are blocks of
// their own, and the containers around them.
function startsOf(tree: Root, body: string): Map<number, Start> {
  const starts = new Map<number, Start>();
  const add = (
    offset: number | undefined,
    place: Container[],
    node: unknown,
    kind: BlockKind,
    heading: string | null = null,
    list: number | null = null,
  ) => {
    if (offset === undefined) return;
    const at = lineStart(body, offset);
    const start = starts.get(at);
    if (start) start.content.push(node);
    else starts.set(at, { content: [node], place, kind, heading, list });
  };
  const visit = (parent: Parents, place: Container[]) => {
    for (const child of parent.children as Nodes[]) {
      const offset = child.position?.start.offset;
      switch (child.type) {
        case 'list':
          visit(child, [...place, { kind: 'list', ordered: child.ordered ?? false }]);
          break;
        case 'listItem':
          // An item is its own lines: a task or not, ticked or not, and its first block.
          add(
            offset,
            place,
            { type: 'listItem', checked: child.checked ?? null },
            'item',
            null,
            parent.position?.start.offset ?? -1,
          );
          visit(child, place);
          break;
        case 'blockquote':
          visit(child, [
            ...place,
            { kind: 'quote', alert: alertOf(child as Blockquote)?.type ?? null },
          ]);
          break;
        case 'footnoteDefinition':
          add(
            offset,
            place,
            { type: 'footnoteDefinition', label: child.label ?? child.identifier },
            'other',
          );
          visit(child, [...place, { kind: 'footnote', label: child.label ?? child.identifier }]);
          break;
        case 'table': {
          // The header and delimiter rows, with the columns' alignment, then each row.
          const [header, ...rows] = child.children;
          add(offset, place, { type: 'table', align: child.align ?? null, header }, 'table');
          for (const row of rows) add(row.position?.start.offset, place, row, 'row');
          break;
        }
        case 'heading':
          add(offset, place, child, 'heading', markdownText(child));
          break;
        default:
          add(offset, place, child, 'other');
      }
    }
  };
  visit(tree, []);
  return starts;
}

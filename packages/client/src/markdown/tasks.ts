import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { splitFrontmatter } from './frontmatter.ts';
import { mathFromMarkdownExtension, mathSyntax } from './math.ts';
import { wikilinkFromMarkdown, wikilinkSyntax } from './wikilink.ts';

// Task-list items (`- [ ] milk`) ticked in a page's Markdown, as the reader
// ticks them (#212). A task is named by where its list item starts in the
// whole Markdown, frontmatter included, and by its line's text: the offset
// finds it quickly in the text it was ticked on, and the text finds it again
// in a newer one, where lines above it came or went. Only the character
// between its brackets changes; every other one stays as it was.
//
// Offsets are UTF-16, into the whole Markdown.

/** A task item as ticked: where its list item starts, its line's text after the box, and whether it's done. */
export type TaskChange = { offset: number; line: string; checked: boolean };

/** A task item found in a page's Markdown. */
export type TaskItem = TaskChange & {
  /** Where the character between its brackets is: a space, `x` or `X`. */
  mark: number;
};

/** A task ticked in a page's Markdown, or why it couldn't be. */
export type TaskEdit = { ok: true; markdown: string } | { ok: false; reason: string };

// From a list item's start: any indentation, its marker (`-`, `*`, `+`, or a
// number and `.` or `)`), the blanks after it, then the box and a blank or
// the line's end after it, as GitHub reads a task.
const TASK = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|\r?\n|$)([^\r\n]*)/;

/**
 * The task item whose list item starts at `offset` in `markdown`, or null
 * when no task starts there. Its line is the text after the box, trimmed.
 */
export function taskAt(markdown: string, offset: number): TaskItem | null {
  if (!Number.isInteger(offset) || offset < 0 || offset >= markdown.length) return null;
  const found = TASK.exec(markdown.slice(offset, markdown.indexOf('\n', offset) + 1 || undefined));
  if (!found) return null;
  const [whole, box = ' ', rest = ''] = found;
  // The box's mark, counted back from the end of what matched.
  const mark = offset + whole.length - rest.length - 2;
  return { offset, line: rest.trim(), checked: box !== ' ', mark };
}

/**
 * Where a page's body starts, as the offsets the body's tree has count:
 * after its frontmatter, and after a byte order mark (U+FEFF) the body
 * starts with, which the parser skips without counting.
 */
export function bodyStart(markdown: string): number {
  const { frontmatter, body } = splitFrontmatter(markdown);
  return (frontmatter?.length ?? 0) + (body.startsWith('\uFEFF') ? 1 : 0);
}

/**
 * Every task item in `markdown`, in order, as the reader reads them:
 * GitHub-flavoured Markdown, wikilinks and math, the frontmatter split off first.
 * Read without recursion, as a page may nest deep.
 */
export function taskItems(markdown: string): TaskItem[] {
  const { body } = splitFrontmatter(markdown);
  const start = bodyStart(markdown);
  const tree = fromMarkdown(body, {
    extensions: [gfm(), wikilinkSyntax, mathSyntax],
    mdastExtensions: [gfmFromMarkdown(), wikilinkFromMarkdown, mathFromMarkdownExtension],
  });
  const found: TaskItem[] = [];
  const stack: Nodes[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      const at = node.position?.start.offset;
      const item = at === undefined ? null : taskAt(markdown, start + at);
      if (item) found.push(item);
    }
    if ('children' in node)
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child) stack.push(child);
      }
  }
  return found;
}

// The task items of the last few texts asked for, by where each starts, as
// a page read asks again for the same text with each tick it shows. Only
// while the vault is open: `forgetTaskItems` lets them go as it locks.
const itemsOf = new Map<string, ReadonlyMap<number, TaskItem>>();
// Enough for a batch with a few properties set among its ticks, each a text of its own.
const ITEMS_KEPT = 8;

/** Every task item in `markdown` by where it starts, as `taskItems` finds them, the last few texts' kept. */
export function taskIndex(markdown: string): ReadonlyMap<number, TaskItem> {
  let items = itemsOf.get(markdown);
  if (!items) {
    items = new Map(taskItems(markdown).map((item) => [item.offset, item]));
    itemsOf.set(markdown, items);
    for (const old of itemsOf.keys()) {
      if (itemsOf.size <= ITEMS_KEPT) break;
      itemsOf.delete(old);
    }
  }
  return items;
}

/** Let go of the texts `taskIndex` keeps, as the vault locks. */
export function forgetTaskItems() {
  itemsOf.clear();
}

/**
 * `markdown` with the task `change` names ticked (`checked`) or not. It is
 * the task item at `change.offset` if its line is still `change.line`,
 * never a box in code that now starts where a task did (#700); otherwise
 * the only task item with that line. A task already as asked is left as
 * it is, `[X]` included, so a change made twice changes nothing more. A
 * task that is gone, or whose line more than one task has, is refused
 * with why. `items` gives the task items, by default `taskIndex(markdown)`:
 * those of a text this one differs from only in what is ticked hold for
 * it too, their boxes as this text has them, as ticking moves no block,
 * so changes made one after another parse the page once.
 */
export function setTask(
  markdown: string,
  change: TaskChange,
  items: () => ReadonlyMap<number, TaskItem> = () => taskIndex(markdown),
): TaskEdit {
  // Whether its box is ticked in this text, which may have ticked it since the items were found.
  const now = (item: TaskItem): TaskItem => ({ ...item, checked: markdown[item.mark] !== ' ' });
  const there = items().get(change.offset);
  let task = there?.line === change.line ? now(there) : null;
  if (!task) {
    const same = [...items().values()].filter((item) => item.line === change.line);
    if (same.length !== 1) {
      const named = change.line === '' ? 'That task' : `The task “${change.line}”`;
      return {
        ok: false,
        reason:
          same.length === 0
            ? `${named} isn’t on the page any more.`
            : `${named} is on the page more than once now.`,
      };
    }
    task = same[0] ? now(same[0]) : null;
  }
  if (!task || task.checked === change.checked) return { ok: true, markdown };
  const mark = change.checked ? 'x' : ' ';
  return {
    ok: true,
    markdown: markdown.slice(0, task.mark) + mark + markdown.slice(task.mark + 1),
  };
}

/**
 * `markdown` with every task's box emptied, nested ones too: two texts the
 * same this way differ only in what is ticked (#695).
 */
export function marksIgnored(markdown: string): string {
  let plain = markdown;
  for (const { mark } of taskItems(markdown))
    plain = plain.slice(0, mark) + ' ' + plain.slice(mark + 1);
  return plain;
}

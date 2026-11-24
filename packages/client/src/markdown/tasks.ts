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

/** A task item: where its list item starts, its line's text after the box, and whether it's done. */
type Task = { offset: number; line: string; checked: boolean };

/**
 * A task item as ticked, and where that's known, what it was ticked in
 * (`madeIn`): the whole Markdown, and whether more than one task had its
 * line there. In other text, its offset may be another task with the same
 * line (#703).
 */
export type TaskChange = Task & { madeIn?: { markdown: string; repeated: boolean } };

/** A task item found in a page's Markdown. */
export type TaskItem = Task & {
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
 * the only task item with that line. Where `markdown` isn't the text it
 * was ticked in (`change.madeIn`), a line more than one task has, there or
 * here, is refused: someone may have swapped two sections meanwhile,
 * putting another task with that line where it was, or leaving only the
 * other one (#703). Any change counts, a tick included, as two sections
 * may differ only in what is ticked, though not a box's `[X]` for `[x]`.
 * A task already as asked is left as it is, `[X]` included, so a change
 * made twice changes nothing more. A task that is gone, or whose line more
 * than one task has where the offset can't tell them apart, is refused
 * with why. `items` gives the task items, by default `taskIndex(markdown)`:
 * those of a text this one differs from only in what is ticked hold for
 * it too, their boxes as this text has them, as ticking moves no block, so
 * changes made one after another parse the page once.
 */
export function setTask(
  markdown: string,
  change: TaskChange,
  items: () => ReadonlyMap<number, TaskItem> = () => taskIndex(markdown),
): TaskEdit {
  // Whether its box is ticked in this text, which may have ticked it since the items were found.
  const now = (item: TaskItem): TaskItem => ({ ...item, checked: markdown[item.mark] !== ' ' });
  const named = change.line === '' ? 'That task' : `The task “${change.line}”`;
  const same = () => [...items().values()].filter((item) => item.line === change.line);
  const { madeIn } = change;
  // Changed since, with its line on more than one task where it was ticked, or here.
  const unclear = (here: () => number) =>
    madeIn !== undefined &&
    !sameText(madeIn.markdown, markdown, items()) &&
    (madeIn.repeated || here() > 1);
  // Said as it is now: on the page more than once, or only when it was ticked.
  const changedSince = (here: number) =>
    ({
      ok: false,
      reason:
        here > 1
          ? `${named} is on the page more than once, and the page changed since it was ticked.`
          : `${named} was on the page more than once when it was ticked, and the page has changed since.`,
    }) as const;
  const there = items().get(change.offset);
  let task: TaskItem | null = null;
  if (there?.line === change.line) {
    if (unclear(() => same().length)) return changedSince(same().length);
    task = now(there);
  } else {
    const found = same();
    if (found.length !== 1) {
      return {
        ok: false,
        reason:
          found.length === 0
            ? `${named} isn’t on the page any more.`
            : `${named} is on the page more than once now.`,
      };
    }
    if (unclear(() => 1)) return changedSince(1);
    task = found[0] ? now(found[0]) : null;
  }
  if (!task || task.checked === change.checked) return { ok: true, markdown };
  const mark = change.checked ? 'x' : ' ';
  return {
    ok: true,
    markdown: markdown.slice(0, task.mark) + mark + markdown.slice(task.mark + 1),
  };
}

/**
 * Whether `before` is `markdown`, but for boxes written `[X]` in one and
 * `[x]` in the other: one written `[X]`, unticked and ticked again in a
 * batch, is saved as it was, while the page showed `[x]` (#700). Its
 * boxes are where `items`, `markdown`'s task items, have them.
 */
function sameText(before: string, markdown: string, items: ReadonlyMap<number, TaskItem>): boolean {
  if (before === markdown) return true;
  if (before.length !== markdown.length) return false;
  let marks: Set<number> | null = null;
  for (let i = 0; i < before.length; i++) {
    const was = before[i];
    const is = markdown[i];
    if (was === is) continue;
    if (!((was === 'X' && is === 'x') || (was === 'x' && is === 'X'))) return false;
    marks ??= new Set([...items.values()].map(({ mark }) => mark));
    if (!marks.has(i)) return false;
  }
  return true;
}

/** How many task items in `markdown` have `line`, as `taskIndex` finds them. */
export function tasksWithLine(markdown: string, line: string): number {
  let count = 0;
  for (const item of taskIndex(markdown).values()) if (item.line === line) count++;
  return count;
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

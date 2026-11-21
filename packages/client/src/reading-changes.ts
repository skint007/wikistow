// Changes made while reading a page (#212): a task ticked, or a value a
// plugin block sets in the frontmatter. Each says what to set, never what
// to toggle, so making one again changes nothing more. It is made in the
// newest text as a targeted edit, one character for a task (`setTask`) and
// one value for a property (`setPageProperty`), so changes made meanwhile
// are never overwritten. One that no longer applies is left out, with why.
// The app's reading view makes them online; offline they wait in the
// queue (ADR 0009, decision 7; #695), which makes them here as it sends.
import { z } from 'zod';
import { splitFrontmatter } from './markdown/frontmatter.ts';
import { propertyKeyFor, setPageProperty, type PropertyValue } from './markdown/properties.ts';
import { setTask } from './markdown/tasks.ts';

/** A change made while reading: a task ticked or not, or a property set. */
export type ReadingChange =
  | { kind: 'task'; offset: number; line: string; checked: boolean }
  | { kind: 'property'; key: string; value: PropertyValue };

/** A change left out, as it no longer applies, and why. */
export type Dropped = { change: ReadingChange; reason: string };

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** A change as the queue keeps it. */
export const ReadingChangeJson: z.ZodType<ReadingChange> = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('task'),
    offset: z.number().int().nonnegative(),
    line: z.string(),
    checked: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('property'),
    key: z.string(),
    value: z.union([Scalar, z.array(z.union([Scalar, z.array(Scalar)]))]),
  }),
]);

/**
 * `markdown` with `change` made, or why it can't be. A property is the
 * key exactly as written, else the first whose name matches it as a
 * reference's does, else a new key (`propertyKeyFor`).
 */
export function applyChange(
  markdown: string,
  change: ReadingChange,
): { ok: true; markdown: string } | { ok: false; reason: string } {
  if (change.kind === 'task') return setTask(markdown, change);
  const key = propertyKeyFor(splitFrontmatter(markdown).frontmatter, change.key);
  const edit = setPageProperty(markdown, key, change.value);
  return edit.ok
    ? edit
    : { ok: false, reason: `${change.key} couldn’t be changed: ${edit.reason}` };
}

/** `markdown` with each of `changes` made, in order, and those that no longer apply. */
export function applyChanges(
  markdown: string,
  changes: readonly ReadingChange[],
): { markdown: string; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  for (const change of changes) {
    const made = applyChange(markdown, change);
    if (made.ok) markdown = made.markdown;
    else dropped.push({ change, reason: made.reason });
  }
  return { markdown, dropped };
}

/** Whether `a` and `b` set the same task or property, so the later one takes the earlier's place. */
export const sameTarget = (a: ReadingChange, b: ReadingChange): boolean =>
  a.kind === 'task'
    ? b.kind === 'task' && a.offset === b.offset && a.line === b.line
    : b.kind === 'property' && a.key === b.key;

/** `changes` with `change` after them, in place of an earlier one setting the same thing. */
export const withChange = (
  changes: readonly ReadingChange[],
  change: ReadingChange,
): ReadingChange[] => [...changes.filter((other) => !sameTarget(other, change)), change];

// The smallest change from one text to another, as a writer puts it into a
// session's `Y.Text` (protocol section 5.10, **The document**): one span,
// starting and ending between whole code points, never inside a surrogate
// pair, which Yjs would store as two U+FFFD for everyone else.
import { diffLines } from 'diff';
import type * as Y from 'yjs';

/** A change to a text: delete `remove` UTF-16 units at `from`, then insert `insert` there. */
export type TextChange = { from: number; remove: number; insert: string };

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The one span in which `before` and `after` differ, or null when they are
 * the same, widened to whole code points on both sides: the common prefix
 * and suffix, less any half of a surrogate pair at their edges.
 */
export function textChange(before: string, after: string): TextChange | null {
  if (before === after) return null;
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--;
    endAfter--;
  }
  // A span may not start after a pair's first half, nor end before its second.
  const splitsAt = (text: string, at: number) =>
    at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));
  while (start > 0 && (splitsAt(before, start) || splitsAt(after, start))) start--;
  while (
    (endBefore < before.length && splitsAt(before, endBefore)) ||
    (endAfter < after.length && splitsAt(after, endAfter))
  ) {
    endBefore++;
    endAfter++;
  }
  return { from: start, remove: endBefore - start, insert: after.slice(start, endAfter) };
}

/**
 * Make `text` read `after` by its smallest change, `after` made well-formed
 * first, as a writer inserts only well-formed text. Call within a transaction.
 */
export function changeText(text: Y.Text, after: string): boolean {
  const change = textChange(text.toJSON(), after.toWellFormed());
  if (!change) return false;
  if (change.remove > 0) text.delete(change.from, change.remove);
  if (change.insert !== '') text.insert(change.from, change.insert);
  return true;
}

/**
 * The changes from `before` to `after`, one for each run of lines that
 * differ, in order, each the smallest change within its lines: so a change
 * of two places far apart, as a fold or a rename makes, leaves the text
 * between them as it is, and typing others place there meanwhile stays
 * where they put it (ADR 0015 decision 8).
 */
export function textChanges(before: string, after: string): TextChange[] {
  if (before === after) return [];
  const changes: TextChange[] = [];
  let at = 0;
  let removed = '';
  let added = '';
  const flush = () => {
    const change = textChange(removed, added);
    if (change) changes.push({ ...change, from: change.from + at });
    at += removed.length;
    removed = '';
    added = '';
  };
  // Very different texts take time that grows with the square of their
  // size: past a fifth of a second, one span, as `textChange` makes.
  const parts = diffLines(before, after, { timeout: 200 });
  if (!parts) {
    const whole = textChange(before, after);
    return whole ? [whole] : [];
  }
  for (const part of parts) {
    if (part.removed) removed += part.value;
    else if (part.added) added += part.value;
    else {
      flush();
      at += part.value.length;
    }
  }
  flush();
  return changes;
}

/**
 * Make `text` read `after`, `after` made well-formed first, changing only
 * the runs of lines that differ (`textChanges`). Call within a transaction.
 */
export function changeTextByLines(text: Y.Text, after: string): boolean {
  const changes = textChanges(text.toJSON(), after.toWellFormed());
  // From the end, so each change's place is still where it was worked out.
  for (const change of changes.toReversed()) {
    if (change.remove > 0) text.delete(change.from, change.remove);
    if (change.insert !== '') text.insert(change.from, change.insert);
  }
  return changes.length > 0;
}

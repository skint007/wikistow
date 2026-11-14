// The smallest change from one text to another, as a writer puts it into a
// session's `Y.Text` (protocol section 5.10, **The document**): one span,
// starting and ending between whole code points, never inside a surrogate
// pair, which Yjs would store as two U+FFFD for everyone else.
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

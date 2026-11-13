import { z } from 'zod';

// Where a page or folder sits among the others in its folder, or at the top
// of its space, when the folder has an order of its own (protocol section
// 5.4, #400): a fractional index, compared byte by byte, so one item moves by
// changing its own key alone. The server sees the order of IDs it already
// sees, never a name.

/** The digits of a position, in byte order. */
export const POSITION_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Characters a position may have. Longer ones are written afresh, with the folder's others. */
export const MAX_POSITION_LENGTH = 100;

/** The smallest integer part, which a position never is alone. */
const SMALLEST = `A${'0'.repeat(26)}`;

/**
 * The length of a position's integer part, by its first character: `a` to
 * `z` for 2 to 27 characters upwards, `A` to `Z` for 27 to 2 below them.
 */
export function integerLength(head: string): number | null {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  return null;
}

/**
 * Whether `key` is a position: digits only, an integer part as long as its
 * head says, and a fraction, if any, that doesn't end in `0`, so another
 * always fits before it.
 */
export function isPosition(key: string): boolean {
  if (key.length === 0 || key.length > MAX_POSITION_LENGTH) return false;
  for (const char of key) if (!POSITION_DIGITS.includes(char)) return false;
  const length = integerLength(key[0] ?? '');
  if (length === null || length > key.length) return false;
  if (key === SMALLEST) return false;
  return !(key.length > length && key.endsWith('0'));
}

export const Position = z
  .string()
  .max(MAX_POSITION_LENGTH)
  .refine(isPosition, { message: 'Not a position' })
  .brand<'Position'>();
export type Position = z.infer<typeof Position>;

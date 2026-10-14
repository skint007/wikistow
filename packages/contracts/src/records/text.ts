import { z } from 'zod';

/**
 * Code points that can reverse, hide or break up the text around them: C0 and
 * C1 controls, the line and paragraph separators, and the bidi controls.
 * Names refuse them, and the CLI escapes them.
 */
export const UNSAFE_TEXT =
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** Well-formed text with no `UNSAFE_TEXT` code points. */
export const isPlainText = (text: string): boolean =>
  text.isWellFormed() && !UNSAFE_TEXT.test(text);

/**
 * A name a person typed: 1 to `max` Unicode scalar values (which is what zod
 * counts), stored as given with no normalization.
 */
export const PlainName = (max: number) =>
  z.string().min(1).max(max).refine(isPlainText, 'Names refuse control and bidi characters');

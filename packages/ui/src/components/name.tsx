import { UNSAFE_TEXT } from '@wikistow/contracts';

// Invisible code points `UNSAFE_TEXT` lets through, which can hide part of a
// name: zero-width space, word joiner, invisible operators and the BOM.
const INVISIBLE = /[\u200b\u2060-\u2064\ufeff]/;

/**
 * Text someone else chose (a person's name or email, a folder, page or space
 * name) with every control, text-direction or invisible code point shown as
 * `[U+202E]`, so it can't reorder or hide the text around it (protocol
 * section 3.3). For attributes such as `aria-label`; on screen, use `Name`.
 */
export function plainText(text: string): string {
  let out = '';
  for (const char of text) {
    if (UNSAFE_TEXT.test(char) || INVISIBLE.test(char) || !char.isWellFormed()) {
      out += `[U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}]`;
    } else out += char;
  }
  return out;
}

/**
 * A name in a sentence: isolated, so right-to-left text in it can't carry
 * into the words around it, with its controls shown (`plainText`).
 */
export function Name({ children }: { children: string }) {
  return <bdi>{plainText(children)}</bdi>;
}

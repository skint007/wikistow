import { isPropertyName } from './properties.ts';

// A reference to one of the page's values in its body (ADR 0006, decision
// 4): inline code starting with `=`, `` `=servings` ``, or Dataview's form,
// `` `= this.servings` ``. The name follows the template-variable rule, so
// code such as `` `=SUM(A1:A3)` `` stays code. References to other pages'
// values (`` `=[[Page]].key` ``) come later, as a `page` beside the name.

/** What a reference names: one of this page's properties, by a name that matches its key. */
export type PropertyReference = { name: string };

const REFERENCE = /^=[ \t]*(?:this\.)?(.*)$/s;

/**
 * The reference an inline code span's text is, or null when it is code:
 * `=name` or `= this.name`, the name trimmed (`findProperty` matches it).
 */
export function parsePropertyReference(code: string): PropertyReference | null {
  const name = REFERENCE.exec(code)?.[1]?.trim();
  return name !== undefined && isPropertyName(name) ? { name } : null;
}

/**
 * `text` written as Markdown that reads as exactly that text, inline: each
 * ASCII punctuation character escaped with a backslash, so nothing in it
 * is syntax (no emphasis, link, HTML, entity, code, table cell or
 * wikilink), and each line break or tab a space, so it stays in its
 * paragraph and starts no block. A space at either end is written as a
 * character reference, which Markdown doesn't trim.
 */
export function markdownLiteral(text: string): string {
  return text
    .replace(/\r\n?|[\n\t]/g, ' ')
    .replace(/[!-/:-@[-`{-~]/g, (char) => `\\${char}`)
    .replace(/^ | $/g, '&#32;');
}

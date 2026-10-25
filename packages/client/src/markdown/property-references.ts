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
 * paragraph and starts no block. Its first and last characters are
 * written as character references, which Markdown doesn't trim, as it
 * would a space, and which the text before can't read into: the letters
 * it starts with can't finish a tag name after `<`, an entity
 * after `&` or a link label after `[`.
 */
export function markdownLiteral(text: string): string {
  const chars = [...text.replace(/\r\n?|[\n\t]/g, ' ')];
  const reference = (char: string | undefined) =>
    char === undefined ? '' : `&#${char.codePointAt(0) ?? 0};`;
  const middle = chars
    .slice(1, -1)
    .join('')
    .replace(/[!-/:-@[-`{-~]/g, (char) => `\\${char}`);
  return chars.length < 2
    ? reference(chars[0])
    : `${reference(chars[0])}${middle}${reference(chars.at(-1))}`;
}

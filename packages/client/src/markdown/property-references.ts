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
 * paragraph and starts no block. Its first character, and a space at
 * either end, which Markdown would trim, are written as character
 * references, so the letters it starts with can't finish what the text
 * before it opened: a tag name after `<`, an entity after `&`, a link
 * label after `[`.
 */
export function markdownLiteral(text: string): string {
  const flat = text.replace(/\r\n?|[\n\t]/g, ' ');
  const first = flat.codePointAt(0);
  if (first === undefined) return '';
  const head = String.fromCodePoint(first);
  const escaped = flat
    .slice(head.length)
    .replace(/[!-/:-@[-`{-~]/g, (char) => `\\${char}`)
    .replace(/ $/, '&#32;');
  return `&#${first};${escaped}`;
}

import { isPropertyName } from './properties.ts';
import { parseWikilink, type Wikilink } from './wikilink.ts';

// A reference to a property's value in a page's body (ADR 0006, decisions
// 4 and 5): inline code starting with `=`. `` `=servings` ``, or Dataview's
// `` `= this.servings` ``, names one of the page's own values;
// `` `=[[Garlic bread]].cook_time` `` one of another page's, the page named
// by a wikilink that resolves as any other does. The name follows the
// template-variable rule, so code such as `` `=SUM(A1:A3)` `` stays code.

/**
 * What a reference names: a property, by a name that matches its key, of
 * this page, or of the page `page` links to.
 */
export type PropertyReference = { name: string; page?: ReferencedPage };

/**
 * The page a reference to another page's value names: a wikilink to a page
 * by its title alone, with no heading or text of its own, and where it is
 * in the code's text, from `start` up to `end`.
 */
export type ReferencedPage = Wikilink & { start: number; end: number };

const REFERENCE = /^=[ \t]*(?:this\.)?(.*)$/s;
const OTHER = /^(=[ \t]*)(\[\[[^[\]\r\n]+\]\])\.(.*)$/s;

/**
 * The reference an inline code span's text is, or null when it is code:
 * `=name` or `= this.name`, or `=[[Page]].name`, the name trimmed
 * (`findProperty` matches it).
 */
export function parsePropertyReference(code: string): PropertyReference | null {
  const other = OTHER.exec(code);
  if (other) {
    const [, before = '', source = '', rest = ''] = other;
    const link = parseWikilink(source);
    const name = rest.trim();
    if (!link || link.unsupported || link.embed || link.heading !== null || link.shown !== null) {
      return null;
    }
    if (link.target === '' || !isPropertyName(name)) return null;
    const { target, heading, shown, embed } = link;
    const start = before.length;
    return {
      name,
      page: { source, target, heading, shown, embed, start, end: start + source.length },
    };
  }
  const name = REFERENCE.exec(code)?.[1]?.trim();
  return name !== undefined && isPropertyName(name) ? { name } : null;
}

/** Whether `text` may hold a reference to another page's value: `=[[`, with spaces between or not. */
export const mayReferOtherPages = (text: string) => /=[ \t]*\[\[/.test(text);

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

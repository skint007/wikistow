import type { Link, Paragraph, Root } from 'mdast';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { readAlone } from './read-alone';

/** A link GFM reads in text: `from` to `to` in it, and where it goes. */
export type Literal = { from: number; to: number; href: string };

// GFM's own finding of autolink literals (`https://…`, `www.…`, an email)
// in the text a page is read as, the very step the reader runs after
// reading it, which no escape in the Markdown holds back.
const [findLiterals] = gfmAutolinkLiteralFromMarkdown().transforms ?? [];

// What GFM makes of `text` as one text node: its text and links in turn.
function read(text: string): (string | Link)[] {
  const paragraph: Paragraph = { type: 'paragraph', children: [{ type: 'text', value: text }] };
  const root: Root = { type: 'root', children: [paragraph] };
  findLiterals?.(root);
  return paragraph.children.map((child) => (child.type === 'link' ? child : textOf(child)));
}

const textOf = (node: { type: string; value?: string }) => node.value ?? '';

/**
 * The links the reader reads in `text`, a run of text with the same marks.
 * Each run between them is read again on its own, as it is once they're
 * written as links, until no more are found.
 */
export function literalLinks(text: string): Literal[] {
  const found: Literal[] = [];
  const within = (start: number, value: string) => {
    const parts = read(value);
    if (parts.every((part) => typeof part === 'string')) return;
    let at = start;
    for (const part of parts) {
      if (typeof part === 'string') {
        within(at, part);
        at += part.length;
        continue;
      }
      const shown = part.children.map(textOf).join('');
      found.push({ from: at, to: at + shown.length, href: part.url });
      at += shown.length;
    }
  };
  within(0, text);
  return found.sort((a, b) => a.from - b.from);
}

/** Whether GFM reads all of `text`, alone, as one link to `href`, as it would `href`'s literal. */
export function isLiteral(text: string, href: string): boolean {
  const [only, ...rest] = literalLinks(text);
  return (
    !!only && rest.length === 0 && only.from === 0 && only.to === text.length && only.href === href
  );
}

// A URL with a scheme and `//`, as `ftp://…`, which `<…>` reads as a link.
const SCHEMED = /^[a-z][a-z\d+.-]{1,31}:\/\//i;

/** An atom in a link's text, as an image or a line break, which is one character there. */
export const ATOM = '\uFFFC';

/**
 * Where a link whose text is `text` goes if its text is an address, as a
 * reader takes one: where GFM reads all of it, alone, as going (`www.…` to
 * `http://www.…`, `me@x.org` to `mailto:me@x.org`), or else where `<text>`
 * does if it's a URL with `//` (`ftp://…`); null if it's other text, as
 * `Re:Plan` or `bob@team` is, though `<…>` would link them, or holds an
 * atom, which no address does.
 */
export function addressOf(text: string): string | null {
  if (text.includes(ATOM)) return null;
  const [only, ...rest] = literalLinks(text);
  if (only && rest.length === 0 && only.from === 0 && only.to === text.length) return only.href;
  if (!SCHEMED.test(text)) return null;
  const read = readAlone(`<${text}>`);
  if (read?.type !== 'link') return null;
  const [shown, ...more] = read.children;
  return shown?.type === 'text' && shown.value === text && more.length === 0 ? read.url : null;
}

import { markdownNodes, markdownText } from '../markdown/index.ts';
import type { Root } from 'mdast';
import type {} from 'mdast-util-to-hast';

/**
 * A heading's text as an anchor: lowercased, punctuation dropped, spaces as
 * dashes. For an ordinary heading that is GitHub's anchor too, so an export
 * with Markdown links (`export.ts`) lands on it there.
 */
export const headingSlug = (text: string) =>
  text
    .trim()
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');

/**
 * The id a heading with this text gets, which `[[Page#Heading]]` links to:
 * its `headingSlug`, prefixed to keep a page's headings clear of the app's
 * own ids.
 */
export const headingId = (text: string) => `heading-${headingSlug(text)}`;

/**
 * A remark plugin: each heading gets its `headingId`, and a repeat the
 * first of `-1`, `-2`, … no heading above it has taken, so ids stay unique
 * and the first heading of a text keeps the plain one.
 */
export function headingIds() {
  return (tree: Root) => {
    const taken = new Set<string>();
    const repeats = new Map<string, number>();
    for (const node of markdownNodes(tree)) {
      if (node.type !== 'heading') continue;
      const base = headingId(markdownText(node));
      let n = repeats.get(base) ?? 0;
      let id = base;
      while (taken.has(id)) id = `${base}-${++n}`;
      taken.add(id);
      repeats.set(base, n);
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
    }
  };
}

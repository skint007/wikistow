import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { wikilinkFromMarkdown, wikilinkSyntax } from './wikilink.ts';

export * from './frontmatter.ts';
export * from './link-spans.ts';
export * from './properties.ts';
export * from './property-text.ts';
export * from './wikilink.ts';

/**
 * A page body (frontmatter already split off) as mdast, read the way the
 * reader reads it: GitHub-flavoured Markdown plus wikilinks.
 */
export const parseMarkdown = (body: string): Root =>
  fromMarkdown(body, {
    extensions: [gfm(), wikilinkSyntax],
    mdastExtensions: [gfmFromMarkdown(), wikilinkFromMarkdown],
  });

/** Every node of `tree`, in document order. */
export function* markdownNodes(tree: Nodes): Generator<Nodes> {
  yield tree;
  if ('children' in tree) for (const child of tree.children) yield* markdownNodes(child);
}

/**
 * The text a reader sees in `node`; a wikilink counts as written (its
 * `value`), and HTML, which the reader renders, as nothing.
 */
export const markdownText = (node: Nodes): string =>
  node.type === 'html'
    ? ''
    : 'value' in node
      ? node.value
      : 'children' in node
        ? node.children.map(markdownText).join('')
        : '';

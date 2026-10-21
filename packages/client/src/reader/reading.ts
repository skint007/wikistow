// How the reader reads a page body, up to the tree it turns into HTML. No
// React here: the reader's worker (`packages/ui/src/page/markdown.worker.ts`)
// loads this.
import {
  markdownNodes,
  markdownText,
  parseMarkdown,
  splitFrontmatter,
  wikilinkFromMarkdown,
  wikilinkSyntax,
  wikilinkToMarkdown,
} from '../markdown/index.ts';
import type { Root, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import type {} from 'remark-stringify';
import { unified, type PluggableList, type Processor } from 'unified';
import { remarkAlerts } from './alerts.ts';
import { headingIds } from './heading-ids.ts';

/** A remark plugin: reads `[[…]]` and `![[…]]` as wikilink nodes, and writes them back verbatim. */
export function remarkWikilinks(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(wikilinkSyntax);
  (data.fromMarkdownExtensions ??= []).push(wikilinkFromMarkdown);
  (data.toMarkdownExtensions ??= []).push(wikilinkToMarkdown);
}

/**
 * How a syntax beyond GitHub's is read: the remark plugins that read it
 * into `type` nodes. Its entry in `markdownSyntaxes`
 * (`packages/ui/src/registries.tsx`) adds
 * how each view shows them.
 */
export type SyntaxReading = { type: RootContent['type']; remarkPlugins: PluggableList };

export const wikilinkReading = {
  type: 'wikilink',
  remarkPlugins: [remarkWikilinks],
} satisfies SyntaxReading;

/** Every syntax a page body is read with beyond GitHub's, each registered in `markdownSyntaxes`. */
export const syntaxReadings: readonly SyntaxReading[] = [wikilinkReading];

/**
 * Remark plugins every page body is read with, in order: GitHub's syntax
 * and its alerts, the others (`syntaxReadings`), then heading ids. The page
 * renders raw HTML (`pageHtml`).
 */
const markdownExtensions: PluggableList = [
  remarkGfm,
  remarkAlerts,
  ...syntaxReadings.flatMap((syntax) => syntax.remarkPlugins),
  headingIds,
];

/**
 * A page body, frontmatter split off, read as the reader reads it: the
 * Markdown tree its plugins leave, which the page turns into HTML. This is
 * the part whose time grows faster than the body (#47).
 */
export function readBody(body: string): Root {
  const processor = unified().use(remarkParse).use(markdownExtensions);
  const tree = processor.parse(body);
  // Each plugin changes the tree in place; none returns another.
  processor.runSync(tree);
  return tree;
}

/** The text of each heading of a page's Markdown, in order, outside its frontmatter and code. */
export function headingTexts(markdown: string): string[] {
  const texts: string[] = [];
  for (const node of markdownNodes(parseMarkdown(splitFrontmatter(markdown).body))) {
    if (node.type === 'heading') texts.push(markdownText(node).trim());
  }
  return texts;
}

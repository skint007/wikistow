import type { Nodes, Root } from 'hast';
import type {} from 'mdast-util-to-hast';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as Schema } from 'rehype-sanitize';
import { unified } from 'unified';

/** The property marking a registered syntax's placeholder span (`data-syntax`), which `pageHtml` keeps. */
export const SYNTAX = 'dataSyntax';

const attributes = defaultSchema.attributes ?? {};
const protocols = defaultSchema.protocols ?? {};
const tagNames = defaultSchema.tagNames ?? [];
// The scheme without its colon, as `protocols` lists them; `ATTACHMENT_SCHEME`.
const attachment = 'attachment';

/**
 * What a page's HTML may hold: GitHub's own list (`defaultSchema`), so no
 * script, style, event handlers, forms or frames. Beyond it, links and
 * images may point at attachments, highlighted code and alerts keep their
 * classes (`highlightCode`, `remarkAlerts`), and a registered syntax's placeholder span keeps its
 * `SYNTAX`. Ids aren't prefixed, so links to headings and
 * footnotes still find them; names, which can stand in for the document's
 * own properties, are. A `<picture>` and its sources go, so an image loads
 * only from its `src`, which the reader shows only if it's an attachment.
 */
const schema: Schema = {
  ...defaultSchema,
  clobber: ['name'],
  protocols: {
    ...protocols,
    href: [...(protocols.href ?? []), attachment],
    src: [...(protocols.src ?? []), attachment],
  },
  attributes: {
    ...attributes,
    span: [...(attributes.span ?? []), SYNTAX, ['className', /^hljs-/]],
    div: [...(attributes.div ?? []), ['className', /^markdown-alert(?:-[a-z]+)?$/]],
  },
  tagNames: tagNames.filter((name) => name !== 'picture' && name !== 'source'),
};

// Raw HTML parsed as a browser would, the Markdown around it included
// (`<details>` around a list, say), with GitHub's tag filter, which shows
// `<script>`, `<style>`, `<textarea>` and others like them as text.
const parse = rehypeRaw({ tagfilter: true });
const clean = rehypeSanitize(schema);

/** Whether `tree` holds raw HTML, read without recursion, as a page may nest deep. */
function hasHtml(tree: Root): boolean {
  const stack: Nodes[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type === 'raw') return true;
    if ('children' in node) for (const child of node.children) stack.push(child);
  }
  return false;
}

/**
 * A rehype plugin that renders a page's raw HTML: parsed, then sanitized by
 * `schema`. A page without any is left as it is, as there'd be nothing to
 * take out, and parsing it again takes about as long as rendering it.
 */
export function pageHtml() {
  return (tree: Root, file: Parameters<typeof parse>[1]) =>
    hasHtml(tree) ? clean(parse(tree, file)) : tree;
}

const parseAndClean = unified().use(rehypeRaw, { tagfilter: true }).use(rehypeSanitize, schema);
const cleanOnly = unified().use(rehypeSanitize, schema);

/**
 * `tree` as `pageHtml` leaves it, but sanitized whether or not it holds raw
 * HTML: for a page shown outside the app (a public page, ADR 0005), where
 * no `urlTransform` checks its link and image addresses first.
 */
export const sanitizedPage = (tree: Root): Root =>
  (hasHtml(tree) ? parseAndClean : cleanOnly).runSync(tree);

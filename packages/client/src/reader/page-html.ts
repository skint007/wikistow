import type { Element, ElementContent, Nodes, Root } from 'hast';
import type {} from 'mdast-util-to-hast';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as Schema } from 'rehype-sanitize';
import { unified } from 'unified';

/** The property marking a registered syntax's placeholder span (`data-syntax`), which `pageHtml` keeps. */
export const SYNTAX = 'dataSyntax';

/**
 * The property marking a task item's checkbox (`data-task`) with where its
 * list item starts in the page's whole Markdown (`taskMarks`), which
 * `pageHtml` keeps, so the reader can tick it (`setTask`).
 */
export const TASK = 'dataTask';

const attributes = defaultSchema.attributes ?? {};
const protocols = defaultSchema.protocols ?? {};
const tagNames = defaultSchema.tagNames ?? [];
// The scheme without its colon, as `protocols` lists them; `ATTACHMENT_SCHEME`.
const attachment = 'attachment';

/**
 * What a page's HTML may hold: GitHub's own list (`defaultSchema`), so no
 * script, style, event handlers, forms or frames. Beyond it, links and
 * images may point at attachments, highlighted code and alerts keep their
 * classes (`highlightCode`, `remarkAlerts`), a registered syntax's placeholder span keeps its
 * `SYNTAX`, and a task's checkbox its `TASK` and label (`taskMarks`). Ids aren't prefixed, so links to headings and
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
    input: [...(attributes.input ?? []), TASK, 'ariaLabel'],
    div: [...(attributes.div ?? []), ['className', /^markdown-alert(?:-[a-z]+)?$/]],
  },
  tagNames: tagNames.filter((name) => name !== 'picture' && name !== 'source'),
};

/** The text a reader sees in `nodes`, nested lists left out. Read without recursion. */
function itemText(nodes: readonly ElementContent[]): string {
  let text = '';
  const stack = [...nodes].reverse();
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type === 'text') text += node.value;
    else if (node.type === 'element' && node.tagName !== 'ul' && node.tagName !== 'ol')
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child) stack.push(child);
      }
  }
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A task item's checkbox (`li.task-list-item`), first in it or in its first
 * paragraph, and what it ticks: that paragraph, or the item's own text.
 */
function checkboxOf(item: Element): { box: Element; text: ElementContent[] } | null {
  const first = item.children.find((child) => child.type === 'element');
  const paragraph = first?.type === 'element' && first.tagName === 'p' ? first : null;
  const box = paragraph ? paragraph.children.find((child) => child.type === 'element') : first;
  return box?.type === 'element' && box.tagName === 'input'
    ? { box, text: paragraph?.children ?? item.children }
    : null;
}

/**
 * A rehype plugin, before `pageHtml`, marking each task item's checkbox
 * with where its list item starts in the page's whole Markdown (`TASK`):
 * its offset in the body, plus `start`, where the body starts. Each is
 * labelled by its item's text. Raw HTML is still unparsed then, so a
 * checkbox the page's own HTML holds isn't marked; one that marks itself
 * can only name a task of the page, which is checked against the
 * Markdown there before it is ticked (`taskAt`). Read without recursion,
 * as a page may nest deep.
 */
export function taskMarks(start: number) {
  return (tree: Root) => {
    const stack: Nodes[] = [tree];
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (node.type === 'element' && node.tagName === 'li') {
        const { className } = node.properties;
        const offset = node.position?.start.offset;
        const task = checkboxOf(node);
        if (
          Array.isArray(className) &&
          className.includes('task-list-item') &&
          task &&
          offset !== undefined
        ) {
          task.box.properties[TASK] = start + offset;
          const label = itemText(task.text);
          if (label) task.box.properties['ariaLabel'] = label;
        }
      }
      if ('children' in node) for (const child of node.children) stack.push(child);
    }
  };
}

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

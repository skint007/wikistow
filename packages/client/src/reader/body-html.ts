// A page body as sanitized HTML, for reading it outside the app: the
// server's public pages (ADR 0005) render it so, and the app works out
// from it which attachments a public copy needs. No React here, and no
// highlighting: callers that want it run `highlightCode` first.
import type { Element, ElementContent, Root as HastRoot, Nodes as HastNodes } from 'hast';
import type { Root, WikilinkNode } from 'mdast';
import { toHast } from 'mdast-util-to-hast';
import { resolveWikilinks } from '../links.ts';
import { sanitizedPage } from './page-html.ts';

/** How a link or image names one of the page's attachments: `attachment:<id>`. */
export const ATTACHMENT_SCHEME = 'attachment:';

/** What a wikilink becomes in `bodyHtml`. */
export type WikilinkHtml = (link: WikilinkNode) => ElementContent | ElementContent[] | undefined;

/**
 * A page body, read as the reader reads it (`readBody`), as HTML: its raw
 * HTML parsed and the whole of it sanitized (`sanitizedPage`), each
 * wikilink made by `wikilink` first, so it is sanitized with the rest.
 */
export function bodyHtml(tree: Root, wikilink: WikilinkHtml): HastRoot {
  const html = toHast(tree, {
    allowDangerousHtml: true,
    handlers: { wikilink: (_state, node: WikilinkNode) => wikilink(node) },
  });
  return sanitizedPage(html.type === 'root' ? html : { type: 'root', children: [] });
}

/**
 * An embed (`![[file.png]]`) as the reader shows it: an image of the page's
 * attachment of that name if it is an image, else a link to it, each by
 * `attachment:<id>`; its text as written if the page has none of that name.
 */
export function embedHtml(
  link: WikilinkNode,
  attachments: readonly { id: string; name: string; mediaType: string }[],
): ElementContent {
  const [found] = resolveWikilinks([link], { pages: [], selfId: '', attachments });
  const ref =
    found?.status === 'resolved' ? attachments.find((a) => a.id === found.targets[0]) : undefined;
  if (!ref) return { type: 'text', value: link.source };
  const text = link.shown ?? ref.name;
  const href = `${ATTACHMENT_SCHEME}${ref.id}`;
  return ref.mediaType.startsWith('image/')
    ? { type: 'element', tagName: 'img', properties: { src: href, alt: text }, children: [] }
    : {
        type: 'element',
        tagName: 'a',
        properties: { href },
        children: [{ type: 'text', value: text }],
      };
}

/** The attachment a link or image names (`attachment:<id>`), or null. */
export function attachmentOf(element: Element): string | null {
  const url =
    element.tagName === 'a'
      ? element.properties['href']
      : element.tagName === 'img'
        ? element.properties['src']
        : undefined;
  return typeof url === 'string' && url.startsWith(ATTACHMENT_SCHEME)
    ? url.slice(ATTACHMENT_SCHEME.length)
    : null;
}

/** The attachments `tree` shows or links to, by ID, each once, in order. Read without recursion. */
export function attachmentsShown(tree: HastRoot): string[] {
  const found = new Set<string>();
  const stack: HastNodes[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type === 'element') {
      const id = attachmentOf(node);
      if (id) found.add(id);
    }
    if (!('children' in node)) continue;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child) stack.push(child);
    }
  }
  return [...found];
}

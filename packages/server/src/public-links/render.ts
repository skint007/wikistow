// The body of a public page (ADR 0005, decision 6), rendered with the
// reader's own rules (`@wikistow/client/reader`) as the app reads a page,
// for a page with no script: images only from the copy's own files, other
// attachments as downloads, and links to other pages left as gaps, filled
// in each time the page is served. Pure: it runs in the render worker.
import { foldTitle } from '@wikistow/client/links';
import {
  ALERTS,
  attachmentOf,
  attachmentsShown,
  bodyHtml,
  embedHtml,
  headingId,
  highlightCode,
  readBody,
  type AlertType,
} from '@wikistow/client/reader';
import type { Element, ElementContent } from 'hast';
import { toHtml } from 'hast-util-to-html';
import type { WikilinkNode } from 'mdast';
import { randomBytes } from 'node:crypto';
import { pageKey, RASTER_TYPES, type Gap, type Segment } from './segments.ts';

/** An attachment the app listed for a copy. */
export type ListedFile = { id: string; name: string; mediaType: string; size: number };

/** Whether the copy keeps a file the body uses, or leaves it out for its size. */
export type ChosenFile = { id: string; leftOut: boolean };

export type RenderInput = {
  markdown: string;
  /** The link's id, which the copy's files are served under. */
  linkId: string;
  attachments: readonly ListedFile[];
  limits: { fileBytes: number; copyBytes: number };
  /** The files a copy already has, when rendering it again; otherwise chosen here. */
  files?: ChosenFile[];
};

export type Rendered = { segments: Segment[]; files: ChosenFile[] };

/**
 * Which of the attachments the body uses (`used`, in order) the copy keeps:
 * each up to `fileBytes`, until together they would pass `copyBytes`.
 */
export function chooseFiles(
  used: readonly string[],
  attachments: readonly ListedFile[],
  { fileBytes, copyBytes }: RenderInput['limits'],
): ChosenFile[] {
  const listed = new Map(attachments.map((a) => [a.id, a]));
  let total = 0;
  return used.flatMap((id) => {
    const file = listed.get(id);
    if (!file) return [];
    const leftOut = file.size > fileBytes || total + file.size > copyBytes;
    if (!leftOut) total += file.size;
    return [{ id, leftOut }];
  });
}

const text = (value: string): ElementContent => ({ type: 'text', value });
const element = (
  tagName: string,
  properties: Element['properties'],
  children: ElementContent[],
): Element => ({ type: 'element', tagName, properties, children });

/** The text in `node`, as a reader sees it. */
function textOf(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

/** A link to a page's address in a WikiStow app, on any host, as `findPageLinks` reads one. */
const PAGE_URL =
  /^(?:https?:\/\/[^/?#\s]+)?\/s\/([A-Za-z0-9_-]{1,64})\/p\/([A-Za-z0-9_-]{1,64})(?=$|[/?#])/;

/**
 * Render a copy's body (`input.markdown`, its frontmatter already left out)
 * as segments of sanitized HTML with gaps between, for links to other
 * pages, and the files it keeps of those its body uses. Each link to
 * another page is marked with a value chosen for this render alone, after
 * the page is read, and the HTML split at those marks, so nothing written
 * in the page can make a gap.
 */
export function renderBody(input: RenderInput): Rendered {
  const mark = randomBytes(16).toString('hex');
  const gaps: Gap[] = [];
  const gapAt = (gap: Gap): ElementContent => {
    gaps.push(gap);
    return text(`${mark}${gaps.length - 1}`);
  };
  // A wikilink to another page goes out as a link to `#<mark>-<n>`, the
  // n-th gap's, which survives sanitizing; the walk below makes it a gap.
  const wikilinks: Gap[] = [];
  const wikilink = (link: WikilinkNode): ElementContent | undefined => {
    if (link.unsupported) return text(link.source);
    if (link.embed) return embedHtml(link, input.attachments);
    if (link.target === '') {
      return element('a', { href: `#${headingId(link.heading ?? '')}` }, [text(link.value)]);
    }
    wikilinks.push({
      key: foldTitle(link.target),
      text: link.value,
      ...(link.heading ? { hash: headingId(link.heading) } : {}),
    });
    return element('a', { href: `#${mark}-${wikilinks.length - 1}` }, [text(link.value)]);
  };
  const tree = bodyHtml(highlightCode(readBody(input.markdown)), wikilink);
  const files = input.files ?? chooseFiles(attachmentsShown(tree), input.attachments, input.limits);
  const listed = new Map(input.attachments.map((a) => [a.id, a]));
  const kept = new Map(files.map((file) => [file.id, file.leftOut]));
  const fileUrl = (id: string) =>
    `/p/${encodeURIComponent(input.linkId)}/files/${encodeURIComponent(id)}`;

  // What the page shows for an attachment it links to or shows: a download
  // of the copy's file, or its text if the copy hasn't it.
  const download = (id: string, children: ElementContent[], inLink: boolean): ElementContent => {
    const file = listed.get(id);
    const leftOut = kept.get(id);
    if (!file || leftOut === undefined || inLink) return element('span', {}, children);
    if (leftOut) {
      return element('span', { className: ['not-available'] }, [
        ...children,
        text(' (not available)'),
      ]);
    }
    return element('a', { href: fileUrl(id), download: file.name, className: ['file'] }, children);
  };

  const image = (node: Element, inLink: boolean): ElementContent => {
    const alt = typeof node.properties['alt'] === 'string' ? node.properties['alt'] : '';
    const id = attachmentOf(node);
    const file = id === null ? undefined : listed.get(id);
    if (id === null || !file || !kept.has(id)) {
      // As in the app, nothing is fetched from anywhere else.
      return element('span', { className: ['not-loaded'] }, [
        text(alt ? `Image not loaded: ${alt}` : 'Image not loaded'),
      ]);
    }
    if (kept.get(id) || !RASTER_TYPES.has(file.mediaType)) {
      return download(id, [text(alt || file.name)], inLink);
    }
    return element('img', { src: fileUrl(id), alt: alt || file.name }, []);
  };

  const link = (node: Element, inLink: boolean): ElementContent | ElementContent[] => {
    const href = node.properties['href'];
    if (typeof href !== 'string') return { ...node, children: walk(node.children, inLink) };
    const wikilinkAt = href.startsWith(`#${mark}-`) ? Number(href.slice(mark.length + 2)) : NaN;
    const marked = wikilinks[wikilinkAt];
    if (marked) return inLink ? text(marked.text) : gapAt(marked);
    const id = attachmentOf(node);
    if (id !== null) return download(id, walk(node.children, true), inLink);
    // Its page names itself in its address, which never goes out as it is.
    const [, , pageId] = PAGE_URL.exec(href) ?? [];
    if (pageId) {
      const written = textOf(node);
      return inLink ? text(written) : gapAt({ key: pageKey(pageId), text: written });
    }
    const children = walk(node.children, true);
    if (href.startsWith('#')) return { ...node, children };
    return {
      ...node,
      properties: { ...node.properties, rel: ['noopener', 'noreferrer'] },
      children,
    };
  };

  // The sanitized tree as a public page shows it. Recursive: a body nested
  // past the stack fails the render, and is shown as written.
  const walk = (nodes: readonly ElementContent[], inLink: boolean): ElementContent[] =>
    nodes.flatMap((node): ElementContent | ElementContent[] => {
      if (node.type !== 'element') return node;
      if (node.tagName === 'a') return link(node, inLink);
      if (node.tagName === 'img') return image(node, inLink);
      const children = walk(node.children, inLink);
      const alert = alertType(node);
      if (alert) {
        const title = element('p', { className: ['markdown-alert-title'] }, [text(ALERTS[alert])]);
        return { ...node, children: [title, ...children] };
      }
      if (node.tagName === 'pre') {
        const code = node.children.find(
          (child): child is Element => child.type === 'element' && child.tagName === 'code',
        );
        if (!code) return { ...node, children };
        return element('div', { className: ['code-block'] }, [
          element('div', { className: ['code-language'] }, [text(languageOf(code) || 'text')]),
          { ...node, children },
        ]);
      }
      if (node.tagName === 'table') {
        return element('div', { className: ['table-scroll'] }, [{ ...node, children }]);
      }
      return { ...node, children };
    });

  // Sanitizing leaves no doctype.
  const body = tree.children.filter((node): node is ElementContent => node.type !== 'doctype');
  const html = toHtml({ type: 'root', children: walk(body, false) });
  return { segments: split(html, mark, gaps), files };
}

/** The alert a `div` is (`remarkAlerts`), by its class, or null. */
function alertType(node: Element): AlertType | null {
  if (node.tagName !== 'div') return null;
  const names = node.properties['className'];
  const type = Array.isArray(names)
    ? names
        .map(String)
        .find((name) => name.startsWith('markdown-alert-'))
        ?.slice('markdown-alert-'.length)
    : undefined;
  return type && Object.hasOwn(ALERTS, type) ? (type as AlertType) : null;
}

/** A code element's language, from its `language-…` class, as fenced code is labelled. */
function languageOf(code: Element): string | undefined {
  const names = code.properties['className'];
  return Array.isArray(names)
    ? names
        .map(String)
        .find((name) => name.startsWith('language-'))
        ?.slice('language-'.length)
    : undefined;
}

/** `html` split at each gap's mark, into its segments. */
function split(html: string, mark: string, gaps: readonly Gap[]): Segment[] {
  const segments: Segment[] = [];
  const marks = new RegExp(`${mark}(\\d+)`, 'g');
  let from = 0;
  for (const found of html.matchAll(marks)) {
    const gap = gaps[Number(found[1])];
    if (!gap) continue;
    segments.push(html.slice(from, found.index), gap);
    from = found.index + found[0].length;
  }
  segments.push(html.slice(from));
  return segments;
}

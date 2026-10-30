// Wikilinks in a page's Markdown (wikistow.md, Wikilinks), and how each
// resolves against the pages a person or agent can see in the space. The
// source keeps the readable `[[Page title]]` text; resolution runs here,
// on the client, because titles are encrypted.

import {
  markdownNodes,
  markdownText,
  parseMarkdown,
  parsePropertyReference,
  propertyWikilink,
  readProperties,
  splitFrontmatter,
  type Wikilink,
} from './markdown/index.ts';
import type { OpenedMetadata } from './metadata.ts';

export type LinkStatus = 'resolved' | 'missing' | 'ambiguous';

export type ResolvedLink = Wikilink & {
  status: LinkStatus;
  /** The page or attachment it resolved to, or the candidates when ambiguous. */
  targets: string[];
};

/** A page as resolution sees it: its ID, title and the names of the folders above it, outermost first. */
export type LinkablePage = { id: string; title: string | null; folders: readonly string[] };

/**
 * Each page of a tree, as `loadTree` gives it, with the names of the
 * folders above it, for resolution. A folder whose name can't be read
 * counts with an empty name.
 */
export function linkablePages<Id extends string>(tree: {
  folders: readonly { id: Id; parentId: Id | null; metadata: { opened: OpenedMetadata } | null }[];
  pages: readonly { id: string; title: string | null; parentId: Id | null }[];
}): LinkablePage[] {
  const folders = new Map(tree.folders.map((folder) => [folder.id, folder]));
  const above = (parentId: Id | null): string[] => {
    const names: string[] = [];
    const seen = new Set<Id>();
    for (let id = parentId; id !== null && !seen.has(id);) {
      seen.add(id);
      const folder = folders.get(id);
      if (!folder) break;
      const opened = folder.metadata?.opened;
      names.unshift(opened?.kind === 'current' ? opened.metadata.name : '');
      id = folder.parentId;
    }
    return names;
  };
  return tree.pages.map((page) => ({
    id: page.id,
    title: page.title,
    folders: above(page.parentId),
  }));
}

/**
 * Every supported wikilink in `markdown`, in order. Frontmatter, code and
 * HTML hold none, and page embeds (`![[Page]]`) and block references
 * (`[[Page#^id]]`) are left out: they stay as inert text.
 */
export const findWikilinks = (markdown: string): Wikilink[] =>
  placedWikilinks(markdown).map(({ source, target, heading, shown, embed }) => ({
    source,
    target,
    heading,
    shown,
    embed,
  }));

/**
 * A wikilink and where it sits in the page's Markdown, from `start` up to
 * `end`. A link that is a property's value (`tableWikilinks`) has
 * `property`, its key as written, and the span of the value's source,
 * quoted as the block writes it.
 */
export type PlacedWikilink = Wikilink & { start: number; end: number; property?: string };

/** Every supported wikilink in `markdown`, as `findWikilinks` finds them, with where each is. */
export const placedWikilinks = (markdown: string): PlacedWikilink[] =>
  readLinks(markdown, { references: false });

/**
 * The wikilinks a page's link table holds entries for (wikistow.md,
 * Wikilinks), in the order they are written: each property whose value is
 * exactly one wikilink (`goes_with: "[[Page]]"`), then the body's
 * (`placedWikilinks`) and the page each reference to another page's value
 * names (`` `=[[Page]].key` ``, ADR 0006 decision 5), which a save renames
 * like any other. Readers show only the body's as links.
 */
export function tableWikilinks(markdown: string): PlacedWikilink[] {
  if (!markdown.includes('[[')) return [];
  const { frontmatter } = splitFrontmatter(markdown);
  const read = frontmatter?.includes('[[') ? readProperties(frontmatter) : null;
  const properties: PlacedWikilink[] = [];
  for (const { key, value, valueSpan } of read?.ok ? read.properties : []) {
    const link = propertyWikilink(value);
    if (link) properties.push({ ...link, ...valueSpan, property: key });
  }
  return [...properties, ...readLinks(markdown, { references: true })];
}

/** The body's wikilinks, and with `references` the pages references to other pages' values name. */
function readLinks(markdown: string, { references }: { references: boolean }): PlacedWikilink[] {
  // Every wikilink is written with `[[`; a page without one isn't parsed.
  if (!markdown.includes('[[')) return [];
  const { frontmatter, body } = splitFrontmatter(markdown);
  const offset = frontmatter?.length ?? 0;
  const links: PlacedWikilink[] = [];
  for (const node of markdownNodes(parseMarkdown(body))) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    if (node.type === 'wikilink' && !node.unsupported) {
      const { source, target, heading, shown, embed } = node;
      links.push({
        source,
        target,
        heading,
        shown,
        embed,
        start: offset + start,
        end: offset + end,
      });
    } else if (references && node.type === 'inlineCode' && node.value.includes('[[')) {
      const page = parsePropertyReference(node.value)?.page;
      if (!page) continue;
      // The code's text has its backticks and maybe a space taken off each
      // side, and a line break read as a space: its link is the first `[[`
      // of the source, which only backticks, spaces and `=` come before.
      const at = body.indexOf('[[', start);
      if (at < 0 || at >= end || !body.startsWith(page.source, at)) continue;
      const { source, target, heading, shown, embed } = page;
      links.push({
        source,
        target,
        heading,
        shown,
        embed,
        start: offset + at,
        end: offset + at + source.length,
      });
    }
  }
  return links;
}

/** A title or link target as titles match: case-insensitively. */
export const foldTitle = (text: string) => text.toLocaleLowerCase('en');
const fold = foldTitle;

/**
 * Linkable pages with a title, by title as titles match, in their order, and
 * each one's title by ID: for resolving many links against the same pages
 * without reading every page for each.
 */
export type PageIndex = {
  titled: ReadonlyMap<string, readonly LinkablePage[]>;
  titles: ReadonlyMap<string, string>;
};

export function pageIndex(pages: readonly LinkablePage[]): PageIndex {
  const titled = new Map<string, LinkablePage[]>();
  const titles = new Map<string, string>();
  for (const page of pages) {
    if (page.title === null) continue;
    const key = fold(page.title);
    const same = titled.get(key);
    if (same) same.push(page);
    else titled.set(key, [page]);
    if (!titles.has(page.id)) titles.set(page.id, page.title);
  }
  return { titled, titles };
}

/**
 * How each link resolves. Titles match case-insensitively among `pages`,
 * the ones the writer can see in the space; `Folder/title` also matches the
 * folders above the page, innermost last. `[[#Heading]]` is this page
 * (`selfId`). An embed resolves against `attachments`, this page's
 * attachment names. Unresolved links are reported, never refused. `index`,
 * `pageIndex(pages)`, saves reading every page for each link.
 */
export function resolveWikilinks(
  links: readonly Wikilink[],
  {
    pages,
    selfId,
    attachments = [],
    index,
  }: {
    pages: readonly LinkablePage[];
    selfId: string;
    attachments?: readonly { id: string; name: string }[];
    index?: PageIndex;
  },
): ResolvedLink[] {
  return links.map((link) => {
    const found = link.embed
      ? attachments.filter((a) => fold(a.name) === fold(link.target)).map((a) => a.id)
      : link.target === ''
        ? [selfId]
        : pagesFor(link.target, pages, index);
    const status: LinkStatus =
      found.length === 1 ? 'resolved' : found.length === 0 ? 'missing' : 'ambiguous';
    return { ...link, status, targets: found };
  });
}

function pagesFor(target: string, pages: readonly LinkablePage[], index?: PageIndex): string[] {
  const titled = (title: string) =>
    index
      ? (index.titled.get(fold(title)) ?? [])
      : pages.filter((page) => page.title !== null && fold(page.title) === fold(title));
  const exact = titled(target);
  if (exact.length > 0 || !target.includes('/')) return exact.map((page) => page.id);
  const parts = target.split('/').map((part) => fold(part.trim()));
  const title = parts.pop() ?? '';
  return titled(title)
    .filter((page) => {
      const above = page.folders.map(fold);
      return (
        parts.length <= above.length &&
        parts.every((part, i) => above[above.length - parts.length + i] === part)
      );
    })
    .map((page) => page.id);
}

/** A Markdown link to a page of a WikiStow app, as written. */
export type PageLink = { source: string; text: string; spaceId: string; pageId: string };

const PAGE_URL =
  /^(?:https?:\/\/[^/?#\s]+)?\/s\/([A-Za-z0-9_-]{1,64})\/p\/([A-Za-z0-9_-]{1,64})(?=$|[/?#])/;

/**
 * Every link in `markdown` to a page's address in a WikiStow app
 * (`/s/<space>/p/<page>`, on any host), in order: inline links, autolinks,
 * and reference links (`[text][label]`, `[text][]`, `[text]`), each named by
 * its own text. A reference goes where its label's first definition points.
 * A definition alone shows readers nothing, so it isn't listed. Code and
 * frontmatter hold none, as for `findWikilinks`. Addresses in raw HTML
 * aren't found, so callers say links "may" not open rather than listing
 * every one.
 */
export function findPageLinks(markdown: string): PageLink[] {
  const { body } = splitFrontmatter(markdown);
  const nodes = [...markdownNodes(parseMarkdown(body))];
  // A label defined twice goes where it was first defined, as CommonMark has it.
  const defined = new Map<string, string>();
  for (const node of nodes) {
    if (node.type === 'definition' && !defined.has(node.identifier)) {
      defined.set(node.identifier, node.url);
    }
  }
  const links: PageLink[] = [];
  for (const node of nodes) {
    const url =
      node.type === 'link'
        ? node.url
        : node.type === 'linkReference'
          ? defined.get(node.identifier)
          : undefined;
    if (url === undefined) continue;
    const [, spaceId = '', pageId = ''] = PAGE_URL.exec(url) ?? [];
    if (!spaceId) continue;
    links.push({
      source: body.slice(node.position?.start.offset, node.position?.end.offset),
      text: markdownText(node),
      spaceId,
      pageId,
    });
  }
  return links;
}

/**
 * `markdown` with each link to a page's address (`/s/<space>/p/<page>`, as
 * `findPageLinks` finds them, and the reference definitions they point
 * through) that `to` gives another page for pointing at that page instead:
 * a copy's links between its own pages (protocol section 10). Only the
 * address's path changes, so a host, a `#heading` or the link's text stay.
 * An address written with escapes is left as it is.
 */
export function rewritePageLinks(
  markdown: string,
  to: (page: { spaceId: string; pageId: string }) => { spaceId: string; pageId: string } | null,
): string {
  const { body } = splitFrontmatter(markdown);
  const offset = markdown.length - body.length;
  const edits: { at: number; length: number; text: string }[] = [];
  for (const node of markdownNodes(parseMarkdown(body))) {
    if (node.type !== 'link' && node.type !== 'definition') continue;
    const [, spaceId = '', pageId = ''] = PAGE_URL.exec(node.url) ?? [];
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (!spaceId || start === undefined || end === undefined) continue;
    const target = to({ spaceId, pageId });
    if (!target) continue;
    const path = `/s/${spaceId}/p/${pageId}`;
    // The address comes after the text, which may hold it too.
    const at = body.slice(start, end).lastIndexOf(path);
    if (at < 0) continue;
    edits.push({
      at: offset + start + at,
      length: path.length,
      text: `/s/${target.spaceId}/p/${target.pageId}`,
    });
  }
  let out = markdown;
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, edit.at) + edit.text + out.slice(edit.at + edit.length);
  }
  return out;
}

/** A page's wikilinks and links to WikiStow pages (`findWikilinks`, `findPageLinks`). */
export type FoundLinks = { wikilinks: Wikilink[]; pageLinks: PageLink[] };

/**
 * `markdown`'s wikilinks and links to WikiStow pages. Some text takes this
 * far longer than its size suggests (#47), so the web app runs it in a
 * worker it can end.
 */
export const findLinks = (markdown: string): FoundLinks => ({
  wikilinks: findWikilinks(markdown),
  pageLinks: findPageLinks(markdown),
});

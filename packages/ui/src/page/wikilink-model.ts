import {
  linkKey,
  resolveLinked,
  resolveWikilinks,
  withHeading,
  type LinkablePage,
  type MovedPage,
  type SpaceId,
  type WikilinkNode,
} from '@wikistow/client';
import { headingId } from '@wikistow/client/reader';

/**
 * How the reader shows one wikilink. Whatever the viewer can't open is
 * `text`, the same for a missing page, an unpublished one and one outside
 * their grants, so the page never tells them which. Only editors of the
 * page see `missing` and `ambiguous`, judged by their own tree.
 */
export type WikilinkView =
  | {
      kind: 'page';
      pageId: string;
      /** The space of a page a move took out of this one; else the page is in this space. */
      spaceId?: SpaceId;
      hash: string | undefined;
      text: string;
      /** The page's title, and heading, it goes to; its hint in the desktop app. */
      name: string;
    }
  | { kind: 'image' | 'file'; attachmentId: string; text: string }
  | { kind: 'missing'; title: string; text: string }
  | { kind: 'ambiguous'; text: string }
  | { kind: 'not-kept'; text: string }
  | { kind: 'text'; text: string };

/** What a link to a page this device doesn't keep says, offline. */
export const NOT_KEPT_HINT = 'This page isn’t kept on this device';

export type WikilinkScope = {
  /** The pages the viewer can open in the space, or null until known. */
  pages: readonly LinkablePage[] | null;
  /** The version's link table (`linkTableOf`): key → page ID. */
  links: ReadonlyMap<string, string>;
  selfId: string;
  /** This page's attachments, which embeds name. */
  attachments: readonly { id: string; name: string; mediaType: string }[];
  /** The viewer edits this page. */
  editor: boolean;
  /**
   * Offline, the pages of the space this device lists but keeps no version
   * of (ADR 0009, decision 4), whose titles it doesn't know.
   */
  notKept?: ReadonlySet<string> | undefined;
  /** Where the pages of entries a move took into another space went (`PageBodyContext.moved`). */
  moved?: ReadonlyMap<string, MovedPage> | undefined;
};

/**
 * Resolve `link` through the version's link table when its entry names a
 * page in the viewer's own tree, so it follows a rename; else by title
 * against the viewer's own pages. An entry for a page the viewer can't open
 * counts for nothing. A link without its own text shows the target's
 * current title. Obsidian forms WikiStow doesn't support stay as written
 * and load nothing. Offline, one whose entry names a page this device
 * doesn't keep is `not-kept`, and for an editor, so is one that names no
 * page while any aren't kept, as it may name one of them.
 */
export function wikilinkView(link: WikilinkNode, scope: WikilinkScope): WikilinkView {
  if (link.unsupported) return { kind: 'text', text: link.source };
  if (link.embed) {
    const [found] = resolveWikilinks([link], {
      pages: [],
      selfId: scope.selfId,
      attachments: scope.attachments,
    });
    const ref =
      found?.status === 'resolved'
        ? scope.attachments.find((a) => a.id === found.targets[0])
        : undefined;
    if (!ref) return { kind: 'text', text: link.source };
    return {
      kind: ref.mediaType.startsWith('image/') ? 'image' : 'file',
      attachmentId: ref.id,
      text: link.shown ?? ref.name,
    };
  }
  const written = { kind: 'text', text: link.value } as const;
  if (!scope.pages) return written;
  const [found] = resolveLinked([link], {
    pages: scope.pages,
    selfId: scope.selfId,
    table: scope.links,
  });
  const pageId = found?.status === 'resolved' ? found.targets[0] : undefined;
  if (pageId) {
    const title = scope.pages.find((page) => page.id === pageId)?.title ?? link.target;
    return {
      kind: 'page',
      pageId,
      hash: link.heading ? headingId(link.heading) : undefined,
      // A link to a heading of this page (`[[#Dates]]`) shows just the heading.
      text: link.shown ?? withHeading(link.target && title, link.heading),
      name: withHeading(title, link.heading),
    };
  }
  // A page a move took into another space, by its entry: no page here has the link's title.
  const away =
    found?.status === 'missing'
      ? scope.moved?.get(scope.links.get(linkKey(link)) ?? '')
      : undefined;
  if (away) {
    return {
      kind: 'page',
      pageId: away.pageId,
      spaceId: away.spaceId,
      hash: link.heading ? headingId(link.heading) : undefined,
      text: link.shown ?? withHeading(link.target, link.heading),
      name: withHeading(link.target, link.heading),
    };
  }
  if (scope.notKept && scope.notKept.size > 0 && found?.status !== 'ambiguous') {
    const entry = scope.links.get(linkKey(link));
    if (scope.editor || (entry !== undefined && scope.notKept.has(entry))) {
      return { kind: 'not-kept', text: written.text };
    }
  }
  if (!scope.editor) return written;
  return found?.status === 'ambiguous'
    ? { kind: 'ambiguous', text: written.text }
    : { kind: 'missing', title: link.target, text: written.text };
}

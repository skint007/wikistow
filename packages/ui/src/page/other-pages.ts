import {
  PageId,
  resolveLinked,
  SpaceId,
  type PropertyData,
  type searchOperations,
  type Wikilink,
} from '@wikistow/client';
import type { LinkScope } from './property-value';

// The page a reference to another page's value names (`` `=[[Page]].key` ``,
// ADR 0006 decision 5), as its viewer sees it: resolved as a wikilink is,
// through the version's link table, then the page as the viewer's search
// index holds it, in the version they see. A page the viewer can't open is
// never in their index, so a reader is told nothing more of a missing
// page, an unpublished one or one outside their access than of a missing
// key: each shows the reference as written.

/** What a reference's page is to its viewer. */
export type OtherPage =
  /** A page they can open, its title and properties in the version they see. */
  | { kind: 'page'; pageId: string; title: string; properties: readonly PropertyData[] }
  /** None they can open, as far as their tree and index say. */
  | { kind: 'none' };

/** The page each reference names; undefined until the viewer's index and pages are loaded. */
export type OtherPages = (page: Wikilink) => OtherPage | undefined;

/**
 * Other pages as `scope`'s viewer sees them, from `index`, their search
 * index. A reference to this page itself takes `own` if given, its
 * properties in the version shown, which the index may not hold.
 */
export function otherPages(
  index: searchOperations.PageIndex | undefined,
  scope: LinkScope,
  own?: readonly PropertyData[] | null,
): OtherPages {
  return (link) => {
    if (!index || !scope.pages) return undefined;
    const [found] = resolveLinked([link], {
      pages: scope.pages,
      selfId: scope.selfId,
      table: scope.links,
    });
    const pageId = found?.status === 'resolved' ? found.targets[0] : undefined;
    if (pageId === undefined) return { kind: 'none' };
    if (pageId === scope.selfId && own !== undefined) {
      const title = scope.pages.find((page) => page.id === pageId)?.title ?? link.target;
      return { kind: 'page', pageId, title, properties: own ?? [] };
    }
    const entry = index.page(SpaceId.parse(scope.spaceId), PageId.parse(pageId));
    return entry
      ? { kind: 'page', pageId, title: entry.title, properties: entry.properties }
      : { kind: 'none' };
  };
}

/** The hint a value shown in a page gives: which property it is, and of which other page. */
export const referenceHint = (property: PropertyData, page?: { title: string }) =>
  `${property.key} · ${page ? page.title : 'property'}`;

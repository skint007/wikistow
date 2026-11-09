import {
  linkKey,
  parseWikilink,
  type ClientContext,
  type IndexedLink,
  type LinkablePage,
  type MovedPage,
  type movedOperations,
  type pageOperations,
  type PropertyData,
  type SpaceId,
} from '@wikistow/client';
import { useQueries } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { movedQuery } from '../data/queries';

type Answer = { data?: movedOperations.MovedPlace | null | undefined };

/**
 * Where the pages of a link table's entries that aren't among the viewer's
 * pages went, when a move took them into another space and the viewer can
 * open them there: so a link from a page left behind still opens its page
 * (protocol section 10, "Old addresses"). Empty until `pages` loads.
 */
export function useMovedLinks(
  ctx: ClientContext,
  page: pageOperations.PageRef,
  pages: readonly LinkablePage[] | null,
  table: ReadonlyMap<string, string>,
): ReadonlyMap<string, MovedPage> {
  const away = useMemo(() => {
    if (pages === null) return [];
    const here = new Set(pages.map((p) => p.id));
    return [...new Set(table.values())].filter((id) => !here.has(id) && id !== page.pageId);
  }, [pages, table, page.pageId]);
  return useMovedPages(ctx, page.spaceId, away);
}

/** A row of a table of pages: its page, with its links as the index keeps them, and the values it shows. */
export type RowLinks = {
  page: { pageId: string; links: readonly IndexedLink[] };
  values: readonly (PropertyData | undefined)[];
};

/**
 * `useMovedLinks` for a table whose rows are other pages, each with its own
 * links (the folder table, a query block): where the pages its shown values
 * that are one wikilink name went, by each row's entry for it. One lookup
 * for the whole table, so a page many rows link to is asked about once.
 */
export function useMovedRows(
  ctx: ClientContext,
  spaceId: SpaceId,
  pages: readonly LinkablePage[] | null,
  rows: readonly RowLinks[],
): ReadonlyMap<string, MovedPage> {
  const away = useMemo(() => {
    if (pages === null) return [];
    const here = new Set(pages.map((p) => p.id));
    const ids = new Set<string>();
    for (const { page, values } of rows) {
      for (const property of values) {
        if (property?.type !== 'wikilink') continue;
        const link = parseWikilink(String(property.value));
        const key = link && linkKey(link);
        const id = key ? page.links.find((each) => each.key === key)?.pageId : null;
        if (id && id !== page.pageId && !here.has(id)) ids.add(id);
      }
    }
    return [...ids];
  }, [pages, rows]);
  return useMovedPages(ctx, spaceId, away);
}

/** A row's links as a link table, key → page ID (`LinkScope.links`). */
export const rowTable = (links: readonly IndexedLink[]): ReadonlyMap<string, string> =>
  new Map(links.flatMap(({ key, pageId }) => (pageId === null ? [] : [[key, pageId] as const])));

/** Where each of `away`, old page IDs in `spaceId`, went: those a move took into another space. */
function useMovedPages(
  ctx: ClientContext,
  spaceId: SpaceId,
  away: readonly string[],
): ReadonlyMap<string, MovedPage> {
  // Only a new answer makes a new map, so nothing is drawn again for nothing.
  const combine = useCallback(
    (answers: readonly Answer[]) => {
      const map = new Map<string, MovedPage>();
      away.forEach((id, i) => {
        const place = answers[i]?.data;
        if (place?.kind === 'page') map.set(id, { spaceId: place.spaceId, pageId: place.nodeId });
      });
      return map;
    },
    [away],
  );
  return useQueries({
    queries: away.map((nodeId) => ({
      ...movedQuery(ctx, { spaceId, nodeId }),
      // Moves are rare: a page shown again doesn't ask again at once.
      staleTime: 5 * 60_000,
    })),
    combine,
  });
}

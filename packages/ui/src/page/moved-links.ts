import type {
  ClientContext,
  LinkablePage,
  MovedPage,
  movedOperations,
  pageOperations,
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
      ...movedQuery(ctx, { spaceId: page.spaceId, nodeId }),
      // Moves are rare: a page shown again doesn't ask again at once.
      staleTime: 5 * 60_000,
    })),
    combine,
  });
}

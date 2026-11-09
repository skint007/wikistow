import { commentOperations, type ClientContext, type PageId, type Region } from '@wikistow/client';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { treeQuery } from '../data/queries';
import { PLAIN } from '../vault/store';

const regionKey = (region: Region) => (region.kind === 'owner' ? 'owner' : region.shareId);

/**
 * A page's threads, opened against the region of the version on screen
 * (ADR 0014, decision 4): another region opens them afresh. Nothing is
 * asked until that version has opened (`region` null), nor offline:
 * comments need the connection (decision 9).
 */
export const pageCommentsQuery = (
  ctx: ClientContext,
  {
    spaceId,
    pageId,
    region,
    version,
  }: Omit<commentOperations.CommentPage, 'region'> & { region: Region | null },
  { offline = false }: { offline?: boolean } = {},
) =>
  queryOptions({
    queryKey: [PLAIN, 'comments', pageId, region && regionKey(region)],
    queryFn: () => {
      if (!region) throw new Error('The page is still opening');
      return commentOperations.pageComments(ctx, { spaceId, pageId, region, version });
    },
    enabled: region !== null && !offline,
    networkMode: 'online',
  });

/** New comments (decision 8), each page's title from the tree the sidebar shows. */
export const newCommentsQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'new-comments'],
    queryFn: ({ client }) =>
      commentOperations.newComments(ctx, (spaceId) =>
        client.ensureQueryData(treeQuery(ctx, spaceId)),
      ),
    networkMode: 'online',
  });

/** Comments changed on these pages, or anywhere: what shows them loads again. */
export function commentsChanged(queryClient: QueryClient, pageIds?: readonly PageId[]) {
  void queryClient.invalidateQueries({ queryKey: [PLAIN, 'new-comments'] });
  if (!pageIds) {
    void queryClient.invalidateQueries({ queryKey: [PLAIN, 'comments'] });
    return;
  }
  for (const pageId of pageIds) {
    void queryClient.invalidateQueries({ queryKey: [PLAIN, 'comments', pageId] });
  }
}

import { watchTreeChanges, type ClientContext, type SpaceId } from '@wikistow/client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { PLAIN } from '../vault/store';
import {
  publicLinksQuery,
  searchIndexChanged,
  searchIndexQuery,
  sharedWithMeQuery,
  spacesQuery,
  treeQuery,
} from './queries';

/**
 * While the vault is open (`ctx`), load a space's tree again when the
 * server says it changed: pages an agent adds, edits from another device
 * or from someone the space is shared with. The spaces and shares listed
 * load again too, for a space renamed, deleted or newly shared, and so do
 * the space's public links, which turning one on or off tells of, and the
 * search index, which rebuilds now only if something shows it. The page
 * that is open stays as it is. A tab out of view stops listening, so
 * a dozen tabs don't hold a dozen connections, and its trees load again
 * when it is back in view, as every query does (`refetchOnWindowFocus`).
 */
export function useTreeChanges(ctx: ClientContext | null) {
  const queryClient = useQueryClient();
  const visible = useSyncExternalStore(onVisibility, () => document.visibilityState === 'visible');
  // Whether the index was being built when listening stopped.
  const building = useRef(false);
  useEffect(() => {
    if (!ctx || !visible) return;
    // Trees load again when the tab is back in view, being stale at once;
    // the index, fresh for a minute, is told of what it may have missed.
    // A build running now started for that, as the window was focused,
    // unless it was already running when listening stopped: then it may
    // have read a space before a change, so another follows it.
    searchIndexChanged(queryClient, { following: building.current });
    const stop = new AbortController();
    const reloadLists = () => {
      void queryClient.invalidateQueries({ queryKey: spacesQuery(ctx).queryKey });
      void queryClient.invalidateQueries({ queryKey: sharedWithMeQuery(ctx).queryKey });
    };
    void watchTreeChanges({
      signal: stop.signal,
      onChange: (spaceIds) => {
        for (const spaceId of spaceIds) {
          void reloadTree(queryClient, ctx, spaceId);
          void queryClient.invalidateQueries({ queryKey: publicLinksQuery(ctx, spaceId).queryKey });
        }
        reloadLists();
        searchIndexChanged(queryClient);
      },
      onMissed: () => {
        void queryClient.invalidateQueries({ queryKey: [PLAIN, 'tree'] });
        void queryClient.invalidateQueries({ queryKey: [PLAIN, 'public-links'] });
        reloadLists();
        searchIndexChanged(queryClient);
      },
    });
    return () => {
      stop.abort();
      const { queryKey } = searchIndexQuery(ctx, queryClient);
      building.current = queryClient.isFetching({ queryKey }) > 0;
    };
  }, [ctx, visible, queryClient]);
}

function onVisibility(changed: () => void) {
  document.addEventListener('visibilitychange', changed);
  return () => document.removeEventListener('visibilitychange', changed);
}

// A load already running may have started before the change, so another
// follows it. Changes heard meanwhile share that one, rather than each
// cancelling the load before it, which a steady stream of changes would do
// forever on a large tree.
async function reloadTree(queryClient: QueryClient, ctx: ClientContext, spaceId: SpaceId) {
  const { queryKey } = treeQuery(ctx, spaceId);
  const running = queryClient.isFetching({ queryKey }) > 0;
  await queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
  if (running) await queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
}

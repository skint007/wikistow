import { watchTreeChanges, type ClientContext } from '@wikistow/client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { PLAIN } from '../vault/store';
import { useOffline } from './connection';
import { contentChanged } from './content-changed';
import { keepChanged } from './keeper';
import { publicLinksQuery, searchIndexChanged, sharedWithMeQuery, spacesQuery } from './queries';

/**
 * While the vault is open (`ctx`), load a space's tree again when the
 * server says it changed: pages an agent adds, edits from another device
 * or from someone the space is shared with. The spaces and shares listed
 * load again too, for a space renamed, deleted or newly shared, and so do
 * the space's public links, which turning one on or off tells of, and the
 * search index, which lists those spaces again now only if something shows
 * it, and the pages kept for offline (`keepChanged`), which follow those
 * spaces, or every space when unlocked or back in view. The page that is
 * open stays as it is. A tab out of view stops
 * listening, so a dozen tabs don't hold a dozen connections, and its trees
 * load again when it is back in view, as every query does
 * (`refetchOnWindowFocus`); the index, which doesn't, then lists every
 * space again, once. Offline it stops listening too, and what is shown reads
 * what's kept at once; back online
 * (ADR 0009, decision 4) it starts again as when back in view, after what's
 * shown loads again (`refetchOnReconnect`).
 */
export function useTreeChanges(ctx: ClientContext | null) {
  const queryClient = useQueryClient();
  const visible = useSyncExternalStore(onVisibility, () => document.visibilityState === 'visible');
  const offline = useOffline();
  useEffect(() => {
    if (!ctx) return;
    // Gone offline: the trees and lists shown read what's kept at once, so
    // the sidebar shows the kept pages only (ADR 0009, decision 4).
    if (offline) {
      void queryClient.invalidateQueries({ queryKey: [PLAIN, 'tree'] });
      void queryClient.invalidateQueries({ queryKey: spacesQuery(ctx).queryKey });
      void queryClient.invalidateQueries({ queryKey: sharedWithMeQuery(ctx).queryKey });
      // The index too, which then holds the kept pages only.
      searchIndexChanged(queryClient);
      return;
    }
    if (!visible) return;
    // Trees load again when the tab is back in view, being stale at once;
    // the index is told it may have missed changes anywhere.
    searchIndexChanged(queryClient);
    keepChanged(ctx);
    const stop = new AbortController();
    const reloadLists = () => {
      void queryClient.invalidateQueries({ queryKey: spacesQuery(ctx).queryKey });
      void queryClient.invalidateQueries({ queryKey: sharedWithMeQuery(ctx).queryKey });
    };
    void watchTreeChanges({
      signal: stop.signal,
      onChange: (spaceIds) => {
        void contentChanged(
          queryClient,
          ctx,
          spaceIds.map((spaceId) => ({ spaceId })),
        );
        for (const spaceId of spaceIds) {
          void queryClient.invalidateQueries({ queryKey: publicLinksQuery(ctx, spaceId).queryKey });
        }
        reloadLists();
        keepChanged(ctx, { spaces: spaceIds });
      },
      onMissed: () => {
        void queryClient.invalidateQueries({ queryKey: [PLAIN, 'tree'] });
        void queryClient.invalidateQueries({ queryKey: [PLAIN, 'public-links'] });
        reloadLists();
        searchIndexChanged(queryClient);
        keepChanged(ctx);
      },
    });
    return () => stop.abort();
  }, [ctx, visible, offline, queryClient]);
}

function onVisibility(changed: () => void) {
  document.addEventListener('visibilitychange', changed);
  return () => document.removeEventListener('visibilitychange', changed);
}

import { watchCommentChanges, type ClientContext } from '@wikistow/client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { useOffline } from '../data/connection';
import { commentsChanged } from './queries';

/**
 * While the vault is open (`ctx`), load a page's comments and New comments
 * again when the server says a comment changed there (ADR 0014, decision
 * 8), from a stream of its own beside the tree's. Like the tree's, it
 * listens only while the tab is in view and online, and after a gap loads
 * every page's comments again.
 */
export function useCommentChanges(ctx: ClientContext | null) {
  const queryClient = useQueryClient();
  const visible = useSyncExternalStore(onVisibility, () => document.visibilityState === 'visible');
  const offline = useOffline();
  useEffect(() => {
    if (!ctx || offline || !visible) return;
    // Back in view or online: anything may have changed meanwhile.
    commentsChanged(queryClient);
    const stop = new AbortController();
    void watchCommentChanges({
      signal: stop.signal,
      onChange: (pageIds) => commentsChanged(queryClient, pageIds),
      onMissed: () => commentsChanged(queryClient),
    });
    return () => stop.abort();
  }, [ctx, visible, offline, queryClient]);
}

function onVisibility(changed: () => void) {
  document.addEventListener('visibilitychange', changed);
  return () => document.removeEventListener('visibilitychange', changed);
}

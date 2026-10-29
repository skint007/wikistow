import {
  pageOperations,
  revisePayload,
  RevisionId,
  type ClientContext,
  type PagePayload,
  type Region,
} from '@wikistow/client';
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { createContext, useCallback, useEffect, useMemo } from 'react';
import {
  pageQuery,
  publicLinksQuery,
  revisionQuery,
  searchIndexChanged,
  treeQuery,
} from '../data/queries';
import { vaultStore } from '../vault/store';
import { readWikilinks } from './page-reader';
import {
  flushChanges,
  flushesUnderway,
  holding,
  inTurn,
  leftOutcome,
  notePublished,
  readingNotices,
  ReadingQueue,
  showing,
  type Flushed,
  type FlushOperations,
  type ReadingChange,
  type ReadingRights,
  type ReadingState,
} from './reading-changes-model';

export type { ReadingChange, ReadingRights };

/**
 * What the published view's body needs to change the page while it's read
 * (`ReadingQueue`): its Markdown as shown, every queued change made in it;
 * whether this person may change it, or why not; and the queue's `change`.
 * Null where nothing may change, as in a publish preview.
 */
export type ReadingChangesHere = {
  markdown: string;
  rights: ReadingRights;
  change: (change: ReadingChange) => void;
};

export const ReadingChanges = createContext<ReadingChangesHere | null>(null);

// A flush outlives the page it was made on: leaving starts one, and its
// queue's guards go with the page. So closing the app or locking the vault
// waits for every page's, the pages left included.
vaultStore.guardLock(async () => {
  await flushesUnderway();
  return true;
});
window.addEventListener('beforeunload', (event) => {
  if (flushesUnderway() === null) return;
  event.preventDefault();
  // Older browsers ask only when this is set.
  event.returnValue = '';
});

/**
 * The queue of changes made while reading `page`, kept across the
 * publications it makes. A flush, in turn with the page's others
 * (`inTurn`), saves them through the page's operations (`flushChanges`),
 * then shows the new version as publishing from the draft does: the search
 * index told, and the page and tree loaded again, the new publication
 * opened first so it shows at once. However it went, the page is loaded
 * again, so who may change it is worked out afresh. Leaving the page, for
 * another page or another app, saves what waits at once; closing or
 * reloading it with changes waiting asks first, as the browser lets it,
 * and so does locking the vault if they can't be saved.
 */
export function useReadingQueue(ctx: ClientContext, page: pageOperations.PageRef): ReadingQueue {
  const queryClient = useQueryClient();
  const { spaceId, pageId } = page;
  const { queue, shownHere } = useMemo(() => {
    const page = { spaceId, pageId };
    // Once the page is left, how its flushes went is told to the page when it shows again.
    let left = false;
    // The drafts a flush opened, by revision, for saving on top of one.
    const opened = new Map<string, { payload: PagePayload; region: Region }>();
    let published: RevisionId | null = null;
    const operations: FlushOperations = {
      heads: async () => (await pageOperations.loadPage(ctx, pageId)).heads,
      openDraft: async (revisionId) => {
        const draft = await pageOperations.openRevisionOf(
          ctx,
          page,
          'draft',
          RevisionId.parse(revisionId),
          { fresh: true },
        );
        const payload = revisePayload(draft.opened, {});
        opened.set(revisionId, { payload, region: draft.region });
        return payload.markdown;
      },
      saveDraft: async (basedOn, markdown) => {
        const draft = opened.get(basedOn);
        if (!draft) throw new Error('That draft wasn’t opened here');
        const written = await pageOperations.saveDraft(ctx, {
          page,
          basedOn: RevisionId.parse(basedOn),
          basedOnRegion: draft.region,
          payload: { ...draft.payload, markdown },
          read: readWikilinks,
        });
        return written.revisionId;
      },
      publish: async ({ draftHead, publishedHead }) => {
        const written = await pageOperations.publishPage(ctx, page, {
          expected: {
            draftHead: RevisionId.parse(draftHead),
            publishedHead: publishedHead === null ? null : RevisionId.parse(publishedHead),
          },
          read: readWikilinks,
        });
        published = written.revisionId;
        // Before the page loads again, so the view reading it stays (`originOf`).
        notePublished(pageId, written.revisionId, publishedHead);
        return written.revisionId;
      },
      publicLink: async () =>
        (await queryClient.fetchQuery({ ...publicLinksQuery(ctx, spaceId), staleTime: 0 })).some(
          (link) => link.pageId === pageId,
        ),
    };
    // Loaded again whether or not anything shows it: a page left before its
    // flush settled may next open straight to its draft, which mustn't open
    // on the heads from before the flush, and then find its own save as
    // someone else's. The page's flushes settle only once this is done, so
    // the draft waits for it (`pageFlushing`).
    const reload = () =>
      queryClient.invalidateQueries({
        queryKey: pageQuery(ctx, pageId).queryKey,
        refetchType: 'all',
      });
    const flush = async (changes: readonly ReadingChange[]) => {
      published = null;
      opened.clear();
      let flushed: Flushed;
      try {
        flushed = await flushChanges(operations, changes);
      } catch (error) {
        await reload();
        throw error;
      } finally {
        opened.clear();
      }
      if (flushed.outcome === 'unchanged') {
        await reload();
        return flushed;
      }
      if (published)
        await queryClient.prefetchQuery(revisionQuery(ctx, page, 'published', published));
      searchIndexChanged(queryClient);
      await Promise.all([
        reload(),
        queryClient.invalidateQueries({
          queryKey: treeQuery(ctx, spaceId).queryKey,
          refetchType: 'all',
        }),
      ]);
      return flushed;
    };
    const queue = new ReadingQueue((changes) =>
      inTurn(pageId, () => flush(changes)).then(
        (last) => {
          if (left) leftOutcome(pageId, { last, error: null });
          return last;
        },
        (error: unknown) => {
          if (left) leftOutcome(pageId, { last: null, error });
          throw error;
        },
      ),
    );
    return {
      queue,
      shownHere: (shown: boolean) => {
        left = !shown;
      },
    };
  }, [ctx, queryClient, spaceId, pageId]);
  useEffect(() => {
    shownHere(true);
    const shown = showing(pageId, queue);
    return () => {
      shown();
      shownHere(false);
    };
  }, [pageId, queue, shownHere]);
  useEffect(() => {
    // Held until every batch it chains is done, as the page's guards go with it.
    const leave = () => void holding(queue.flush());
    const hidden = () => {
      if (document.visibilityState === 'hidden') leave();
    };
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hidden);
      leave();
    };
  }, [queue]);

  // Locking saves what waits first, and asks if it can't be saved.
  useEffect(
    () =>
      vaultStore.guardLock(async (ask) => {
        await queue.flush();
        return (
          !queue.busy() ||
          ask('Your latest changes to this page are not saved. Lock anyway and lose them?')
        );
      }),
    [queue],
  );
  // Closing or reloading can't wait for a flush, so the browser asks while one waits or runs.
  const shouldBlockFn = useCallback(() => false, []);
  const enableBeforeUnload = useCallback(() => queue.busy(), [queue]);
  useBlocker({ shouldBlockFn, enableBeforeUnload });
  return queue;
}

/** The queue's notices, said as they change, in the page's quiet note style. */
export function ReadingNotices({ state }: { state: ReadingState }) {
  const notices = readingNotices(state);
  return (
    <div role="status" className="grid gap-1 text-sm text-muted-foreground empty:hidden">
      {notices.map((notice) => (
        <p key={notice}>{notice}</p>
      ))}
    </div>
  );
}

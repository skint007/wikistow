import {
  pageOperations,
  revisePayload,
  RevisionId,
  summarizeChange,
  type ClientContext,
  type PagePayload,
  type Region,
} from '@wikistow/client';
import { connection, useOffline } from '../data/connection';
import { queueQuery } from '../data/offline-changes';
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { createContext, useCallback, useEffect, useMemo, useRef } from 'react';
import { contentChanged } from '../data/content-changed';
import { pageQuery, publicLinksQuery, revisionQuery } from '../data/queries';
import { vaultStore } from '../vault/store';
import { readWikilinks } from './page-reader';
import {
  applyChanges,
  flushChanges,
  onlyTicked,
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
  type MadeOn,
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

/** Why a change made before another tab or window changed the page is left out (#700). */
const CHANGED_ELSEWHERE = 'The page was changed in another tab or window meanwhile.';

export const ReadingChanges = createContext<ReadingChangesHere | null>(null);

// A flush outlives the page it was made on: leaving starts one, and its
// queue's guards go with the page. So closing the app or locking the vault
// waits for every page's, the pages left included.
// For each page, the versions of its draft entry this tab's own reading
// saves and Undo made, by the one each replaced (null for none), and the
// publications its own online flushes made: so a change made on what this
// tab had before it heard of its own save, in this visit to the page or
// one before, still goes on top of it (#700).
const ownSaves = new Map<string, Map<number | null, number | null>>();
const ownPublications = new Map<string, Map<string | null, string | null>>();

function ownMoves<T>(all: Map<string, Map<T | null, T | null>>, pageId: string) {
  let moves = all.get(pageId);
  if (!moves) all.set(pageId, (moves = new Map()));
  return moves;
}

/** Whether `from`, as a change was made on it, is `to` now, or became it only through `own`. */
function reaches<T>(own: Map<T | null, T | null>, from: T | null, to: T | null) {
  const seen = new Set<T | null>();
  for (let at = from; !seen.has(at); at = own.get(at) ?? null) {
    if (at === to) return true;
    seen.add(at);
    if (!own.has(at)) return false;
  }
  return false;
}

/** The page's draft entry at `version` was dropped by the person here, as by Undo. */
export function noteUndone(pageId: string, version: number) {
  ownMoves(ownSaves, pageId).set(version, null);
}

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
export function useReadingQueue(
  ctx: ClientContext,
  page: pageOperations.PageRef,
  title: string,
): ReadingQueue {
  const queryClient = useQueryClient();
  const named = useRef(title);
  named.current = title;
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
      publish: async ({ draftHead, publishedHead }, change) => {
        const written = await pageOperations.publishPage(ctx, page, {
          expected: {
            draftHead: RevisionId.parse(draftHead),
            publishedHead: publishedHead === null ? null : RevisionId.parse(publishedHead),
          },
          read: readWikilinks,
          change,
        });
        published = written.revisionId;
        ownPublished.set(publishedHead, written.revisionId);
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
    // Offline, or while a change to the page waits on this device, they go
    // there as an ordinary offline draft of the page and its publish (#695):
    // made in the page's change waiting, or else the draft this device kept,
    // saved there, and published as just saved, over the publication they
    // were made on, a publish again taking the place of one waiting. A draft
    // with anything else in it takes them unpublished, as online, and so do
    // values set by plugin blocks, which change what a draft holds besides
    // its tasks. Sent with the rest, someone's edit meanwhile comes back as
    // the usual conflict, which Merge… settles.
    const mine = ownMoves(ownSaves, pageId);
    const ownPublished = ownMoves(ownPublications, pageId);
    const onDevice = async (
      changes: readonly ReadingChange[],
      on: readonly (MadeOn | null)[],
    ): Promise<Flushed | null> => {
      const queue = ctx.keptContent?.queue;
      if (!queue) return null;
      if (connection.get().online && (await queue.waiting(pageId)).length === 0) return null;
      const info = queryClient.getQueryData(pageQuery(ctx, pageId).queryKey);
      const waiting = await queue.waiting(pageId);
      const entry = waiting.find((each) => each.kind === 'page');
      const change = entry?.kind === 'page' && entry.basedOn ? entry : null;
      const found = waiting.find((each) => each.kind === 'publish');
      const publish = found?.kind === 'publish' ? found : null;
      // Only as the page allowed them (`ticksOnly`): its draft and the publish
      // its ticks queued, or nothing, waiting; never the kept draft behind a
      // change already on its way, which would leave out what it holds
      // (#695), nor a draft the person published themselves (#700).
      const others = waiting.filter((each) => each !== entry && each !== publish);
      // Its publish of the draft as it is: one saved over since, as from the
      // draft view, would publish the version before.
      const stalePublish =
        publish && (!publish.publishedOn || publish.draft?.version !== change?.version);
      if (others.length > 0 || (publish && !change) || stalePublish || change?.failure) {
        throw new Error('Waits until your change made offline is sent');
      }
      // Over the publication the first of them was ticked on, not one their own publish made.
      const publishedOn = publish?.publishedOn ?? info?.heads.publishedHead;
      const head = change?.basedOn ?? info?.heads.draftHead;
      if (!head || !publishedOn) throw new Error('This page has no publication to change.');
      // Each only where it was made: on this draft as it is now, or as this
      // queue's own saves left it, and on this publication (#700). One made
      // before another tab changed the draft may have been made on a task
      // that has moved.
      const version = change?.version ?? null;
      const madeHere = (index: number) => {
        const made = on[index];
        return (
          !made ||
          (reaches(mine, made.version, version) &&
            reaches(ownPublished, made.publishedOn, publishedOn))
        );
      };
      // Those after a property left out were made in text that held it, its
      // frontmatter longer or shorter: left out too, as their places moved
      // with it. A tick moves nothing.
      const kept: ReadingChange[] = [];
      const moved: ReadingChange[] = [];
      let cut = false;
      changes.forEach((made, index) => {
        const here = !cut && madeHere(index);
        (here ? kept : moved).push(made);
        if (!here && made.kind === 'property') cut = true;
      });
      const left = moved.map((made) => ({ change: made, reason: CHANGED_ELSEWHERE }));
      if (kept.length === 0) return { outcome: 'unchanged', dropped: left };
      const draft = await pageOperations.openRevisionOf(ctx, page, 'draft', head);
      const based = revisePayload(draft.opened, {});
      const now = change?.payload ?? based;
      const made = applyChanges(now.markdown, kept);
      const dropped = [...left, ...made.dropped];
      const ticked = { ...now, markdown: made.markdown };
      // Back as the draft was: what waits goes, as nothing is left to publish,
      // unless it is on its way, when it may have landed already.
      const sending = change?.sending || publish?.sending;
      if (
        change &&
        publish &&
        !sending &&
        made.markdown === based.markdown &&
        onlyTicked(based, ticked)
      ) {
        await queue.undoTicked(page, change.version);
        mine.set(change.version, null);
        await queryClient.refetchQueries({ queryKey: queueQuery(ctx).queryKey });
        return { outcome: 'unchanged', dropped };
      }
      if (made.markdown === now.markdown) return { outcome: 'unchanged', dropped };
      const clean =
        (change
          ? !change.sending && onlyTicked(based, change.payload)
          : !info?.heads.draftChanges) && kept.every((each) => each.kind === 'task');
      // Saved and published at once, so another tab can't type in between (#700).
      const saved = await queue.saveTicked(
        {
          page,
          basedOn: head,
          region: change?.region ?? draft.region,
          payload: ticked,
          seen: version,
        },
        clean
          ? {
              page,
              title: named.current,
              draftHead: head,
              publishedOn,
              // Said in history as a flush online says it (ADR 0008).
              change: summarizeChange(based.markdown, made.markdown),
            }
          : null,
      );
      mine.set(version, saved);
      // Shown from the queue before they leave this one, as the draft opens from it.
      await queryClient.refetchQueries({ queryKey: queueQuery(ctx).queryKey });
      return { outcome: clean ? 'on-device' : 'in-draft', dropped };
    };
    const flush = async (changes: readonly ReadingChange[], on: readonly (MadeOn | null)[]) => {
      const device = await onDevice(changes, on);
      if (device) return device;
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
      await contentChanged(queryClient, ctx, { spaceId, pageId }, { unshown: true });
      return flushed;
    };
    const queue = new ReadingQueue((changes, on) =>
      inTurn(pageId, () => flush(changes, on)).then(
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
    // `named` is read as each flush starts, so a rename doesn't make a new queue.
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
  const notices = readingNotices(state, useOffline());
  return (
    <div role="status" className="grid gap-1 text-sm text-muted-foreground empty:hidden">
      {notices.map((notice) => (
        <p key={notice}>{notice}</p>
      ))}
    </div>
  );
}

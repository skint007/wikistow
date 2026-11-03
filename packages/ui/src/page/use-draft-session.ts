import {
  draftLinkTargets,
  newId,
  OWNER_REGION,
  pageOperations,
  RevisionId,
  type ClientContext,
  type PageId,
  type PagePayload,
  type Region,
} from '@wikistow/client';
import { ApiError, noAnswer } from '@wikistow/client/api';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { attachFile, onSent, queueOf, savesOnDevice } from '../data/offline-changes';
import { pageQuery, searchIndexChanged, treeQuery } from '../data/queries';
import { vaultStore } from '../vault/store';
import { pluginRuntime } from '../plugins/runtime';
import { DraftSession, type DraftPorts } from './draft-session';
import type { EditorSurfaceHandle } from './editor/surface';
import { readOpeningLinks, readWikilinks } from './page-reader';

/**
 * A `DraftSession` for the draft on screen, and what it shows. Locking the
 * vault or leaving the page saves first, and asks before losing anything.
 */
export function useDraftSession({
  ctx,
  page,
  base,
  head,
  payload,
  region,
  queued,
  surface,
}: {
  ctx: ClientContext;
  page: pageOperations.PageRef;
  /** The draft revision `payload` came from. */
  base: RevisionId;
  /** The page's draft head as last loaded, to notice saves made elsewhere. */
  head: RevisionId | null;
  payload: PagePayload;
  /** The region `payload` was opened in, which its link table was worked out for. */
  region: Region;
  /**
   * The change waiting on this device that `payload` is, if any (ADR 0009,
   * decision 7): its version, the draft someone else saved since, when it
   * came back as a conflict, and the ID it is being sent under, if any,
   * which is this session's own.
   */
  queued?: Queued | null;
  surface: { readonly current: EditorSurfaceHandle | null };
}) {
  const queryClient = useQueryClient();
  const [{ session, device }] = useState(() => {
    const device = { otherWindow: false };
    const session = new DraftSession(
      { base, payload, region, theirs: queued?.theirs ?? null },
      appPorts(ctx, page, queryClient, queued?.version ?? null, device),
      surface,
    );
    if (queued?.sending) session.own(queued.sending);
    return { session, device };
  });
  const snapshot = useSyncExternalStore(session.subscribe, session.snapshot);

  useEffect(() => {
    session.open();
    openDrafts.set(page.pageId, session);
    // What this device's queue sends of the page is this session's own.
    const stop = onSent((sent) => {
      if (sent.pageId !== page.pageId) return;
      if (sent.kind === 'recorded') session.own(sent.revisionId);
      else session.landed(sent.revisionId);
    });
    return () => {
      stop();
      if (openDrafts.get(page.pageId) === session) openDrafts.delete(page.pageId);
      session.close();
    };
  }, [session, page.pageId]);

  // Locking (or signing out) saves what's typed first, and asks if it can't.
  // A file still uploading may take long or never finish, so the lock asks
  // instead of waiting for it; the file is left out if the person goes on.
  // An idle lock's `ask` always says no, so it never loses either.
  useEffect(
    () =>
      vaultStore.guardLock(async (ask) => {
        if (
          session.isUploading() &&
          !ask('A file is still uploading to this page. Lock anyway and leave it out?')
        )
          return false;
        await session.flushSaves();
        return (
          !session.hasUnsaved() ||
          ask('Your latest changes to this page are not saved. Lock anyway and lose them?')
        );
      }),
    [session],
  );

  // Leaving the page saves first too. Text that still can't be saved (a
  // conflict, or no connection) is only left behind if the person says so.
  // Closing or reloading the tab can't wait for a save, so the browser asks
  // whenever anything is unsaved, including the moment before autosave, a
  // save still waiting for its answer, and a file still uploading.
  const shouldBlockFn = useCallback(async () => {
    // A lock already saved or asked; the vault's pages are closing.
    if (vaultStore.get().status !== 'unlocked') return false;
    await session.flush();
    return (
      session.hasUnsaved() &&
      !window.confirm('Your latest changes to this page are not saved. Leave anyway and lose them?')
    );
  }, [session]);
  const enableBeforeUnload = useCallback(() => session.hasUnsaved() || session.isBusy(), [session]);
  useBlocker({ shouldBlockFn, enableBeforeUnload });

  // A draft head this session didn't make means someone else saved. A save
  // in flight may already be the head, so look again once it's answered.
  useEffect(() => session.noticeHead(head), [session, head, snapshot.status]);

  /**
   * Whether the conflict on screen is with a change another tab or window
   * saved into this device's queue: then theirs is that change, which
   * Discard mine keeps.
   */
  const conflictWithDevice = useCallback(() => device.otherWindow, [device]);

  return { session, snapshot, conflictWithDevice };
}

/** The change waiting on this device that a draft view opens with (`useDraftSession`). */
export type Queued = { version: number; theirs: RevisionId | null; sending: RevisionId | null };

// The draft on screen for each page, for work from outside the editor.
const openDrafts = new Map<PageId, DraftSession>();

/**
 * Before someone else's change to `pageId` (the page chat's agent): save
 * what the person typed there first, so it lands before the change and the
 * change, based on an older draft, is refused as stale rather than written
 * over it. Answers why it can't go ahead if their edit still can't be
 * saved, such as a conflict they haven't resolved; null otherwise.
 */
export async function saveOpenDraft(pageId: PageId): Promise<string | null> {
  const session = openDrafts.get(pageId);
  if (!session) return null;
  await session.flush().catch(() => {});
  return session.hasUnsaved()
    ? 'Your own edit to this page isn’t saved yet. Save it or resolve it in the editor first.'
    : null;
}

/**
 * A save into this device's queue (ADR 0009, decision 7) as the session
 * takes it: on the draft it was based on, as typed, its links worked out
 * once it is sent.
 */
const onDevice = (input: Parameters<DraftPorts['saveDraft']>[0]): pageOperations.Written => ({
  revisionId: input.basedOn,
  repaired: false,
  region: input.basedOnRegion ?? input.tableRegion ?? OWNER_REGION,
  payload: input.payload,
  inUse: input.payload,
  renamed: [],
  linksKept: true,
});

function appPorts(
  ctx: ClientContext,
  page: pageOperations.PageRef,
  queryClient: QueryClient,
  /** The version of the page's queued change this session last saw, if it has one. */
  queuedVersion: number | null,
  /** Set while a conflict is with a change another window saved here. */
  device: { otherWindow: boolean },
): DraftPorts {
  const tree = treeQuery(ctx, page.spaceId);
  const info = pageQuery(ctx, page.pageId);
  const queue = queueOf(ctx);
  // An entry gone since, when its change was sent, is made afresh by the next save into it.
  let seen = queuedVersion;
  return {
    // Offline, or while the page has a change waiting, saves go into the
    // queue, online too, until it is sent. A save that gets no answer is
    // kept there under the ID it was sent with, to be sent again.
    async saveDraft(input) {
      if (queue && (await savesOnDevice(ctx, page.pageId))) {
        try {
          seen = await queue.saveDraft({
            page,
            basedOn: input.basedOn,
            region: input.tableRegion ?? input.basedOnRegion ?? null,
            payload: input.payload,
            seen,
            ...(input.linkChoices && { linkChoices: input.linkChoices }),
          });
        } catch (error) {
          device.otherWindow = error instanceof ApiError && error.code === 'stale-head';
          throw error;
        }
        return onDevice(input);
      }
      const revisionId = newId(RevisionId);
      try {
        // Files added while the page's changes went into the queue are there
        // only: they go up first.
        await queue?.upload(ctx, page, input.payload.attachments);
        const written = await pageOperations.saveDraft(ctx, {
          page,
          read: readWikilinks,
          ...input,
          revisionId,
        });
        void queue?.sent(input.payload.attachments).catch(() => {});
        return written;
      } catch (error) {
        if (!queue || !noAnswer(error)) throw error;
        seen = await queue.lost({
          page,
          basedOn: input.basedOn,
          region: input.tableRegion ?? input.basedOnRegion ?? null,
          payload: input.payload,
          revisionId,
          ...(input.linkChoices && { linkChoices: input.linkChoices }),
        });
        return onDevice(input);
      }
    },
    readLinks: readOpeningLinks,
    // Offline, or with a change waiting, as for a page not made yet, a file
    // is sealed for the draft now and kept with the change until it is sent.
    uploadAttachment: (file) => attachFile(ctx, page, file),
    // After a conflict with a change another window saved, this one's goes on top of it.
    async draftHead() {
      device.otherWindow = false;
      const entry = await queue?.entry(page.pageId);
      if (entry?.kind === 'page' && !entry.failure) {
        seen = entry.version;
        return entry.basedOn ?? entry.newPage?.revisionId ?? null;
      }
      return (await queryClient.fetchQuery({ ...info, staleTime: 0 })).heads.draftHead;
    },
    generation: () => ctx.revisions.generation,
    epoch: vaultStore.epoch,
    tree: () => queryClient.getQueryData(tree.queryKey),
    linkTargets(title) {
      const loaded = queryClient.getQueryData(tree.queryKey);
      return loaded ? draftLinkTargets(loaded, { id: page.pageId }, title) : null;
    },
    async saved({ revisionId, basedOn, payload, written, region, epoch }) {
      pluginRuntime.editorSaved(page, revisionId);
      // A tree fetched before this save would land on the patch with the old title.
      const overtaken = queryClient.isFetching({ queryKey: tree.queryKey }) > 0;
      if (overtaken) await queryClient.cancelQueries({ queryKey: tree.queryKey });
      let changedStatus = false;
      queryClient.setQueryData(tree.queryKey, (loaded) => {
        if (!loaded) return loaded;
        return {
          ...loaded,
          pages: loaded.pages.map((entry) => {
            if (entry.id !== page.pageId) return entry;
            changedStatus = !entry.draftChanges;
            // Its label, region included, is now the version just saved.
            return {
              ...entry,
              title: payload.title,
              ...pageOperations.labelCover(payload, 'draft'),
              region,
              draftHead: revisionId,
              draftChanges: true,
            };
          }),
        };
      });
      searchIndexChanged(queryClient, {
        saved: { ...page, basedOn, revisionId, payload: written },
      });
      // The first edit after publishing changes the tree's unpublished marker.
      if (changedStatus || overtaken)
        await queryClient.invalidateQueries({ queryKey: tree.queryKey });
      if (vaultStore.epoch() === epoch) {
        await queryClient.invalidateQueries({ queryKey: info.queryKey });
      }
    },
    overtaken: () => void queryClient.invalidateQueries({ queryKey: info.queryKey }),
  };
}

import {
  draftLinkTargets,
  pageOperations,
  type ClientContext,
  type DraftWriter,
  type PageId,
  type PagePayload,
  type Region,
  type RevisionId,
} from '@wikistow/client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { contentChanged } from '../data/content-changed';
import { onSent, pageWriter } from '../data/offline-changes';
import { pageQuery, queueOf, treeQuery } from '../data/queries';
import { vaultStore } from '../vault/store';
import { connection } from '../data/connection';
import { availability, waitingOf } from '../shell/availability';
import { useAppPlugins } from '../plugins/app-plugins';
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
  const { editorSaved } = useAppPlugins().runtime;
  const [{ session, drafts }] = useState(() => {
    const drafts = pageWriter(ctx).draft(page, { seen: queued?.version ?? null });
    const session = new DraftSession(
      { base, payload, region, theirs: queued?.theirs ?? null },
      appPorts(ctx, page, queryClient, drafts, editorSaved),
      surface,
    );
    if (queued?.sending) session.own(queued.sending);
    return { session, drafts };
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
  const conflictWithDevice = useCallback(() => drafts.conflictWithDevice(), [drafts]);

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
 * saved, such as a conflict they haven't resolved, or the page has a change
 * saved on this device only, or the app is offline (ADR 0009, decision 8);
 * null otherwise.
 */
export async function saveOpenDraft(pageId: PageId): Promise<string | null> {
  const session = openDrafts.get(pageId);
  if (session) {
    await session.flush().catch(() => {});
    if (session.hasUnsaved())
      return 'Your own edit to this page isn’t saved yet. Save it or resolve it in the editor first.';
  }
  // Not offline, nor with the page's change saved on this device only,
  // which would come back as a conflict with this change.
  const vault = vaultStore.get();
  const entries =
    vault.status === 'unlocked'
      ? await queueOf(vault.ctx)
          ?.waiting(pageId)
          .catch(() => null)
      : null;
  const now = availability('chat-edit', {
    offline: !connection.get().online,
    waiting: waitingOf(entries ?? []),
  });
  return now.allowed ? null : now.hint;
}

function appPorts(
  ctx: ClientContext,
  page: pageOperations.PageRef,
  queryClient: QueryClient,
  /** Where the session's saves and files go: the server, or this device's queue (ADR 0009, decision 7). */
  drafts: DraftWriter,
  /** Tells the app's plugins of each save. */
  editorSaved: (page: pageOperations.PageRef, revision: string) => void,
): DraftPorts {
  const tree = treeQuery(ctx, page.spaceId);
  const info = pageQuery(ctx, page.pageId);
  return {
    saveDraft: (input) => drafts.save({ read: readWikilinks, ...input }),
    onTopOf: (revisionId) => drafts.onTopOf(revisionId),
    waitingChange: () => drafts.waitingChange(),
    mergedWith: (version) => drafts.mergedWith(version),
    readLinks: readOpeningLinks,
    uploadAttachment: (file) => drafts.attach(file),
    // After a conflict with a change another window saved, this one's goes on top of it.
    draftHead: async () =>
      (await drafts.waitingHead()) ??
      (await queryClient.fetchQuery({ ...info, staleTime: 0 })).heads.draftHead,
    generation: () => ctx.revisions.generation,
    epoch: vaultStore.epoch,
    tree: () => queryClient.getQueryData(tree.queryKey),
    linkTargets(title) {
      const loaded = queryClient.getQueryData(tree.queryKey);
      return loaded ? draftLinkTargets(loaded, { id: page.pageId }, title) : null;
    },
    async saved({ revisionId, basedOn, written, region }) {
      editorSaved(page, revisionId);
      await contentChanged(queryClient, ctx, {
        saved: { ...page, basedOn, revisionId, payload: written, region },
      });
    },
    overtaken: () => void queryClient.invalidateQueries({ queryKey: info.queryKey }),
  };
}

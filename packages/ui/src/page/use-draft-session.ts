import {
  draftLinkTargets,
  pageOperations,
  type ClientContext,
  type PageId,
  type PagePayload,
  type Region,
  type RevisionId,
} from '@wikistow/client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
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
  surface: { readonly current: EditorSurfaceHandle | null };
}) {
  const queryClient = useQueryClient();
  const [session] = useState(
    () => new DraftSession({ base, payload, region }, appPorts(ctx, page, queryClient), surface),
  );
  const snapshot = useSyncExternalStore(session.subscribe, session.snapshot);

  useEffect(() => {
    session.open();
    openDrafts.set(page.pageId, session);
    return () => {
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

  return { session, snapshot };
}

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

function appPorts(
  ctx: ClientContext,
  page: pageOperations.PageRef,
  queryClient: QueryClient,
): DraftPorts {
  const tree = treeQuery(ctx, page.spaceId);
  const info = pageQuery(ctx, page.pageId);
  return {
    saveDraft: (input) => pageOperations.saveDraft(ctx, { page, read: readWikilinks, ...input }),
    readLinks: readOpeningLinks,
    uploadAttachment: (file) => pageOperations.uploadAttachment(ctx, page, file),
    draftHead: async () => (await pageOperations.loadPage(ctx, page.pageId)).heads.draftHead,
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
        saved: { ...page, basedOn, revisionId, title: written.title, markdown: written.markdown },
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

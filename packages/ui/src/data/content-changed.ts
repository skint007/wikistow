import {
  pageOperations,
  type ClientContext,
  type PageId,
  type PagePayload,
  type Region,
  type searchOperations,
  type SpaceId,
} from '@wikistow/client';
import type { QueryClient } from '@tanstack/react-query';
import { historyQuery, pageQuery, searchIndexChanged, treeQuery } from './queries';

/** A change to what a space holds, made by this person or told of by the server. */
export type ContentChange =
  /**
   * Something in the space's tree: a page or folder made, renamed, deleted,
   * restored or copied there. With `pageId`, that page changed too: it was
   * published, restored, unpublished, detached or edited by an agent or a
   * plugin.
   */
  | { spaceId: SpaceId; pageId?: PageId | null }
  /**
   * A draft this person saved, as written: its tree entry shows it at once,
   * and the index takes it without listing the space (`updateIndex`).
   */
  | { saved: SavedDraft };

/** A save into this device's queue (ADR 0009) names its base as the version saved. */
const queued = (saved: SavedDraft) => saved.revisionId === saved.basedOn;

/** A draft this person saved: the version, what it holds as written, and the region it is in. */
export type SavedDraft = searchOperations.SavedVersion & { payload: PagePayload; region: Region };

/**
 * Say what content changed, once, after the change: the spaces' trees load
 * again, and so do the pages' info and history, and the search index notes
 * the spaces or the saves (`searchIndexChanged`). What is shown loads again,
 * or with `unshown`, everything kept for them, shown or not. Resolves once
 * those loads are done.
 *
 * What's particular to one change, such as the trash, a page's copies or
 * the spaces listed, the caller loads again itself.
 */
export async function contentChanged(
  queryClient: QueryClient,
  ctx: ClientContext,
  change: ContentChange | readonly ContentChange[],
  { unshown = false }: { unshown?: boolean } = {},
): Promise<void> {
  const refetchType = unshown ? 'all' : 'active';
  const spaces = new Set<SpaceId>();
  const pages = new Map<PageId, pageOperations.PageRef>();
  const loads: Promise<void>[] = [];
  for (const each of [change].flat()) {
    if ('saved' in each) {
      // The server's answer to a save says no time, so this device's. A
      // save into this device's queue isn't taken yet, and keeps its base's.
      const stamp = !queued(each.saved) && each.saved.updated === undefined;
      // As the revision cache took it when written (`cacheWritten`), so one time.
      const written = (): string =>
        ctx.revisions.get({ ...each.saved, audience: 'draft' })?.createdAt ??
        new Date().toISOString();
      const saved = stamp ? { ...each.saved, updated: written() } : each.saved;
      searchIndexChanged(queryClient, { saved });
      loads.push(patchTree(queryClient, ctx, each.saved, refetchType));
      pages.set(each.saved.pageId, each.saved);
    } else {
      spaces.add(each.spaceId);
      if (each.pageId) pages.set(each.pageId, { spaceId: each.spaceId, pageId: each.pageId });
    }
  }
  if (spaces.size > 0) searchIndexChanged(queryClient, { spaces: [...spaces] });
  for (const spaceId of spaces) {
    loads.push(reloadTree(queryClient, treeQuery(ctx, spaceId).queryKey, refetchType));
  }
  for (const page of pages.values()) {
    for (const { queryKey } of [pageQuery(ctx, page.pageId), historyQuery(ctx, page)]) {
      loads.push(queryClient.invalidateQueries({ queryKey, refetchType }));
    }
  }
  await Promise.all(loads);
}

// A load already running may have started before the change, so another
// follows it. Changes heard meanwhile share that one, rather than each
// cancelling the load before it, which a steady stream of changes would do
// forever on a large tree.
async function reloadTree(
  queryClient: QueryClient,
  queryKey: ReturnType<typeof treeQuery>['queryKey'],
  refetchType: 'all' | 'active',
) {
  const running = queryClient.isFetching({ queryKey }) > 0;
  await queryClient.invalidateQueries({ queryKey, refetchType }, { cancelRefetch: false });
  if (running) {
    await queryClient.invalidateQueries({ queryKey, refetchType }, { cancelRefetch: false });
  }
}

/**
 * Show the version saved (its title, emoji, icon and region) as the page's
 * in its tree. Loaded again only for the first save since publishing, which
 * changes the tree's unpublished marker, or when a load was running: one
 * fetched before the save would land on the patch with the old title.
 */
async function patchTree(
  queryClient: QueryClient,
  ctx: ClientContext,
  saved: SavedDraft,
  refetchType: 'all' | 'active',
) {
  const { queryKey } = treeQuery(ctx, saved.spaceId);
  const overtaken = queryClient.isFetching({ queryKey }) > 0;
  if (overtaken) await queryClient.cancelQueries({ queryKey });
  let changedStatus = false;
  queryClient.setQueryData(queryKey, (loaded) => {
    if (!loaded) return loaded;
    return {
      ...loaded,
      pages: loaded.pages.map((entry) => {
        if (entry.id !== saved.pageId) return entry;
        changedStatus = !entry.draftChanges;
        return {
          ...entry,
          title: saved.payload.title,
          ...pageOperations.labelCover(saved.payload, 'draft'),
          region: saved.region,
          draftHead: saved.revisionId,
          draftChanges: true,
        };
      }),
    };
  });
  if (changedStatus || overtaken) await queryClient.invalidateQueries({ queryKey, refetchType });
}

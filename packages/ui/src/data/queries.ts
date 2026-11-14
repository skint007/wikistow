import {
  agentOperations,
  groupOperations,
  keptOperations,
  movedOperations,
  ownerOperations,
  pageOperations,
  publicationOperations,
  publicLinkOperations,
  queueOperations,
  searchOperations,
  sharingOperations,
  spaceKeys,
  spaceOperations,
  trashOperations,
  type ClientContext,
  type PageId,
  type RevisionId,
  type SpaceId,
} from '@wikistow/client';
import { hashKey, queryOptions, type QueryClient } from '@tanstack/react-query';
import { PLAIN } from '../vault/store';
import { readIndexLinks } from '../page/page-reader';
import { connection, noAnswer } from './connection';
import { searchIndexFile } from './index-file';
import { createIndexTracker, type IndexChange, type IndexTracker } from './index-tracker';
import { keepChanged } from './keeper';

// Everything here is decrypted or describes encrypted content, so every key
// starts with PLAIN and locking the vault drops it all.

/**
 * `online`'s answer, or when the server doesn't answer, `kept`'s, read from
 * what this device keeps (ADR 0009, decision 4). Offline, the server isn't
 * tried, and with nothing kept, `kept` throws `NotKept`; when it was tried
 * and nothing is kept, its failure stands.
 */
async function orKept<T>(online: () => Promise<T>, kept: () => T | Promise<T>): Promise<T> {
  if (!connection.get().online) return kept();
  try {
    return await online();
  } catch (error) {
    if (!noAnswer(error)) throw error;
    try {
      return await kept();
    } catch (failure) {
      throw failure instanceof keptOperations.NotKept ? error : failure;
    }
  }
}

export const spacesQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'spaces'],
    queryFn: () =>
      orKept(
        () => spaceOperations.loadSpaces(ctx),
        () => keptOperations.keptSpaceList(ctx).spaces,
      ),
  });

/** The home space and saved order, under the spaces' key so refreshing those refreshes it. */
export const spaceOrderQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'spaces', 'order'],
    queryFn: () =>
      orKept(
        () => spaceOperations.loadSpaceOrder(ctx),
        () => keptOperations.keptSpaceList(ctx).order,
      ),
  });

/**
 * This session's queue of changes made offline (ADR 0009, decision 7),
 * where the device keeps one, for what only reads it. Writes go through
 * the page writer (`pageWriter`).
 */
export const queueOf = (ctx: ClientContext): queueOperations.QueueReader | null =>
  ctx.keptContent?.queue ?? null;

/** The changes waiting on this device, none where it keeps no queue. */
const queued = async (ctx: ClientContext) =>
  (await queueOf(ctx)
    ?.entries()
    .catch(() => null)) ?? [];

/**
 * A space's tree; offline, its kept pages only (`keptTree`). With the
 * changes waiting on this device: folders and pages made offline, and
 * pages labelled from a draft saved here (`withQueued`).
 */
export const treeQuery = (ctx: ClientContext, spaceId: SpaceId) =>
  queryOptions({
    queryKey: [PLAIN, 'tree', spaceId],
    queryFn: async () => {
      const [tree, entries] = await Promise.all([
        orKept(
          () => spaceOperations.loadTree(ctx, spaceId),
          () => keptOperations.keptTree(ctx, spaceId),
        ),
        queued(ctx),
      ]);
      return queueOperations.withQueued(tree, spaceId, entries);
    },
  });

/**
 * Where the page or folder of an old address went, when a move took it into
 * another space and this person can open it there (`movedTo`); else null.
 * Offline it isn't asked, as nothing is kept of it: it fails, so it is asked
 * again once the connection is back.
 */
export const movedQuery = (ctx: ClientContext, old: { spaceId: SpaceId; nodeId: string }) =>
  queryOptions({
    queryKey: [PLAIN, 'moved', old.spaceId, old.nodeId],
    queryFn: () => {
      if (!connection.get().online) throw new keptOperations.NotKept();
      return movedOperations.movedTo(ctx, old);
    },
  });

/**
 * What opening a page says of it; offline, worked out from its kept space
 * (`keptPageInfo`), and for a page made offline, from its change until it
 * is made (`queuedPageInfo`).
 */
export const pageQuery = (ctx: ClientContext, pageId: PageId) =>
  queryOptions({
    queryKey: [PLAIN, 'page', pageId],
    queryFn: async () => {
      const entry = await queueOf(ctx)
        ?.entry(pageId)
        .catch(() => null);
      const made = entry?.kind === 'page' && queueOperations.queuedPageInfo(entry);
      if (made) return made;
      return orKept(
        () => pageOperations.loadPage(ctx, pageId),
        () => keptOperations.keptPageInfo(ctx, pageId),
      );
    },
  });

/**
 * Revision content never changes; write regions must be opened fresh. It is
 * kept per page, so another page's revision named in `?rev=` is fetched (and
 * refused) rather than shown from the cache.
 */
export const revisionQuery = (
  ctx: ClientContext,
  page: pageOperations.PageRef,
  /** Which version the view expects; one from the other audience is refused. */
  audience: 'draft' | 'published',
  revisionId: RevisionId,
) =>
  queryOptions({
    queryKey: [PLAIN, 'revision', page.spaceId, page.pageId, audience, revisionId],
    // Kept versions open from the device, online and offline, before the
    // server is asked; offline, one that isn't kept is `NotKept`.
    queryFn: async () => {
      try {
        return await pageOperations.openRevisionOf(ctx, page, audience, revisionId);
      } catch (error) {
        if (!connection.get().online && noAnswer(error)) throw new keptOperations.NotKept();
        throw error;
      }
    },
    staleTime: Infinity,
  });

/**
 * The space's pages with a public link that this person can see, for the
 * markers, with the link's id only where they can publish the page (ADR
 * 0005). Loads again with the tree when the server says it changed, which
 * it does when a link is turned on or off (`useTreeChanges`).
 */
export const publicLinksQuery = (ctx: ClientContext, spaceId: SpaceId) =>
  queryOptions({
    queryKey: [PLAIN, 'public-links', spaceId],
    queryFn: () => publicLinkOperations.list(ctx, spaceId),
  });

/** A copy of a page in another space that has a version: one the page lists. */
export type ListedCopy = publicationOperations.PublishedCopy & {
  copy: { state: 'live' | 'blocked' };
};

/**
 * Where a page is published in other spaces, for someone who can publish
 * it. An opening that never got a version is left out: nobody sees it, and
 * publishing there again picks it up or replaces it. It opens every
 * destination's tree, so it loads again when the page or a dialog showing
 * it opens, or this person publishes the page elsewhere or ends a copy,
 * not whenever the window is focused.
 */
export const publishedCopiesQuery = (ctx: ClientContext, page: pageOperations.PageRef) =>
  queryOptions({
    queryKey: [PLAIN, 'published-copies', page.pageId],
    queryFn: async () =>
      (await publicationOperations.publishedCopies(ctx, page)).filter(
        (published): published is ListedCopy => published.copy.state !== 'pending',
      ),
    refetchOnWindowFocus: false,
  });

export const historyQuery = (ctx: ClientContext, page: pageOperations.PageRef) =>
  queryOptions({
    queryKey: [PLAIN, 'history', page.pageId],
    queryFn: () => pageOperations.loadHistory(ctx, page),
  });

/**
 * What each of the page's published versions `ids` changed while reading
 * (ADR 0008). The versions never change, so neither does this.
 */
export const versionChangesQuery = (
  ctx: ClientContext,
  page: pageOperations.PageRef,
  ids: readonly RevisionId[],
) =>
  queryOptions({
    queryKey: [PLAIN, 'version-changes', page.pageId, ids],
    queryFn: () => pageOperations.versionChanges(ctx, page, ids),
    staleTime: Infinity,
  });

/** A space's shares and their members, for its owners. */
export const sharesQuery = (ctx: ClientContext, spaceId: SpaceId) =>
  queryOptions({
    queryKey: [PLAIN, 'shares', spaceId],
    queryFn: () => sharingOperations.listShares(ctx, spaceId),
  });

/**
 * A space's groups, with their decrypted names, members and shares, the
 * direct grants and who waits for keys there, for its owners. Every group
 * change is planned afresh from the server, so this is for showing only.
 */
export const groupsQuery = (ctx: ClientContext, spaceId: SpaceId) =>
  queryOptions({
    queryKey: [PLAIN, 'groups', spaceId],
    queryFn: () => groupOperations.loadGroups(ctx, spaceId),
  });

/**
 * Who has access to a space, for deleting it: its owners and permission
 * version first, then its shares and groups, so any change after the
 * version was read is one the server refuses (`permission-version`). Not
 * kept once the dialog closes, so each opening loads it afresh.
 */
export const spaceAccessQuery = (ctx: ClientContext, spaceId: SpaceId) =>
  queryOptions({
    queryKey: [PLAIN, 'space-access', spaceId],
    queryFn: async () => {
      const keys = await spaceKeys(ctx, spaceId, { refresh: true });
      const [shares, groups] = await Promise.all([
        sharingOperations.listShares(ctx, spaceId),
        groupOperations.loadGroups(ctx, spaceId),
      ]);
      return { keys, shares, groups };
    },
    gcTime: 0,
  });

/** The space as this app sees it: the owners it accepts, and what the server lists. */
export const spaceKeysQuery = (ctx: ClientContext, spaceId: SpaceId) =>
  queryOptions({
    queryKey: [PLAIN, 'space-keys', spaceId],
    queryFn: () => spaceKeys(ctx, spaceId, { refresh: true }),
  });

/** What is in the trash of the spaces this person owns (protocol section 10). */
export const trashQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'trash'],
    queryFn: () => trashOperations.loadTrash(ctx),
  });

/** Shares this person is a member of, with their root's name and who shared them; offline, as last kept. */
export const sharedWithMeQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'shared-with-me'],
    queryFn: () =>
      orKept(
        () => sharingOperations.sharedWithMe(ctx),
        () => keptOperations.keptSpaceList(ctx).shared,
      ),
  });

/** The owner to confirm before acting as an owner of the space, or null (protocol section 6.5). */
export const ownerToConfirmQuery = (ctx: ClientContext, spaceId: SpaceId) =>
  queryOptions({
    queryKey: [PLAIN, 'owner-to-confirm', spaceId],
    queryFn: () => ownerOperations.ownerToConfirm(ctx, spaceId),
  });

/** This person's agents as the server lists them, revoked ones too, with their picks. */
export const agentsQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'agents'],
    queryFn: () => agentOperations.listAgents(ctx),
  });

/** The groups this person's agents are in, to confirm or leave (protocol section 9.4). */
export const agentGroupsQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'agent-groups'],
    queryFn: () => agentOperations.listAgentGroups(ctx),
  });

/** How far the search index being built has got, kept beside it so a reopened dialog sees it too. */
export const searchProgressKey = [PLAIN, 'search-progress'] as const;

/** The search index (`usePageIndex`), one for the whole app. */
export const searchIndexKey = [PLAIN, 'search-index'] as const;

// The running build's version, set by the web app's Vite config. Only read
// where the index is kept (`searchIndexFile`), so tests without the define never do.
declare const __APP_VERSION__: string;

/**
 * Every page this person can read, indexed for search on this device. The
 * first time, built from the trees, opening only the pages whose version
 * changed since the index this device kept, sealed for this person and
 * build (`sealKept`, `searchIndexFile`). After that, each change this
 * person makes or the server tells of (`contentChanged`), and anything
 * missed meanwhile (`searchIndexChanged`), updates the one in memory
 * (`updateIndex`): only the spaces named are listed again, and every one
 * if none are, as when it is shown again a minute old. Only pages whose
 * version changed, or held without its time, are opened and indexed again, and an update that finds
 * nothing changed leaves the same index. Locking drops it with everything
 * else, and `refreshAccess` builds it afresh, so nothing outlives a lost
 * grant. Where it is kept, it is kept once this person's saves pause, and at
 * once after any other change it lets a version go for (`keepLater`).
 *
 * Offline (ADR 0009, decision 9), it is built from the pages kept on this
 * device alone, taking what the index shown read of them, so with **Pages
 * I open** it holds only those. It isn't kept, it stays as it is while
 * offline, and what changed waits until the server answers: back online,
 * an update lists every space (`useTreeChanges`).
 *
 * Not built again when the window is focused: coming back into view tells
 * it what it may have missed (`useTreeChanges`), and one update follows.
 */
export const searchIndexQuery = (ctx: ClientContext, queryClient: QueryClient) =>
  queryOptions({
    queryKey: searchIndexKey,
    queryFn: async ({ signal }) => {
      const shown = queryClient.getQueryData<searchOperations.PageIndex>(searchIndexKey);
      // Offline, one built from what's kept stays as it is until the server
      // answers, but for drafts saved on this device, which go in as written
      // (ADR 0009, decision 7): they need nothing from the server.
      if (shown && !connection.get().online && fromKept.has(shown)) {
        const changes = trackerOf(queryClient).take();
        const saved = changes.saved ?? [];
        const held = saved.filter(
          (save) => shown.page(save.spaceId, save.pageId)?.revisionId === save.basedOn,
        );
        trackerOf(queryClient).putBack({
          spaces: changes.spaces,
          saved: saved.filter((save) => !held.includes(save)),
        });
        if (held.length === 0) return shown;
        const index = await searchOperations.updateIndex(
          ctx,
          shown,
          { spaces: [], saved: held },
          { signal, readLinks: readIndexLinks },
        );
        fromKept.add(index);
        return index;
      }
      queryClient.setQueryData(searchProgressKey, { pages: 0, total: 0 });
      const onProgress = (progress: searchOperations.IndexProgress) =>
        queryClient.setQueryData(searchProgressKey, progress);
      const file = await searchIndexFile().catch(() => null);
      const tracker = trackerOf(queryClient);
      const changes = tracker.take();
      const { generation } = ctx.revisions;
      let index: searchOperations.PageIndex;
      // Built from what's kept alone, as offline: not kept again.
      let partial = false;
      try {
        if (shown && connection.get().online) {
          index = await searchOperations.updateIndex(ctx, shown, changes, {
            signal,
            onProgress,
            readLinks: readIndexLinks,
          });
        } else {
          // What an index read before stands in for the versions it read: the
          // one shown, going offline, else the one this device kept.
          const sealed = shown ? null : await file?.read().catch(() => null);
          const kept = shown
            ? searchOperations.keptPages(shown)
            : sealed
              ? searchOperations.openKept(ctx, sealed, __APP_VERSION__)
              : null;
          const build = (from: 'server' | 'kept') =>
            searchOperations.indexSpaces(ctx, {
              kept,
              from,
              signal,
              onProgress,
              readLinks: readIndexLinks,
            });
          partial = !connection.get().online;
          try {
            index = await build(partial ? 'kept' : 'server');
          } catch (error) {
            if (partial || !noAnswer(error)) throw error;
            partial = true;
            index = await build('kept');
          }
          // Back online, every space is listed again.
          if (partial) {
            // Drafts saved on this device go in as written, as saves do.
            index = await withQueuedDrafts(ctx, index, signal);
            fromKept.add(index);
            tracker.putBack({ spaces: 'all' });
          }
        }
      } catch (error) {
        // Followed by the next update instead, unless the vault locked or
        // access changed: the next index is built afresh.
        if (ctx.revisions.generation === generation) tracker.putBack(changes);
        // Given up as nothing shows it any more: no draft's text waits.
        if (!queryClient.getQueryCache().find({ queryKey: searchIndexKey })?.isActive()) {
          tracker.dropSaves();
        }
        throw error;
      }
      if (file && !partial && index !== shown) {
        // What the file held of a version let go goes at once, as from
        // memory, but for this person's own drafts saved over.
        const now = !shown || searchOperations.letGo(shown, index, changes.saved);
        keepLater(queryClient, ctx, now);
      }
      return index;
    },
    // Shown again within a minute, it is kept; after that it updates behind it.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

/**
 * `index` with the drafts waiting on this device for pages it holds, at the
 * draft they are based on (ADR 0009, decision 7): offline, they are the
 * page's draft. A page made offline goes in once it is made.
 */
async function withQueuedDrafts(
  ctx: ClientContext,
  index: searchOperations.PageIndex,
  signal: AbortSignal,
): Promise<searchOperations.PageIndex> {
  const drafts =
    (await queueOf(ctx)
      ?.drafts()
      .catch(() => null)) ?? [];
  const saved = drafts.filter(
    (draft) => index.page(draft.spaceId, draft.pageId)?.revisionId === draft.basedOn,
  );
  if (saved.length === 0) return index;
  return searchOperations.updateIndex(
    ctx,
    index,
    { spaces: [], saved },
    { signal, readLinks: readIndexLinks },
  );
}

/** Indexes built from what's kept alone, offline: never kept, and updated from the server once back. */
const fromKept = new WeakSet<searchOperations.PageIndex>();

/** `index` was built offline from what's kept alone, so may lack pages still there. */
export const builtFromKept = (index: searchOperations.PageIndex): boolean => fromKept.has(index);

const searchIndexHash = hashKey(searchIndexKey);
const trackers = new WeakMap<QueryClient, IndexTracker>();

/**
 * What changed that `queryClient`'s index hasn't taken (`createIndexTracker`),
 * connected to its query: shown while something observes it, and gone, with
 * what it waited to take, when locking removes it.
 */
function trackerOf(queryClient: QueryClient): IndexTracker {
  const known = trackers.get(queryClient);
  if (known) return known;
  const query = () => queryClient.getQueryCache().find({ queryKey: searchIndexKey });
  const tracker = createIndexTracker({
    shown: () => query()?.isActive() ?? false,
    running() {
      const running = query();
      return running?.state.fetchStatus === 'fetching' ? (running.promise ?? null) : null;
    },
    stale: () =>
      void queryClient.invalidateQueries({ queryKey: searchIndexKey }, { cancelRefetch: false }),
  });
  trackers.set(queryClient, tracker);
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'removed' && event.query.queryHash === searchIndexHash) tracker.forget();
  });
  return tracker;
}

/**
 * Tell the index of a change (`contentChanged`, or `useTreeChanges` for what
 * it may have missed, as when back in view or online): the spaces it was in,
 * every one if none are named, or a draft this person saved, as written. The index
 * is updated if something shows it (`usePageIndex`), with the other changes
 * in the next `GATHER_MS`, or else when next shown, so search and what lists
 * pages find what was just written.
 */
export function searchIndexChanged(
  queryClient: QueryClient,
  change: IndexChange = { spaces: 'all' },
) {
  trackerOf(queryClient).note(change);
  if ('saved' in change) for (const listener of savesHeard(queryClient)) listener(change.saved);
}

const saveListeners = new WeakMap<
  QueryClient,
  Set<(save: searchOperations.SavedVersion) => void>
>();
const savesHeard = (queryClient: QueryClient) => {
  let listeners = saveListeners.get(queryClient);
  if (!listeners) saveListeners.set(queryClient, (listeners = new Set()));
  return listeners;
};

/**
 * Call `listener` with each draft this person saves, as the index hears of
 * it (`searchIndexChanged`), until the returned function is called: search
 * by meaning waits for a page's saves to pause before embedding it.
 */
export function onDraftSaved(
  queryClient: QueryClient,
  listener: (save: searchOperations.SavedVersion) => void,
): () => void {
  savesHeard(queryClient).add(listener);
  return () => {
    savesHeard(queryClient).delete(listener);
  };
}

/**
 * Once its changes pause, this device keeps the index, sealed for this
 * person and build, where it keeps it then (`searchIndexFile`), so not after
 * a switch to **Pages I open**. With `now`, as for an index built afresh or
 * one that let go of a version other than a draft this person saved over
 * (`letGo`), at once, so the file holds nothing longer than memory does. It
 * keeps the index then shown, if `ctx` still built it: the vault locked or
 * access changed meanwhile, nothing is kept, and nothing here holds on to
 * the index till then.
 */
function keepLater(queryClient: QueryClient, ctx: ClientContext, now: boolean) {
  // Locking, or `refreshAccess`, clears the cache, which moves this on.
  const { generation } = ctx.revisions;
  trackerOf(queryClient).keep(now, async () => {
    const file = await searchIndexFile();
    const index = queryClient.getQueryData<searchOperations.PageIndex>(searchIndexKey);
    if (!file || !index || ctx.revisions.generation !== generation) return;
    // Throws if the vault locked meanwhile: nothing to keep.
    const sealed = searchOperations.sealKept(
      ctx,
      searchOperations.keptPages(index),
      __APP_VERSION__,
    );
    await file.write(sealed);
  });
}

/**
 * Refetch everything an owner action can change: who has access, the
 * spaces and trees people see, and what waits to be finished.
 */
export async function refreshAccess(queryClient: QueryClient, ctx: ClientContext) {
  ctx.revisions.clear();
  // Pages whose access was lost leave the search index now, not when it is
  // next stale, and so do the saves it hasn't taken.
  trackerOf(queryClient).forget();
  void queryClient.resetQueries({ queryKey: searchIndexKey });
  // Pages kept for offline let go of what access no longer covers.
  keepChanged(ctx);
  // An open page keeps what it shows while it reopens, so an editor on it stays
  // mounted with its own saves; the refetch cancels any opening under old access.
  queryClient.removeQueries({ queryKey: [PLAIN, 'revision'], type: 'inactive' });
  await Promise.all(
    [
      'revision',
      'shares',
      'groups',
      'space-keys',
      'shared-with-me',
      'owner-to-confirm',
      'spaces',
      'tree',
      'public-links',
      'people',
      'pending-owner-work',
      'agents',
      'agent-groups',
      // Seals new key versions to this person's agents, as at unlock.
      'agent-work',
    ].map((kind) => queryClient.invalidateQueries({ queryKey: [PLAIN, kind] })),
  );
}

import {
  agentOperations,
  groupOperations,
  keptOperations,
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

/** The changes waiting on this device (ADR 0009, decision 7), none where it keeps no queue. */
const queued = async (ctx: ClientContext) =>
  (await ctx.keptContent?.queue.entries().catch(() => null)) ?? [];

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
 * What opening a page says of it; offline, worked out from its kept space
 * (`keptPageInfo`), and for a page made offline, from its change until it
 * is made (`queuedPageInfo`).
 */
export const pageQuery = (ctx: ClientContext, pageId: PageId) =>
  queryOptions({
    queryKey: [PLAIN, 'page', pageId],
    queryFn: async () => {
      const entry = await ctx.keptContent?.queue.entry(pageId).catch(() => null);
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
 * build (`sealKept`, `searchIndexFile`). After that, each change this person makes, or the
 * server tells of (`searchIndexChanged`), updates the one in memory
 * (`updateIndex`): only the spaces named are listed again, and every one
 * if none are, as when it is shown again a minute old. Only pages whose
 * version changed are opened and indexed again, and an update that finds
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
        const changes = takeChanges(queryClient);
        const saved = changes.saved ?? [];
        const held = saved.filter(
          (save) => shown.page(save.spaceId, save.pageId)?.revisionId === save.basedOn,
        );
        noteBack(queryClient, {
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
      const changes = takeChanges(queryClient);
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
            fromKept.add(index);
            changed(queryClient, 'all');
          }
        }
      } catch (error) {
        // Followed by the next update instead, unless the vault locked or
        // access changed: the next index is built afresh.
        if (ctx.revisions.generation === generation) noteBack(queryClient, changes);
        // Given up as nothing shows it any more: no draft's text waits.
        if (!queryClient.getQueryCache().find({ queryKey: searchIndexKey })?.isActive()) {
          savesAsSpaces(queryClient);
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

/** Indexes built from what's kept alone, offline: never kept, and updated from the server once back. */
const fromKept = new WeakSet<searchOperations.PageIndex>();

/** How long changes gather, while something shows the index, before it follows them together. */
export const GATHER_MS = 300;

/** How long this device waits for changes to pause before keeping the index, and at most. */
export const KEEP_MS = 5_000;
export const KEEP_AT_MOST_MS = 60_000;

/** For each query client: what changed since the index was last updated, and what waits. */
type Following = {
  /** The spaces changed since, or every one; null for none. */
  spaces: Set<SpaceId> | 'all' | null;
  /** This person's own drafts saved since, in order. */
  saved: searchOperations.SavedVersion[];
  gathering: ReturnType<typeof setTimeout> | null;
  keeping: { since: number; now: boolean; timer: ReturnType<typeof setTimeout> } | null;
};
const following = new WeakMap<QueryClient, Following>();

function followingOf(queryClient: QueryClient): Following {
  let state = following.get(queryClient);
  if (!state) {
    state = { spaces: null, saved: [], gathering: null, keeping: null };
    following.set(queryClient, state);
    // Locking removes the index: what it waited to take goes with it.
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'removed' && event.query.queryHash === searchIndexHash) {
        forget(queryClient);
      }
    });
  }
  return state;
}

const searchIndexHash = hashKey(searchIndexKey);

/** Drop what changed and what waits: the index it was for is gone. */
function forget(queryClient: QueryClient) {
  const state = following.get(queryClient);
  if (!state) return;
  if (state.gathering) clearTimeout(state.gathering);
  if (state.keeping) clearTimeout(state.keeping.timer);
  Object.assign(state, { spaces: null, saved: [], gathering: null, keeping: null });
}

/**
 * Note each save as its space alone: the next update lists it, so no
 * draft's text waits here while nothing shows the index.
 */
function savesAsSpaces(queryClient: QueryClient) {
  const state = followingOf(queryClient);
  if (state.saved.length === 0) return;
  changed(
    queryClient,
    state.saved.map(({ spaceId }) => spaceId),
  );
  state.saved = [];
}

/** Note `spaces` changed (every one for 'all'). */
function changed(queryClient: QueryClient, spaces: Iterable<SpaceId> | 'all') {
  const state = followingOf(queryClient);
  if (spaces === 'all' || state.spaces === 'all') state.spaces = 'all';
  else state.spaces = new Set([...(state.spaces ?? []), ...spaces]);
}

/**
 * Note a save. One over a save still waiting stands in for it, over what
 * that was saved over, so a page's autosaves wait as one.
 */
function noteSave(state: Following, saved: searchOperations.SavedVersion) {
  const at = state.saved.findIndex(
    (before) =>
      before.spaceId === saved.spaceId &&
      before.pageId === saved.pageId &&
      before.revisionId === saved.basedOn,
  );
  const before = state.saved[at];
  if (before) state.saved.splice(at, 1, { ...saved, basedOn: before.basedOn });
  else state.saved.push(saved);
}

/** Whether anything changed that the index hasn't taken. */
const noted = (state: Following) => state.spaces !== null || state.saved.length > 0;

/**
 * What changed since the last update, for the next. With nothing noted, as
 * when the index is shown again a minute old, every space.
 */
function takeChanges(queryClient: QueryClient): searchOperations.IndexChanges {
  const state = followingOf(queryClient);
  const { spaces, saved } = state;
  const all = spaces === 'all' || !noted(state);
  state.spaces = null;
  state.saved = [];
  return { spaces: all ? 'all' : [...(spaces ?? [])], saved };
}

/** Note again what an update that failed took, before what came since. */
function noteBack(queryClient: QueryClient, changes: searchOperations.IndexChanges) {
  changed(queryClient, changes.spaces);
  const state = followingOf(queryClient);
  state.saved = [...(changes.saved ?? []), ...state.saved];
}

/**
 * After a change to a page or folder: this person's own (a save, publish,
 * restore, creation, deletion, detach or unpublish), wherever its tree is
 * refetched or patched, and one the server tells of (`useTreeChanges`),
 * naming the spaces it changed in (`spaceIds`), or else in any. A draft
 * this person saved is given as written (`saved`), so the index takes it
 * without listing anything (`updateIndex`). The index is updated if
 * something shows it (`usePageIndex`), with the other changes in the next
 * `GATHER_MS`, or else when next shown, so search and what lists pages
 * find what was just written.
 *
 * An update already running may have started before the change, so another
 * follows it if so, and changes meanwhile share that one: a stream of
 * autosaves can't keep putting it off.
 */
export function searchIndexChanged(
  queryClient: QueryClient,
  change?: { spaceIds: readonly SpaceId[] } | { saved: searchOperations.SavedVersion },
) {
  const state = followingOf(queryClient);
  const shown = queryClient.getQueryCache().find({ queryKey: searchIndexKey })?.isActive();
  if (change && 'saved' in change) {
    if (shown) noteSave(state, change.saved);
    else changed(queryClient, [change.saved.spaceId]);
  } else changed(queryClient, change ? change.spaceIds : 'all');
  if (!shown) {
    follow(queryClient);
    return;
  }
  state.gathering ??= setTimeout(() => {
    state.gathering = null;
    follow(queryClient);
  }, GATHER_MS);
}

// Marks the index stale, which updates it now if something shows it. One
// already updating finishes first, then the changes it didn't take, if
// any, mark it stale again: its success would mark it fresh.
function follow(queryClient: QueryClient) {
  // Taken already, by an update that started meanwhile.
  if (!noted(followingOf(queryClient))) return;
  const query = queryClient.getQueryCache().find({ queryKey: searchIndexKey });
  if (!query?.isActive()) savesAsSpaces(queryClient);
  const stale = () =>
    queryClient.invalidateQueries({ queryKey: searchIndexKey }, { cancelRefetch: false });
  const running = query?.state.fetchStatus === 'fetching' ? query.promise : undefined;
  void stale();
  const untaken = () => {
    if (!noted(followingOf(queryClient))) return;
    if (!queryClient.getQueryCache().find({ queryKey: searchIndexKey })?.isActive()) {
      savesAsSpaces(queryClient);
    }
    void stale();
  };
  if (running) void running.then(untaken, untaken);
}

/**
 * Once the index has stopped changing for `KEEP_MS`, or `KEEP_AT_MOST_MS`
 * after it first changed, this device keeps it, sealed for this person and
 * build, where it keeps it then (`searchIndexFile`), so not after a switch
 * to **Pages I open**: once for a burst of changes, not once each. With `now`, as
 * for an index built afresh or one that let go of a version other than a
 * draft this person saved over (`letGo`), at once, so the file holds
 * nothing longer than memory does. Failing to keep it only means reading more pages at the next
 * launch. It keeps the index then shown, if `ctx` still built it: the
 * vault locked or access changed meanwhile, nothing is kept, and nothing
 * here holds on to the index till then.
 */
function keepLater(queryClient: QueryClient, ctx: ClientContext, now: boolean) {
  const state = followingOf(queryClient);
  // A write due at once stays so: it keeps the index then shown, this one.
  if (state.keeping?.now) return;
  const at = Date.now();
  const since = state.keeping?.since ?? at;
  if (state.keeping) clearTimeout(state.keeping.timer);
  // Locking, or `refreshAccess`, clears the cache, which moves this on.
  const { generation } = ctx.revisions;
  const keep = async () => {
    state.keeping = null;
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
  };
  // Even at once, after React Query takes it as the index shown.
  const wait = now ? 0 : Math.max(0, Math.min(KEEP_MS, since + KEEP_AT_MOST_MS - at));
  state.keeping = {
    since: now ? at : since,
    now,
    timer: setTimeout(() => void keep().catch(() => {}), wait),
  };
}

/**
 * Refetch everything an owner action can change: who has access, the
 * spaces and trees people see, and what waits to be finished.
 */
export async function refreshAccess(queryClient: QueryClient, ctx: ClientContext) {
  ctx.revisions.clear();
  // Pages whose access was lost leave the search index now, not when it is
  // next stale, and so do the saves it hasn't taken.
  forget(queryClient);
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

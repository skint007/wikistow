import {
  agentOperations,
  groupOperations,
  ownerOperations,
  pageOperations,
  publicationOperations,
  publicLinkOperations,
  searchOperations,
  sharingOperations,
  spaceKeys,
  spaceOperations,
  type ClientContext,
  type PageId,
  type RevisionId,
  type SpaceId,
} from '@wikistow/client';
import { hashKey, queryOptions, type QueryClient } from '@tanstack/react-query';
import type { DesktopBridge } from '@wikistow/contracts';
import { desktop } from '../desktop';
import { PLAIN } from '../vault/store';

// Everything here is decrypted or describes encrypted content, so every key
// starts with PLAIN and locking the vault drops it all.

export const spacesQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'spaces'],
    queryFn: () => spaceOperations.loadSpaces(ctx),
  });

/** The home space and saved order, under the spaces' key so refreshing those refreshes it. */
export const spaceOrderQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'spaces', 'order'],
    queryFn: () => spaceOperations.loadSpaceOrder(ctx),
  });

export const treeQuery = (ctx: ClientContext, spaceId: SpaceId) =>
  queryOptions({
    queryKey: [PLAIN, 'tree', spaceId],
    queryFn: () => spaceOperations.loadTree(ctx, spaceId),
  });

export const pageQuery = (ctx: ClientContext, pageId: PageId) =>
  queryOptions({
    queryKey: [PLAIN, 'page', pageId],
    queryFn: () => pageOperations.loadPage(ctx, pageId),
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
    queryFn: () => pageOperations.openRevisionOf(ctx, page, audience, revisionId),
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

/** Shares this person is a member of, with their root's name and who shared them. */
export const sharedWithMeQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'shared-with-me'],
    queryFn: () => sharingOperations.sharedWithMe(ctx),
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

// The running build's version, set by the web app's Vite config. Only the
// desktop app's path reads it, so tests without the define never do.
declare const __APP_VERSION__: string;

/**
 * Every page this person can read, indexed for search on this device. The
 * first time, built from the trees, opening only the pages whose version
 * changed since the index the desktop app kept, sealed for this person and
 * build (`sealKept`). After that, each change this person makes, or the
 * server tells of (`searchIndexChanged`), updates the one in memory
 * (`updateIndex`): only the spaces named are listed again, and every one
 * if none are, as when it is shown again a minute old. Only pages whose
 * version changed are opened and indexed again, and an update that finds
 * nothing changed leaves the same index. Locking drops it with everything
 * else, and `refreshAccess` builds it afresh, so nothing outlives a lost
 * grant. The desktop app keeps it once this person's saves pause, and at
 * once after any other change it lets a version go for (`keepLater`).
 *
 * Not built again when the window is focused: coming back into view tells
 * it what it may have missed (`useTreeChanges`), and one update follows.
 */
export const searchIndexQuery = (ctx: ClientContext, queryClient: QueryClient) =>
  queryOptions({
    queryKey: searchIndexKey,
    queryFn: async ({ signal }) => {
      queryClient.setQueryData(searchProgressKey, { pages: 0, total: 0 });
      const onProgress = (progress: searchOperations.IndexProgress) =>
        queryClient.setQueryData(searchProgressKey, progress);
      // The desktop app keeps one between launches only with a trusted keyring.
      const device = desktop && (await desktop.secureStorage().catch(() => false)) ? desktop : null;
      const shown = queryClient.getQueryData<searchOperations.PageIndex>(searchIndexKey);
      const changes = takeChanges(queryClient);
      const { generation } = ctx.revisions;
      let index: searchOperations.PageIndex;
      try {
        if (shown) {
          index = await searchOperations.updateIndex(ctx, shown, changes, { signal, onProgress });
        } else {
          const sealed = await device?.searchIndex().catch(() => null);
          index = await searchOperations.indexSpaces(ctx, {
            kept: sealed ? searchOperations.openKept(ctx, sealed, __APP_VERSION__) : null,
            signal,
            onProgress,
          });
        }
      } catch (error) {
        // Followed by the next update instead, unless the vault locked or
        // access changed: the next index is built afresh.
        if (ctx.revisions.generation === generation) noteBack(queryClient, changes);
        throw error;
      }
      if (device && index !== shown) {
        // What the file held of a version let go goes at once, as from
        // memory, but for this person's own drafts saved over.
        const now = !shown || searchOperations.letGo(shown, index, changes.saved);
        keepLater(queryClient, ctx, device, now);
      }
      return index;
    },
    // Shown again within a minute, it is kept; after that it updates behind it.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

/** How long changes gather, while something shows the index, before it follows them together. */
export const GATHER_MS = 300;

/** How long the desktop app waits for changes to pause before keeping the index, and at most. */
export const KEEP_MS = 5_000;
export const KEEP_AT_MOST_MS = 60_000;

/** For each query client: what changed since the index was last updated, and what waits. */
type Following = {
  /** The spaces changed since, or every one; null for none. */
  spaces: Set<SpaceId> | 'all' | null;
  /** This person's own drafts saved since, in order. */
  saved: searchOperations.SavedVersion[];
  gathering: ReturnType<typeof setTimeout> | null;
  keeping: { since: number; timer: ReturnType<typeof setTimeout> } | null;
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
    if (shown) state.saved.push(change.saved);
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
 * after it first changed, the desktop app keeps it, sealed for this person
 * and build: once for a burst of changes, not once each. With `now`, as
 * for an index built afresh or one that let go of a version other than a
 * draft this person saved over (`letGo`), at once, so the file holds
 * nothing longer than memory does. Failing to keep it only means reading more pages at the next
 * launch. It keeps the index then shown, if `ctx` still built it: the
 * vault locked or access changed meanwhile, nothing is kept, and nothing
 * here holds on to the index till then.
 */
function keepLater(
  queryClient: QueryClient,
  ctx: ClientContext,
  device: DesktopBridge,
  now: boolean,
) {
  const state = followingOf(queryClient);
  const at = Date.now();
  const since = state.keeping?.since ?? at;
  if (state.keeping) clearTimeout(state.keeping.timer);
  // Locking, or `refreshAccess`, clears the cache, which moves this on.
  const { generation } = ctx.revisions;
  const keep = () => {
    state.keeping = null;
    const index = queryClient.getQueryData<searchOperations.PageIndex>(searchIndexKey);
    if (!index || ctx.revisions.generation !== generation) return;
    try {
      const sealed = searchOperations.sealKept(
        ctx,
        searchOperations.keptPages(index),
        __APP_VERSION__,
      );
      void device.keepSearchIndex(sealed).catch(() => {});
    } catch {
      // Locked meanwhile: nothing to keep.
    }
  };
  // Even at once, after React Query takes it as the index shown.
  const wait = now ? 0 : Math.max(0, Math.min(KEEP_MS, since + KEEP_AT_MOST_MS - at));
  state.keeping = { since: now ? at : since, timer: setTimeout(keep, wait) };
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

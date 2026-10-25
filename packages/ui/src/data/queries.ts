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
import { queryOptions, type QueryClient } from '@tanstack/react-query';
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
 * Every page this person can read, indexed for search on this device. Built
 * afresh from the trees when it is stale, opening only the pages whose
 * version changed since the index before it: the one in memory, or at the
 * first search after an unlock the one the desktop app kept, sealed for this
 * person and build (`sealKept`). Locking drops it with everything else, and
 * `refreshAccess` rebuilds it, so nothing outlives a lost grant. This
 * person's own changes, and those the server tells of, mark it stale
 * (`searchIndexChanged`).
 */
export const searchIndexQuery = (ctx: ClientContext, queryClient: QueryClient) =>
  queryOptions({
    queryKey: searchIndexKey,
    queryFn: async ({ signal }) => {
      queryClient.setQueryData(searchProgressKey, { pages: 0, total: 0 });
      // The desktop app keeps one between launches only with a trusted keyring.
      const device = desktop && (await desktop.secureStorage().catch(() => false)) ? desktop : null;
      const shown = queryClient.getQueryData<searchOperations.PageIndex>(searchIndexKey);
      const sealed = shown ? null : await device?.searchIndex().catch(() => null);
      const index = await searchOperations.indexSpaces(ctx, {
        kept: shown
          ? searchOperations.keptPages(shown)
          : sealed
            ? searchOperations.openKept(ctx, sealed, __APP_VERSION__)
            : null,
        signal,
        onProgress: (progress) => queryClient.setQueryData(searchProgressKey, progress),
      });
      // Failing to keep it only means reading every page at the next launch.
      if (device) {
        const pages = searchOperations.keptPages(index);
        void device
          .keepSearchIndex(searchOperations.sealKept(ctx, pages, __APP_VERSION__))
          .catch(() => {});
      }
      return index;
    },
    // Reopening search within a minute keeps the index; after that it rebuilds behind it.
    staleTime: 60_000,
  });

/**
 * After a change to a page or folder: this person's own (a save, publish,
 * restore, creation, deletion, detach or unpublish), wherever its tree is
 * refetched or patched, and one the server tells of (`useTreeChanges`).
 * The index is rebuilt now if something shows it (`usePageIndex`), or else
 * when next shown, so search finds what was just written. A rebuild already
 * running may have started before the change, so another follows it, and
 * changes meanwhile share that one: autosaves don't keep cancelling it.
 */
export function searchIndexChanged(queryClient: QueryClient) {
  const changed = () =>
    queryClient.invalidateQueries({ queryKey: searchIndexKey }, { cancelRefetch: false });
  // Followed once it settles, whether anything shows it or not: its success
  // would mark it fresh again.
  const running = queryClient.getQueryCache().find({ queryKey: searchIndexKey })?.promise;
  void changed();
  if (running) void running.then(changed, changed);
}

/**
 * Refetch everything an owner action can change: who has access, the
 * spaces and trees people see, and what waits to be finished.
 */
export async function refreshAccess(queryClient: QueryClient, ctx: ClientContext) {
  ctx.revisions.clear();
  // Pages whose access was lost leave the search index now, not when it is next stale.
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

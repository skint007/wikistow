import {
  agentOperations,
  ownerOperations,
  pageOperations,
  publicationOperations,
  searchOperations,
  sharingOperations,
  spaceKeys,
  spaceOperations,
  type ClientContext,
  type PageId,
  type RevisionId,
  type SearchIndex,
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

/** How far the search index being built has got, kept beside it so a reopened dialog sees it too. */
export const searchProgressKey = [PLAIN, 'search-progress'] as const;

const searchIndexKey = [PLAIN, 'search-index'] as const;

/**
 * Every page this person can read, indexed for search on this device. Built
 * afresh from the trees when it is stale, opening only the pages whose
 * version changed since the index before it: the one in memory, or at the
 * first search after an unlock the one the desktop app kept, sealed for this
 * person (`sealKept`). Locking drops it with everything else, and
 * `refreshAccess` rebuilds it, so nothing outlives a lost grant. This
 * person's own changes mark it stale (`searchIndexChanged`).
 */
export const searchIndexQuery = (ctx: ClientContext, queryClient: QueryClient) =>
  queryOptions({
    queryKey: searchIndexKey,
    queryFn: async ({ signal }) => {
      queryClient.setQueryData(searchProgressKey, { pages: 0, total: 0 });
      const index = await searchOperations.indexSpaces(ctx, {
        kept: await keptIndex(ctx, queryClient),
        signal,
        onProgress: (progress) => queryClient.setQueryData(searchProgressKey, progress),
      });
      // Kept for the next launch; failing to only means a full build then.
      void desktop
        ?.keepSearchIndex(searchOperations.sealKept(ctx, searchOperations.keptPages(index)))
        .catch(() => {});
      return index;
    },
    // Reopening search within a minute keeps the index; after that it rebuilds behind it.
    staleTime: 60_000,
  });

/** The index before this one: the one in memory, or else the one the desktop app kept. */
async function keptIndex(ctx: ClientContext, queryClient: QueryClient) {
  const shown = queryClient.getQueryData<SearchIndex<searchOperations.SearchPage>>(searchIndexKey);
  if (shown) return searchOperations.keptPages(shown);
  const sealed = await desktop?.searchIndex().catch(() => null);
  return sealed ? searchOperations.openKept(ctx, sealed) : null;
}

/**
 * After this person's own change to a page or folder (a save, publish,
 * restore, creation, deletion, detach or unpublish), wherever its tree is
 * refetched or patched: search rebuilds its index when next opened, so it
 * finds what they just wrote. Others' changes show once it is stale.
 */
export const searchIndexChanged = (queryClient: QueryClient) =>
  void queryClient.invalidateQueries({ queryKey: searchIndexKey });

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
      'space-keys',
      'shared-with-me',
      'owner-to-confirm',
      'spaces',
      'tree',
      'people',
      'pending-owner-work',
      'agents',
      // Seals new key versions to this person's agents, as at unlock.
      'agent-work',
    ].map((kind) => queryClient.invalidateQueries({ queryKey: [PLAIN, kind] })),
  );
}

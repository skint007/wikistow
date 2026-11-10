// Comments on pages (protocol section 5.9, ADR 0014): a page's threads,
// each comment opened with the checks of decision 4 against the region of
// the page's version this app opened; writing, editing, deleting and
// resolving; seen marks; and New comments.
import {
  commentRoutes,
  CommentId,
  MetadataRevisionId,
  pageRoutes,
  type Audience,
  type RevisionId,
  type IdentityId,
  type PageId,
  type SpaceId,
} from '@wikistow/contracts';
import { ApiError, outcomeUnknown } from '../api/client.ts';
import {
  newCommentPayload,
  openComment,
  revisedComment,
  sealComment,
  type CommentPayload,
  type CommentQuote,
  type OpenedComment,
} from '../comments.ts';
import { CryptoError } from '../errors.ts';
import { agentIdentityId, isAgentId } from '../identity.ts';
import { newId } from '../ids.ts';
import { sameRegion, type Region } from '../regions.ts';
import { lookupDirectory, pinAuthors } from './keys.ts';
import { openRevisions } from './pages.ts';
import { keysFor, keyTargetFor, treeTarget, withFreshKeys } from './records.ts';
import type { ClientContext } from './session.ts';
import { loadTree } from './spaces.ts';

/**
 * A page, with the region of its version this app opened and shows: the
 * draft's in the draft view, the publication's in the published view. A
 * comment is checked against it, and a first comment written in it
 * (decision 4).
 */
export type CommentPage = {
  spaceId: SpaceId;
  pageId: PageId;
  region: Region;
  /**
   * The version on screen. A version opened before a share or a move is
   * remembered in its old region: when comments don't open in `region`,
   * it is opened again, and they are checked against where it is now.
   */
  version?: { revisionId: RevisionId; audience: Audience } | undefined;
};

/** A comment as this app shows it. The times and order are the server's (Q5). */
export type ShownComment = {
  commentId: CommentId;
  createdAt: string;
  editedAt: string | null;
  state:
    | {
        kind: 'opened';
        /** The record's signed author. */
        authorId: IdentityId;
        /** Its signed `basedOn` isn't null (decision 6), never by the server's times. */
        edited: boolean;
        payload: CommentPayload;
        /** The version an edit is based on, and the region it is in. */
        versionId: MetadataRevisionId;
        region: Region;
      }
    | { kind: 'newer-format'; authorId: IdentityId; edited: boolean }
    /** Shown as "This comment can't be opened"; `authorId` is the server's word. */
    | { kind: 'unreadable'; authorId: IdentityId; error: CryptoError }
    /** A first comment deleted while its thread has replies. */
    | { kind: 'deleted' };
};

/** A thread: its first comment and replies, oldest first, with its server state. */
export type ShownThread = {
  thread: CommentId;
  audience: Audience;
  first: ShownComment;
  replies: ShownComment[];
  resolved: { by: IdentityId; at: string } | null;
  /** For editors: a thread for readers started before the page's latest unpublish. */
  beforeUnpublish: boolean;
};

// Open one served comment, or say why it can't be.
function shown(
  ctx: ClientContext,
  keys: Awaited<ReturnType<typeof keysFor>>,
  page: CommentPage,
  served: commentRoutes.ServedComment,
  { thread, audience }: { thread: CommentId | null; audience: Audience },
): ShownComment {
  const base = {
    commentId: served.commentId,
    createdAt: served.createdAt,
    editedAt: served.editedAt,
  };
  if (!served.sealed) return { ...base, state: { kind: 'deleted' } };
  let opened: OpenedComment;
  try {
    opened = openComment({
      reader: ctx.identity,
      trust: ctx.trust,
      owners: keys.owners.opens,
      installationId: ctx.installationId,
      keyring: ctx.keyring,
      sealed: served.sealed,
      listed: {
        spaceId: page.spaceId,
        pageId: page.pageId,
        commentId: served.commentId,
        thread,
        audience,
      },
      region: page.region,
    });
  } catch (error) {
    if (!(error instanceof CryptoError)) throw error;
    return { ...base, state: { kind: 'unreadable', authorId: served.authorId, error } };
  }
  const { record } = opened;
  const signed = { authorId: record.authorId, edited: record.basedOn !== null };
  if (opened.kind === 'newer-format')
    return { ...base, state: { kind: 'newer-format', ...signed } };
  return {
    ...base,
    state: {
      kind: 'opened',
      ...signed,
      payload: opened.payload,
      versionId: record.metadataRevisionId,
      region: opened.region,
    },
  };
}

// Pin the authors of comments about to be opened, and work out the space's
// keys again if a wrap names a key version this app doesn't hold yet.
async function keysForServed(
  ctx: ClientContext,
  spaceId: SpaceId,
  served: readonly { comment: commentRoutes.ServedComment; audience: Audience }[],
) {
  const sealed = served.flatMap(({ comment, audience }) =>
    comment.sealed ? [{ ...comment.sealed, audience }] : [],
  );
  await pinAuthors(
    ctx,
    sealed.map(({ comment }) => comment.record),
  );
  return keysFor(
    ctx,
    spaceId,
    sealed.map(({ wrap, audience }) => ({ wrap, audienceClass: audience })),
  );
}

/**
 * The page's threads this person can read, each comment opened against the
 * region of the page's version on screen (decision 4), and when they last
 * marked its comments seen. A reply whose `threadAuthor` isn't its opened
 * first comment's signed author can't be opened (`binding-mismatch`).
 * `region` is the version's region they were checked against, which a
 * first comment is written in. Throws `ApiError` `not-found`
 * on a server without comments (decision 11), as for a page this person
 * can no longer read.
 */
export async function pageComments(
  ctx: ClientContext,
  page: CommentPage,
): Promise<{ threads: ShownThread[]; seenAt: string | null; region: Region }> {
  const { threads: listed, seenAt } = await ctx.api.call(commentRoutes.listComments, {
    params: { pageId: page.pageId },
  });
  const keys = await keysForServed(
    ctx,
    page.spaceId,
    listed.flatMap((t) =>
      [t.first, ...t.replies].map((comment) => ({ comment, audience: t.audience })),
    ),
  );
  let region = page.region;
  let threads = listed.map((t) => openThread(ctx, keys, { ...page, region }, t));
  const misplaced = threads.some((t) =>
    [t.first, ...t.replies].some(
      ({ state }) => state.kind === 'unreadable' && state.error.code === 'region-mismatch',
    ),
  );
  const now = misplaced ? await regionNow(ctx, page) : null;
  if (now && !sameRegion(now, region)) {
    region = now;
    threads = listed.map((t) => openThread(ctx, keys, { ...page, region }, t));
  }
  return { threads, seenAt, region };
}

/**
 * The region of the page's version on screen as it opens now, rather than
 * as this app remembers it from before a share or a move, or null without
 * that version.
 */
async function regionNow(ctx: ClientContext, page: CommentPage): Promise<Region | null> {
  if (!page.version) return null;
  const { revisionId, audience } = page.version;
  const opened = await openRevisions(ctx, page, audience, [revisionId], { fresh: true });
  return opened.get(revisionId)?.region ?? null;
}

function openThread(
  ctx: ClientContext,
  keys: Awaited<ReturnType<typeof keysFor>>,
  page: CommentPage,
  t: commentRoutes.Thread,
): ShownThread {
  // The comment heading a thread is that thread's first comment, or none of it opens as one.
  const first =
    t.first.commentId === t.thread
      ? shown(ctx, keys, page, t.first, { thread: null, audience: t.audience })
      : {
          commentId: t.first.commentId,
          createdAt: t.first.createdAt,
          editedAt: t.first.editedAt,
          state: {
            kind: 'unreadable' as const,
            authorId: t.first.authorId,
            error: new CryptoError('binding-mismatch', 'The thread is headed by another comment'),
          },
        };
  const replies = t.replies.map((reply) => {
    const opened = shown(ctx, keys, page, reply, { thread: t.thread, audience: t.audience });
    // Another person's question can't head answers someone else signed:
    // the first comment's author is signed whenever its record opened, in a
    // newer format too.
    if (
      opened.state.kind === 'opened' &&
      (first.state.kind === 'opened' || first.state.kind === 'newer-format') &&
      opened.state.payload.threadAuthor !== first.state.authorId
    ) {
      const error = new CryptoError('binding-mismatch', 'The reply answers another thread');
      return { ...opened, state: { kind: 'unreadable' as const, authorId: reply.authorId, error } };
    }
    return opened;
  });
  return {
    thread: t.thread,
    audience: t.audience,
    first,
    replies,
    resolved: t.resolved,
    beforeUnpublish: t.beforeUnpublish,
  };
}

/**
 * Seal and send one comment version, sealed afresh for each try in
 * `region`, which must be where the server's tree puts the page
 * (`region-mismatch`): under the space's keys worked out again when they
 * were out of date (`withFreshKeys`), and with the page's permission
 * version again after `permission-version`. A request whose answer was
 * lost is sent again with the same IDs, and `duplicate` then means the
 * first one arrived, as does `stale-head` for an edit whose version is the
 * comment's current one. `reopen` gives the region where the tree places
 * the page elsewhere, for one more try.
 */
async function writeVersion(
  ctx: ClientContext,
  {
    spaceId,
    pageId,
    region,
    commentId,
    basedOn,
    payload,
    check,
    reopen,
  }: {
    spaceId: SpaceId;
    pageId: PageId;
    region: Region;
    commentId: CommentId;
    basedOn: MetadataRevisionId | null;
    payload: CommentPayload;
    /** The payload as it may be sent at the permission version this try sends, checked again on each. */
    check?: (payload: CommentPayload) => Promise<CommentPayload>;
    /** The region as the version it goes by opens now, after a share or move. */
    reopen?: () => Promise<Region | null>;
  },
  send: (
    commit: ReturnType<typeof sealComment> & { permissionVersion: number },
  ) => Promise<unknown>,
): Promise<void> {
  const versionId = newId(MetadataRevisionId);
  let at = region;
  let lost = false;
  let reopened = false;
  // Whether this version is the comment's current one: an edit sent again
  // after a lost answer meets its own version as `stale-head`.
  const landed = async () => {
    const { threads } = await ctx.api.call(commentRoutes.listComments, { params: { pageId } });
    return threads.some((t) =>
      [t.first, ...t.replies].some(
        (c) =>
          c.commentId === commentId && c.sealed?.comment.record.metadataRevisionId === versionId,
      ),
    );
  };
  for (let tries = 0; ; tries++) {
    try {
      await withFreshKeys(ctx, spaceId, async (keys) => {
        const { share, permissionVersion } = await treeTarget(ctx, spaceId, pageId);
        const sealed = sealComment({
          author: ctx.identity,
          target: { installationId: ctx.installationId, spaceId, commentId, versionId, basedOn },
          payload: check ? await check(payload) : payload,
          ...keyTargetFor(ctx, keys, at, share),
        });
        await send({ ...sealed, permissionVersion });
      });
      return;
    } catch (error) {
      // The version on screen was opened before a share or move: open it
      // again, once, and write where it is now, as a draft save does.
      if (error instanceof CryptoError && error.code === 'region-mismatch' && reopen && !reopened) {
        reopened = true;
        const now = await reopen();
        if (now && !sameRegion(now, at)) {
          at = now;
          continue;
        }
      }
      if (!(error instanceof ApiError) || tries >= 3) throw error;
      if (lost && error.code === 'duplicate') return;
      if (lost && error.code === 'stale-head' && basedOn !== null && (await landed())) return;
      if (outcomeUnknown(error) || error.code === 'request-timeout') {
        lost = true;
        continue;
      }
      if (error.code !== 'permission-version') throw error;
    }
  }
}

/**
 * Whether readers can see version `revisionId` of the page now: it is
 * published since the page's latest unpublish (decision 1). Asked after the
 * permission version a write sends was read, so an unpublish since then
 * refuses the write (`permission-version`) and this is asked again.
 */
async function readersSee(ctx: ClientContext, pageId: PageId, revisionId: RevisionId) {
  const info = await ctx.api.call(pageRoutes.getPage, { params: { pageId } });
  if (info.heads.publishedHead === null) return false;
  // Readers are listed only their history; editors are told where it starts.
  const { versions } = await ctx.api.call(pageRoutes.history, { params: { pageId } });
  const version = versions.find((v) => v.revisionId === revisionId);
  return (
    !!version && (info.readerHistoryFrom === null || version.publishedSeq >= info.readerHistoryFrom)
  );
}

/**
 * Add a comment for `audience`, the view's (decision 1): a first comment
 * on the page, in the region of its version on screen, or a reply to a
 * thread whose first comment this app opened, taking its audience and its
 * signed author from it. Returns the new comment's ID.
 *
 * A first comment may be on a passage (`quote`, decision 5), from a
 * version of this page of its audience that this app opened. One for
 * readers names a version readers can see now: before every send, retries
 * included, a quote from a version an unpublish withdrew is dropped, and
 * `onQuoteDropped` is told.
 */
export async function addComment(
  ctx: ClientContext,
  page: CommentPage,
  {
    audience,
    text,
    reply = null,
    quote,
    onQuoteDropped,
  }: {
    audience: Audience;
    text: string;
    reply?: { thread: CommentId; threadAuthor: IdentityId } | null;
    quote?: CommentQuote | undefined;
    onQuoteDropped?: () => void;
  },
): Promise<CommentId> {
  const commentId = newId(CommentId);
  const passage = reply ? undefined : quote;
  let dropped = false;
  await writeVersion(
    ctx,
    {
      ...page,
      commentId,
      basedOn: null,
      payload: newCommentPayload({ pageId: page.pageId, audience, text, reply, quote: passage }),
      ...(passage &&
        audience === 'published' && {
          check: async (payload: CommentPayload) => {
            if (await readersSee(ctx, page.pageId, passage.revisionId)) return payload;
            dropped = true;
            const { quote: _dropped, ...rest } = payload;
            return rest;
          },
        }),
      reopen: () => regionNow(ctx, page),
    },
    ({ metadata, wrap, envelopes, permissionVersion }) =>
      ctx.api.call(commentRoutes.addComment, {
        params: { pageId: page.pageId },
        body: {
          commentId,
          thread: reply?.thread ?? null,
          audience,
          metadata,
          wrap,
          envelopes,
          permissionVersion,
        },
      }),
  );
  if (dropped) onQuoteDropped?.();
  return commentId;
}

/**
 * Its author edits a comment this app opened: a new version based on it,
 * with new text and everything else as it was, in the region of the
 * version it is based on (section 5.9), as it opens now if a share or move
 * rewrapped it since. Someone else's edit meanwhile is `stale-head`.
 */
export async function editComment(
  ctx: ClientContext,
  page: CommentPage,
  comment: { commentId: CommentId; state: Extract<ShownComment['state'], { kind: 'opened' }> },
  text: string,
): Promise<void> {
  const { state } = comment;
  if (state.authorId !== ctx.identity.public.id) {
    throw new ApiError(403, 'forbidden', 'Only its author edits a comment');
  }
  await writeVersion(
    ctx,
    {
      ...page,
      region: state.region,
      commentId: comment.commentId,
      basedOn: state.versionId,
      payload: revisedComment(state.payload, text),
      reopen: async () => {
        const { threads } = await pageComments(ctx, page);
        const now = threads
          .flatMap((t) => [t.first, ...t.replies])
          .find((c) => c.commentId === comment.commentId);
        return now?.state.kind === 'opened' && now.state.versionId === state.versionId
          ? now.state.region
          : null;
      },
    },
    (commit) =>
      ctx.api.call(commentRoutes.editComment, {
        params: { commentId: comment.commentId },
        body: commit,
      }),
  );
}

/** Delete a comment for good: its author's, or as an owner of the space, anyone's. */
export async function deleteComment(ctx: ClientContext, commentId: CommentId): Promise<void> {
  await ctx.api.call(commentRoutes.deleteComment, { params: { commentId } });
}

/** Resolve a thread, by its first comment, or open it again. */
export async function resolveThread(
  ctx: ClientContext,
  thread: CommentId,
  resolved: boolean,
): Promise<void> {
  await ctx.api.call(commentRoutes.resolveThread, {
    params: { commentId: thread },
    body: { resolved },
  });
}

/** Mark the page's comments seen now, on every device. */
export async function markSeen(ctx: ClientContext, pageId: PageId): Promise<void> {
  await ctx.api.call(commentRoutes.markSeen, { params: { pageId } });
}

/** One row of New comments: a thread with comments this person hasn't seen. */
export type NewComment = {
  spaceId: SpaceId;
  pageId: PageId;
  /** The page's title in the version this person sees. */
  title: string;
  thread: CommentId;
  audience: Audience;
  /** How many comments they haven't seen, and the newest of them, opened. */
  count: number;
  latest: ShownComment;
};

/** A space's pages as this person sees them, with the title and region of each one's version. */
type TreeOf = (spaceId: SpaceId) => Promise<{
  pages: readonly { id: PageId; title: string | null; region: Region | null }[];
}>;

/**
 * New comments (decision 8): threads with comments this person hasn't
 * seen, newest first. Each page's title comes from its version this person
 * sees, as the sidebar opens it (`treeOf`, the space's tree), and each
 * comment is checked against that version as decision 4 does. A page this
 * app can't open, or that its tree doesn't list, is left out.
 */
export async function newComments(
  ctx: ClientContext,
  treeOf: TreeOf = (spaceId) => loadTree(ctx, spaceId),
): Promise<NewComment[]> {
  const { threads } = await ctx.api.call(commentRoutes.newComments);
  const trees = new Map<SpaceId, ReturnType<TreeOf>>();
  const rows: NewComment[] = [];
  for (const row of threads) {
    let tree = trees.get(row.spaceId);
    if (!tree) trees.set(row.spaceId, (tree = treeOf(row.spaceId)));
    const listed = (await tree).pages.find((p) => p.id === row.pageId);
    if (!listed?.region || listed.title === null) continue;
    const page = { spaceId: row.spaceId, pageId: row.pageId, region: listed.region };
    const keys = await keysForServed(ctx, row.spaceId, [
      { comment: row.latest, audience: row.audience },
    ]);
    const latest = shown(ctx, keys, page, row.latest, {
      thread: row.latest.commentId === row.thread ? null : row.thread,
      audience: row.audience,
    });
    rows.push({
      spaceId: row.spaceId,
      pageId: row.pageId,
      title: listed.title,
      thread: row.thread,
      audience: row.audience,
      count: row.count,
      latest,
    });
  }
  return rows;
}

/**
 * The agents among comment authors, by ID, as section 9.5 names them:
 * the name the server has for each, and the person it acts for, kept only
 * when the agent's pinned keys make its ID with that person as owner.
 */
export async function agentAuthors(
  ctx: ClientContext,
  ids: readonly IdentityId[],
): Promise<Map<IdentityId, { name: string; personId: IdentityId | null }>> {
  const agents = ids.filter(isAgentId);
  if (agents.length === 0) return new Map();
  const { agents: listed } = await lookupDirectory(ctx, agents);
  const found = new Map<IdentityId, { name: string; personId: IdentityId | null }>();
  for (const { enrollment, name } of listed) {
    const { agent, ownerId } = enrollment;
    const ours =
      agentIdentityId({ installationId: ctx.installationId, ownerId, ...agent }) === agent.id;
    found.set(agent.id, { name, personId: ours ? ownerId : null });
  }
  return found;
}

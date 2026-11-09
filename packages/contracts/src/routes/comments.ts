// Comments on pages (protocol section 5.9, ADR 0014). New routes only:
// released apps parse existing answers strictly, so no answer gains a field.
import { z } from 'zod';
import { Timestamp } from '../records/encoding.ts';
import { CommentId, IdentityId, PageId, SpaceId } from '../records/ids.ts';
import { MetadataEnvelopeV2, SealedComment } from '../records/metadata.ts';
import { Audience } from '../records/revision.ts';
import { KeyWrap } from '../records/share.ts';
import type { RouteDef, StreamRouteDef } from '../route.ts';

/**
 * Bytes a comment version's sealed payload may hold, decoded: the largest
 * format 1.0 payload seals to about 64,100 bytes, so a later minor version
 * must stay within the rest (`payload-too-large`).
 */
export const MAX_PAYLOAD_BYTES = 65_536;

/** Characters of unpadded base64url that encode `MAX_PAYLOAD_BYTES`. */
export const MAX_PAYLOAD_CIPHERTEXT = Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3);

/**
 * A comment version and its content key, in its page's region (section
 * 6.8): one key wrap under the share's current key version with the
 * folder key of the comment's audience, or v2 metadata envelopes to every
 * owner outside shares.
 */
export const CommentCommit = {
  metadata: SealedComment,
  wrap: KeyWrap.nullable(),
  envelopes: z.array(MetadataEnvelopeV2).max(100),
  /** The page's permission version. */
  permissionVersion: z.number().int(),
};

/**
 * A comment's current version, as served to one person: with its wrap,
 * or their own envelopes, which may be none.
 */
export const SealedCommentVersion = z.strictObject({
  comment: SealedComment,
  wrap: KeyWrap.nullable(),
  envelopes: z.array(MetadataEnvelopeV2),
});
export type SealedCommentVersion = z.infer<typeof SealedCommentVersion>;

/**
 * One comment as the server has it. `authorId` and the times are the
 * server's; the app shows the record's signed author. `sealed` is null
 * only for a deleted first comment that still has replies.
 */
export const ServedComment = z.strictObject({
  commentId: CommentId,
  authorId: IdentityId,
  createdAt: Timestamp,
  editedAt: Timestamp.nullable(),
  sealed: SealedCommentVersion.nullable(),
});
export type ServedComment = z.infer<typeof ServedComment>;

/**
 * A thread: its first comment and its replies, oldest first, with the
 * audience and thread the server records for them, which the app checks
 * against what it opens. `beforeUnpublish` is true, for editors only,
 * for a thread for readers started before the page's latest unpublish:
 * readers no longer see it, and it takes no replies.
 */
export const Thread = z.strictObject({
  pageId: PageId,
  thread: CommentId,
  audience: Audience,
  first: ServedComment,
  replies: z.array(ServedComment),
  resolved: z.strictObject({ by: IdentityId, at: Timestamp }).nullable(),
  beforeUnpublish: z.boolean(),
});
export type Thread = z.infer<typeof Thread>;

const PageParams = z.object({ pageId: PageId });
const CommentParams = z.object({ commentId: CommentId });
const Ok = z.strictObject({ ok: z.literal(true) });

/**
 * The page's threads the caller can read (decision 1): comments for
 * readers to everyone who can read its published versions now, and to
 * readers only threads started since its latest unpublish; comments for
 * editors only to those who can edit the page. Threads and their replies
 * come oldest first; their order on screen is the app's (decision 6).
 * `seenAt` is when the caller last marked the page's comments seen, or null.
 */
export const listComments = {
  method: 'GET',
  path: '/api/pages/:pageId/comments',
  params: PageParams,
  response: z.strictObject({
    threads: z.array(Thread),
    seenAt: Timestamp.nullable(),
  }),
} as const satisfies RouteDef;

/**
 * Add a comment (section 5.9, **Writing**): a first comment (`thread`
 * null), or a reply to the first comment `thread`, of the same page and
 * the same `audience`, not deleted. The record is a comment's first
 * version for `commentId` (`invalid-request` otherwise). A comment or
 * version ID already taken, a metadata version's included, is `duplicate`,
 * which a request sent again after a lost answer gets too.
 */
export const addComment = {
  method: 'POST',
  path: '/api/pages/:pageId/comments',
  params: PageParams,
  body: z.object({
    commentId: CommentId,
    thread: CommentId.nullable(),
    audience: Audience,
    ...CommentCommit,
  }),
  response: z.strictObject({ commentId: CommentId }),
  status: 201,
} as const satisfies RouteDef;

/**
 * Its author edits a comment: a new version based on the current one
 * (`stale-head` otherwise), in the page's region now. The server keeps
 * only the new one. Not for agents.
 */
export const editComment = {
  method: 'PUT',
  path: '/api/comments/:commentId',
  params: CommentParams,
  body: z.object(CommentCommit),
  response: Ok,
} as const satisfies RouteDef;

/**
 * Delete a comment for good, with its key material: for its author (for
 * an agent's comment, the agent's person) while they can read it, or an
 * owner of the space, a page in the trash included. A first comment with
 * replies stays as deleted until its last reply goes. Not for agents.
 */
export const deleteComment = {
  method: 'DELETE',
  path: '/api/comments/:commentId',
  params: CommentParams,
  response: Ok,
} as const satisfies RouteDef;

/**
 * Resolve a thread, or open it again, by its first comment: for the
 * thread's starter (an agent's person) and the page's editors. A new
 * reply opens it again too. Not for agents.
 */
export const resolveThread = {
  method: 'POST',
  path: '/api/comments/:commentId/resolve',
  params: CommentParams,
  body: z.object({ resolved: z.boolean() }),
  response: Ok,
} as const satisfies RouteDef;

/** Mark the page's comments seen now, for the caller, on every device. */
export const markSeen = {
  method: 'POST',
  path: '/api/pages/:pageId/comments/seen',
  params: PageParams,
  response: Ok,
} as const satisfies RouteDef;

/**
 * New comments (decision 8): threads the caller can read with comments
 * from someone else they haven't seen, that concern them: threads they
 * started or replied to, and on pages they can edit, new threads. `count`
 * is how many such comments, and `latest` the newest, newest first.
 */
export const newComments = {
  method: 'GET',
  path: '/api/me/comments',
  response: z.strictObject({
    threads: z.array(
      z.strictObject({
        spaceId: SpaceId,
        pageId: PageId,
        thread: CommentId,
        audience: Audience,
        count: z.number().int().positive(),
        latest: ServedComment.extend({ sealed: SealedCommentVersion }),
      }),
    ),
  }),
} as const satisfies RouteDef;

/**
 * The pages where a comment the caller can read was added, edited,
 * deleted, resolved or opened again, about once a second at most. It never
 * says what changed. Blank lines keep it open, as the tree's stream does.
 */
export const commentChanges = {
  method: 'GET',
  path: '/api/me/comment-changes',
  event: z.strictObject({ pageIds: z.array(PageId).min(1) }),
} as const satisfies StreamRouteDef;

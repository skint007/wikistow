// Comments on pages (protocol section 5.9, ADR 0014). The server can't read
// a comment or open its key, so it checks what it can see, records the page,
// thread and audience a writer names, and serves each comment only to those
// who can read its audience on its page now.
import {
  commentRoutes,
  KeyWrap,
  MetadataEnvelopeV2,
  SealedComment,
  type Audience,
  type PublicIdentity,
} from '@wikistow/contracts';
import {
  hash,
  metadataEnvelopeV2Bytes,
  metadataRecordV2Bytes,
  sealedBytes,
  verifySignature,
} from '@wikistow/client';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { audit } from '../admin/audit.ts';
import { anyId } from '../db/any.ts';
import type { Database } from '../db/client.ts';
import {
  commentEnvelopes,
  comments,
  commentSeen,
  commentVersions,
  commentWraps,
  metadataRevisions,
  nodes,
  pageHeads,
  shareMembers,
  shares,
  spaceOwners,
} from '../db/schema/index.ts';
import { readSettings } from '../settings.ts';
import {
  accessTo,
  accessToPages,
  canEdit,
  isOwner,
  lockShare,
  lockSpace,
  readSnapshot,
  type Access,
  type ShareRow,
} from './access.ts';
import { ContentError } from './errors.ts';
import { humanActor, requireCaller, type Actor, type Caller } from './identities.ts';
import { checkKeyMaterial } from './key-material.ts';
import { requirePage, requirePageAccess } from './pages.ts';
import { charge } from './quota.ts';
import { readStored, type ReportUnreadable } from './stored.ts';

/** A comment version and its key material, as a write sends it. */
export type CommentCommit = {
  metadata: SealedComment;
  wrap: KeyWrap | null;
  envelopes: MetadataEnvelopeV2[];
  permissionVersion: number;
};

type CommentRow = typeof comments.$inferSelect;
type Heads = typeof pageHeads.$inferSelect;

/**
 * Whether `access` (with the page's heads) reads comments for `audience`
 * now, which writing, editing, an author's delete and resolving need too
 * (section 5.9, **Writing**): for editors, edit access; for readers, a
 * published page. A reader is `not-found` for a page they can't see
 * unpublished, as the page's route answers; anyone else lacking it is
 * `forbidden`. An agent writes for readers only where it can publish.
 */
function requireAudience(
  caller: Caller,
  access: Access,
  heads: Heads,
  audience: Audience,
  { writing }: { writing: boolean },
) {
  const editor = canEdit(access);
  if (audience === 'draft') {
    if (!editor) throw new ContentError('forbidden', 'Comments for editors are for editors');
    return;
  }
  if (heads.publishedHead === null) {
    throw editor
      ? new ContentError('forbidden', 'Comments for readers need the page to be published')
      : new ContentError('not-found');
  }
  if (writing && caller.personId !== null && !access.canPublish) {
    throw new ContentError('forbidden', 'An agent writes to readers only where it can publish');
  }
}

/**
 * Whether the person sees `row` at all: editors see every comment, and
 * readers those for readers in threads started since the page's latest
 * unpublish. A reply for readers is always in its thread's reader history,
 * since none is taken once the page is unpublished after its thread began.
 */
const sees = (editor: boolean, row: CommentRow, heads: Heads) =>
  editor || (row.audience === 'published' && row.readerHistoryFrom === heads.readerHistoryFrom);

async function headsOf(tx: Database, pageId: string): Promise<Heads> {
  const [heads] = await tx.select().from(pageHeads).where(eq(pageHeads.pageId, pageId));
  if (!heads) throw new ContentError('not-found');
  return heads;
}

/**
 * Everything the server can check about a comment version: a comment's
 * record of this space, signed by the caller over its payload, with the
 * key material of the page's region. It can't check the audience a wrap
 * opens under, nor the payload's page, thread or audience: the app that
 * opens the comment does.
 */
async function verifyCommentCommit(
  tx: Database,
  { metadata, wrap, envelopes }: CommentCommit,
  expected: { author: PublicIdentity; spaceId: string; share: ShareRow | null },
) {
  const { record, signature, payload } = metadata;
  const { installationId } = await readSettings(tx);
  if (record.installationId !== installationId || record.spaceId !== expected.spaceId) {
    throw new ContentError('binding-mismatch', 'The comment is for another space');
  }
  if (
    record.authorId !== expected.author.id ||
    record.authorKeyVersion !== expected.author.keyVersion
  ) {
    throw new ContentError('forbidden', 'Comments must be written by your own identity');
  }
  if (!verifySignature(expected.author, metadataRecordV2Bytes(record), signature)) {
    throw new ContentError('bad-signature', 'Comment signature is invalid');
  }
  if (hash(sealedBytes(payload)) !== record.payloadHash) {
    throw new ContentError('bad-signature', 'Comment ciphertext does not match its signed hash');
  }
  // Unpadded base64url: three bytes in every four characters.
  if (Math.floor((payload.ciphertext.length * 3) / 4) > commentRoutes.MAX_PAYLOAD_BYTES) {
    throw new ContentError('too-large', 'This comment is larger than a comment may hold');
  }
  await checkKeyMaterial(tx, {
    spaceId: expected.spaceId,
    share: expected.share,
    wrap,
    envelopes,
    author: expected.author,
    namesVersion: (e) => e.metadataRevisionId === record.metadataRevisionId,
    signedBytes: (e) => metadataEnvelopeV2Bytes(record, e),
  });
}

/**
 * A comment version ID is new: no comment version has it, nor any metadata
 * version (section 5.9). Names' versions check the other way (`storeMetadata`).
 */
async function requireNewVersionId(tx: Database, versionId: string) {
  const [comment] = await tx
    .select({ id: commentVersions.id })
    .from(commentVersions)
    .where(eq(commentVersions.id, versionId));
  const [name] = await tx
    .select({ id: metadataRevisions.id })
    .from(metadataRevisions)
    .where(eq(metadataRevisions.id, versionId));
  if (comment || name) throw new ContentError('duplicate', 'That version ID is taken');
}

/** Whether a comment version takes `versionId`, for names' versions to refuse it. */
export async function isCommentVersion(tx: Database, versionId: string) {
  const [taken] = await tx
    .select({ id: commentVersions.id })
    .from(commentVersions)
    .where(eq(commentVersions.id, versionId));
  return taken !== undefined;
}

/** Store a checked version of `commentId` with its wrap or envelopes, charged to its author. */
async function storeVersion(
  tx: Database,
  commentId: string,
  { metadata, wrap, envelopes }: CommentCommit,
  { accountId, storageBytes }: { accountId: string; storageBytes: number },
) {
  const versionId = metadata.record.metadataRevisionId;
  await charge(tx, accountId, metadata.payload.ciphertext.length, storageBytes);
  const stored = await tx
    .insert(commentVersions)
    .values({ id: versionId, commentId, spaceId: metadata.record.spaceId, sealed: metadata })
    .onConflictDoNothing()
    .returning({ id: commentVersions.id });
  if (stored.length === 0) throw new ContentError('duplicate', 'That version ID is taken');
  if (wrap) {
    await tx
      .insert(commentWraps)
      .values({ versionId, shareId: wrap.shareId, keyVersion: wrap.keyVersion, wrap });
  }
  if (envelopes.length > 0) {
    await tx.insert(commentEnvelopes).values(
      envelopes.map((envelope) => ({
        versionId,
        recipientIdentityId: envelope.recipientId,
        recipientKeyVersion: envelope.recipientKeyVersion,
        envelope,
      })),
    );
  }
}

/**
 * Add a comment (section 5.9, **Writing**), under the locks of a save: the
 * space, the share whose key it is wrapped under, and the page. The caller
 * reads the page for the comment's audience; the page's permission version
 * is current; the record is the first version of `commentId`
 * (`invalid-request`); the key material is that of the page's region at
 * its current key version; a reply's thread is a first comment of the
 * same page, for the same audience, not deleted, and for readers started
 * since the latest unpublish; the comment and version IDs are new
 * (`duplicate`); and the payload fits (`payload-too-large`). A reply opens
 * its thread again.
 */
export async function addComment(
  db: Database,
  input: {
    actor: Actor;
    pageId: string;
    commentId: string;
    thread: string | null;
    audience: Audience;
    storageBytes: number;
  } & CommentCommit,
): Promise<void> {
  const { record } = input.metadata;
  await db.transaction(async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    const access = await lockedAccess(tx, caller, input.pageId);
    const share = await lockShare(tx, access.share);
    const page = await requirePage(tx, input.pageId, { lock: true });
    const heads = await headsOf(tx, page.id);
    requireAudience(caller, access, heads, input.audience, { writing: true });
    if (page.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    if (record.subjectId !== input.commentId || record.basedOn !== null) {
      throw new ContentError('invalid-request', 'A new comment’s record is its first version');
    }
    await verifyCommentCommit(tx, input, {
      author: caller.identity,
      spaceId: page.spaceId,
      share,
    });
    if (input.thread !== null) {
      // Held, so the thread's first comment can't go meanwhile, and replies
      // to one thread, which may open it again, wait for each other.
      const [first] = await tx
        .select()
        .from(comments)
        .where(eq(comments.id, input.thread))
        .for('no key update');
      // A thread the caller doesn't see, as a reader an editors' one, isn't there for them.
      if (
        !first ||
        first.pageId !== page.id ||
        first.threadId !== null ||
        !sees(canEdit(access), first, heads)
      ) {
        throw new ContentError('not-found', 'There is no such thread on this page');
      }
      if (first.audience !== input.audience) {
        throw new ContentError('binding-mismatch', 'A reply takes its thread’s audience');
      }
      if (first.deletedAt !== null) {
        throw new ContentError('forbidden', 'That thread takes no new replies');
      }
      if (input.audience === 'published' && first.readerHistoryFrom !== heads.readerHistoryFrom) {
        throw new ContentError(
          'forbidden',
          'That thread was started before the page was unpublished',
        );
      }
    }
    await requireNewVersionId(tx, record.metadataRevisionId);
    const added = await tx
      .insert(comments)
      .values({
        id: input.commentId,
        spaceId: page.spaceId,
        pageId: page.id,
        threadId: input.thread,
        audience: input.audience,
        authorIdentityId: caller.identity.id,
        authorAccountId: caller.accountId,
        readerHistoryFrom: heads.readerHistoryFrom,
      })
      .onConflictDoNothing()
      .returning({ id: comments.id });
    if (added.length === 0) throw new ContentError('duplicate', 'That comment ID is taken');
    await storeVersion(tx, input.commentId, input, {
      accountId: caller.accountId,
      storageBytes: input.storageBytes,
    });
    if (input.thread !== null) {
      await tx
        .update(comments)
        .set({ resolvedAt: null, resolvedBy: null })
        .where(and(eq(comments.id, input.thread), isNotNull(comments.resolvedAt)));
    }
  });
}

// The caller's access to a page, the space held first as every write holds it.
async function lockedAccess(tx: Database, caller: Caller, pageId: string) {
  const page = await requirePage(tx, pageId);
  await lockSpace(tx, page.spaceId);
  return requirePageAccess(tx, caller, page);
}

// Agents add comments but act on none, their own included (section 9.5).
function requirePerson(caller: Caller) {
  if (caller.personId !== null) {
    throw new ContentError('forbidden', 'Agents don’t edit, delete or resolve comments');
  }
}

// A comment that isn't deleted, for a person, or `not-found`.
async function heldComment(tx: Database, caller: Caller, commentId: string) {
  requirePerson(caller);
  const [found] = await tx.select().from(comments).where(eq(comments.id, commentId));
  if (!found || found.deletedAt !== null) throw new ContentError('not-found');
  return found;
}

/**
 * Its author edits a comment: a new version based on its current one
 * (`stale-head` otherwise), checked as a new comment is, in the page's
 * region now. The thread and audience stay as recorded. The old version
 * goes, with its key material.
 */
export async function editComment(
  db: Database,
  input: { actor: Actor; commentId: string; storageBytes: number } & CommentCommit,
): Promise<void> {
  const { record } = input.metadata;
  await db.transaction(async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    const row = await heldComment(tx, caller, input.commentId);
    const access = await lockedAccess(tx, caller, row.pageId);
    const share = await lockShare(tx, access.share);
    const page = await requirePage(tx, row.pageId, { lock: true });
    const heads = await headsOf(tx, page.id);
    requireAudience(caller, access, heads, row.audience, { writing: true });
    if (!sees(canEdit(access), row, heads)) throw new ContentError('not-found');
    // Held before its version, as a delete holds it.
    const [held] = await tx.select().from(comments).where(eq(comments.id, row.id)).for('update');
    if (!held || held.deletedAt !== null) throw new ContentError('not-found');
    if (row.authorIdentityId !== caller.identity.id) {
      throw new ContentError('forbidden', 'Only its author edits a comment');
    }
    if (page.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    if (record.subjectId !== row.id || record.basedOn === null) {
      throw new ContentError(
        'invalid-request',
        'An edit is based on the comment’s current version',
      );
    }
    const [current] = await tx
      .select({ id: commentVersions.id })
      .from(commentVersions)
      .where(eq(commentVersions.commentId, row.id))
      .for('update');
    if (!current) throw new ContentError('not-found');
    if (record.basedOn !== current.id) {
      throw new ContentError('stale-head', 'The comment changed since you loaded it');
    }
    await verifyCommentCommit(tx, input, {
      author: caller.identity,
      spaceId: page.spaceId,
      share,
    });
    await requireNewVersionId(tx, record.metadataRevisionId);
    // Its wrap and envelopes go with it, by the cascade.
    await tx.delete(commentVersions).where(eq(commentVersions.id, current.id));
    await storeVersion(tx, row.id, input, {
      accountId: caller.accountId,
      storageBytes: input.storageBytes,
    });
    await tx
      .update(comments)
      .set({ editedAt: sql`now()` })
      .where(eq(comments.id, row.id));
  });
}

/**
 * Delete a comment for good, with its key material: for its author (the
 * person of an agent that wrote it) while they read its audience on the
 * page still, or for an owner of the space, a page in the trash included.
 * A first comment with replies stays, marked deleted, until its last reply
 * goes. An owner's delete of someone else's comment is audited, by ID.
 */
export async function deleteComment(
  db: Database,
  input: { actor: Actor; commentId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    const found = await heldComment(tx, caller, input.commentId);
    await lockSpace(tx, found.spaceId);
    const owner = await isOwner(tx, caller.identity.id, found.spaceId);
    const author = found.authorAccountId === caller.accountId;
    if (!owner) {
      const access = await requirePageAccess(tx, caller, await requirePage(tx, found.pageId));
      const heads = await headsOf(tx, found.pageId);
      requireAudience(caller, access, heads, found.audience, { writing: false });
      if (!sees(canEdit(access), found, heads)) throw new ContentError('not-found');
      if (!author) throw new ContentError('forbidden', 'Only its author or an owner deletes it');
    }
    // Held, so a reply can't arrive under a first comment as it goes.
    const [row] = await tx.select().from(comments).where(eq(comments.id, found.id)).for('update');
    if (!row || row.deletedAt !== null) throw new ContentError('not-found');
    await tx.delete(commentVersions).where(eq(commentVersions.commentId, row.id));
    if (row.threadId === null) {
      const [reply] = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.threadId, row.id))
        .limit(1);
      if (reply) {
        await tx
          .update(comments)
          .set({ deletedAt: sql`now()` })
          .where(eq(comments.id, row.id));
      } else {
        await tx.delete(comments).where(eq(comments.id, row.id));
      }
    } else {
      await tx.delete(comments).where(eq(comments.id, row.id));
      // A deleted first comment goes with its last reply.
      await tx.execute(sql`
        delete from ${comments} t
        where t.id = ${row.threadId} and t.deleted_at is not null
          and not exists (select 1 from ${comments} r where r.thread_id = t.id)`);
    }
    if (owner && !author) {
      await audit(tx, {
        actor: caller.accountId,
        action: 'comment.deleted',
        target: { kind: 'comment', id: row.id },
        details: { spaceId: row.spaceId, pageId: row.pageId, authorId: row.authorIdentityId },
      });
    }
  });
}

/**
 * Resolve a thread or open it again, by its first comment: for the
 * thread's starter (an agent's person), or anyone who edits the page,
 * while they read its audience there. Server state, unsigned (Q13).
 */
export async function resolveThread(
  db: Database,
  input: { actor: Actor; commentId: string; resolved: boolean },
): Promise<void> {
  await db.transaction(async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    requirePerson(caller);
    // A thread whose first comment was deleted resolves still.
    const [row] = await tx.select().from(comments).where(eq(comments.id, input.commentId));
    if (!row || row.threadId !== null) throw new ContentError('not-found');
    const access = await lockedAccess(tx, caller, row.pageId);
    const heads = await headsOf(tx, row.pageId);
    requireAudience(caller, access, heads, row.audience, { writing: false });
    if (!sees(canEdit(access), row, heads)) throw new ContentError('not-found');
    if (row.authorAccountId !== caller.accountId && !canEdit(access)) {
      throw new ContentError('forbidden', 'Its starter or an editor resolves a thread');
    }
    if ((row.resolvedAt !== null) === input.resolved) return;
    await tx
      .update(comments)
      .set(
        input.resolved
          ? { resolvedAt: sql`now()`, resolvedBy: caller.identity.id }
          : { resolvedAt: null, resolvedBy: null },
      )
      .where(eq(comments.id, row.id));
  });
}

/** Mark a page's comments seen now, for a person who can read the page. */
export async function markSeen(db: Database, input: { accountId: string; pageId: string }) {
  const caller = await requireCaller(db, humanActor(input.accountId));
  await requirePageAccess(db, caller, await requirePage(db, input.pageId));
  await db
    .insert(commentSeen)
    .values({ accountId: input.accountId, pageId: input.pageId })
    .onConflictDoUpdate({
      target: [commentSeen.accountId, commentSeen.pageId],
      set: { seenAt: sql`now()` },
    });
}

type Served = commentRoutes.SealedCommentVersion;

/**
 * The current versions of `versionIds`, each with its wrap, or else the
 * caller's own envelopes at their current key, which may be none. A
 * stored version the current schemas refuse is left out and reported.
 */
async function servedVersions(
  db: Database,
  identity: PublicIdentity,
  versionIds: readonly string[],
  report: ReportUnreadable,
): Promise<Map<string, Served>> {
  const out = new Map<string, Served>();
  if (versionIds.length === 0) return out;
  const versions = await db
    .select({ id: commentVersions.id, sealed: commentVersions.sealed })
    .from(commentVersions)
    .where(anyId(commentVersions.id, versionIds));
  const wraps = new Map(
    (
      await db
        .select({ id: commentWraps.versionId, wrap: commentWraps.wrap })
        .from(commentWraps)
        .where(anyId(commentWraps.versionId, versionIds))
    ).map((row) => [row.id, row.wrap]),
  );
  const envelopes = Map.groupBy(
    await db
      .select({ id: commentEnvelopes.versionId, envelope: commentEnvelopes.envelope })
      .from(commentEnvelopes)
      .where(
        and(
          anyId(commentEnvelopes.versionId, versionIds),
          eq(commentEnvelopes.recipientIdentityId, identity.id),
          eq(commentEnvelopes.recipientKeyVersion, identity.keyVersion),
        ),
      ),
    (row) => row.id,
  );
  for (const version of versions) {
    const row = { table: 'comment_versions', id: version.id };
    const served = readStored(
      commentRoutes.SealedCommentVersion,
      {
        comment: version.sealed,
        wrap: wraps.get(version.id) ?? null,
        envelopes: (envelopes.get(version.id) ?? []).map((e) => e.envelope),
      },
      row,
      report,
    );
    if (served) out.set(version.id, served);
  }
  return out;
}

const iso = (date: Date | null) => date?.toISOString() ?? null;

/**
 * The page's threads the caller reads (section 5.9, **Serving**), with each
 * comment's current version and key material, and when the caller last
 * marked them seen. Readers get only threads for readers started since the
 * page's latest unpublish, and nothing while it is unpublished; editors,
 * every thread. A deleted first comment comes without its version while it
 * still has replies.
 */
export async function listComments(
  db: Database,
  actor: Actor,
  pageId: string,
  report: ReportUnreadable,
) {
  return readSnapshot(db, async (tx) => {
    const caller = await requireCaller(tx, actor);
    const page = await requirePage(tx, pageId);
    const access = await requirePageAccess(tx, caller, page);
    const heads = await headsOf(tx, page.id);
    const editor = canEdit(access);
    if (!editor && heads.publishedHead === null) throw new ContentError('not-found');
    const rows = await tx
      .select({ comment: comments, versionId: commentVersions.id })
      .from(comments)
      .leftJoin(commentVersions, eq(commentVersions.commentId, comments.id))
      .where(eq(comments.pageId, page.id))
      .orderBy(asc(comments.createdAt), asc(comments.id));
    const shown = rows.filter(({ comment }) => sees(editor, comment, heads));
    const versions = await servedVersions(
      tx,
      caller.identity,
      shown.flatMap(({ versionId }) => (versionId ? [versionId] : [])),
      report,
    );
    const served = new Map(
      shown.flatMap(({ comment, versionId }) => {
        const sealed = versionId ? versions.get(versionId) : undefined;
        // Unreadable when stored, so left out; a deleted one has no version.
        if (versionId && !sealed) return [];
        const item = {
          commentId: comment.id,
          authorId: comment.authorIdentityId,
          createdAt: comment.createdAt.toISOString(),
          editedAt: iso(comment.editedAt),
          sealed: sealed ?? null,
        };
        return [[comment.id, { row: comment, item }] as const];
      }),
    );
    const replies = Map.groupBy(
      [...served.values()].filter(({ row }) => row.threadId !== null),
      ({ row }) => row.threadId,
    );
    const threads = [...served.values()].flatMap(({ row, item }) => {
      if (row.threadId !== null) return [];
      const under = (replies.get(row.id) ?? []).map((reply) => reply.item);
      if (item.sealed === null && under.length === 0) return [];
      return [
        {
          pageId: page.id,
          thread: row.id,
          audience: row.audience,
          first: item,
          replies: under,
          resolved:
            row.resolvedAt && row.resolvedBy
              ? { by: row.resolvedBy, at: row.resolvedAt.toISOString() }
              : null,
          beforeUnpublish:
            editor &&
            row.audience === 'published' &&
            row.readerHistoryFrom !== heads.readerHistoryFrom,
        },
      ];
    });
    const [seen] =
      caller.personId === null
        ? await tx
            .select({ at: commentSeen.seenAt })
            .from(commentSeen)
            .where(
              and(eq(commentSeen.accountId, caller.accountId), eq(commentSeen.pageId, page.id)),
            )
        : [];
    return { threads, seenAt: iso(seen?.at ?? null) };
  });
}

/** How many threads **New comments** lists at most, newest first. */
const NEW_THREADS = 100;

/**
 * **New comments** (decision 8): for a person, threads they can read with
 * comments from someone else they haven't seen, which concern them:
 * threads they started or replied to, and, on pages they can edit, threads
 * started since they last opened the page's comments. A comment's author
 * is its account: an agent's comments are its person's own.
 */
export async function newComments(db: Database, accountId: string, report: ReportUnreadable) {
  return readSnapshot(db, async (tx) => {
    const caller = await requireCaller(tx, humanActor(accountId));
    const me = caller.identity.id;
    // Spaces the person has a place in, as owner or member.
    const owned = tx
      .select({ id: spaceOwners.spaceId })
      .from(spaceOwners)
      .where(and(eq(spaceOwners.identityId, me), isNull(spaceOwners.removedAt)));
    const member = tx
      .select({ id: shares.spaceId })
      .from(shareMembers)
      .innerJoin(shares, eq(shares.id, shareMembers.shareId))
      .where(eq(shareMembers.identityId, me));
    const rows = [
      ...(await tx.execute<{
        id: string;
        space_id: string;
        page_id: string;
        thread: string;
        audience: Audience;
        author_identity_id: string;
        reader_history_from: number;
        created_at: Date | string;
        edited_at: Date | string | null;
        version_id: string;
        concerns: boolean;
      }>(sql`
        select c.id, c.space_id, c.page_id, coalesce(c.thread_id, c.id) as thread,
          c.audience, c.author_identity_id, c.reader_history_from, c.created_at, c.edited_at,
          v.id as version_id,
          (t.author_account_id = ${accountId} or exists (
            select 1 from ${comments} r where r.thread_id = t.id and r.author_account_id = ${accountId}
          )) as concerns
        from ${comments} c
        join ${commentVersions} v on v.comment_id = c.id
        join ${comments} t on t.id = coalesce(c.thread_id, c.id)
        left join ${commentSeen} s on s.account_id = ${accountId} and s.page_id = c.page_id
        where c.author_account_id is distinct from ${accountId}
          and (s.seen_at is null or c.created_at > s.seen_at)
          and (c.space_id in (${owned}) or c.space_id in (${member}))
          and (c.thread_id is null or t.author_account_id = ${accountId} or exists (
            select 1 from ${comments} r where r.thread_id = t.id and r.author_account_id = ${accountId}
          ))
        order by c.created_at desc, c.id desc
        limit 2000`)),
    ];
    const kept: typeof rows = [];
    for (const [spaceId, inSpace] of Map.groupBy(rows, (row) => row.space_id)) {
      const pageIds = [...new Set(inSpace.map((row) => row.page_id))];
      const access = await accessToPages(tx, caller, spaceId, pageIds);
      const heads = new Map(
        (await tx.select().from(pageHeads).where(anyId(pageHeads.pageId, pageIds))).map((h) => [
          h.pageId,
          h,
        ]),
      );
      for (const row of inSpace) {
        const at = access.get(row.page_id) ?? null;
        const head = heads.get(row.page_id);
        if (!at || !head) continue;
        const editor = canEdit(at);
        const readable =
          editor ||
          (row.audience === 'published' &&
            head.publishedHead !== null &&
            row.reader_history_from === head.readerHistoryFrom);
        // A new thread concerns only those who edit its page.
        if (readable && (row.concerns || editor)) kept.push(row);
      }
    }
    // Newest first across spaces, as the query had them before they were split by space.
    const time = (row: (typeof rows)[number]) => new Date(row.created_at).getTime();
    kept.sort((a, b) => time(b) - time(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const byThread = Map.groupBy(kept, (row) => row.thread);
    const newest = [...byThread.values()]
      .map((thread) => ({ thread, latest: thread[0] }))
      .flatMap(({ thread, latest }) => (latest ? [{ thread, latest }] : []))
      .slice(0, NEW_THREADS);
    const versions = await servedVersions(
      tx,
      caller.identity,
      newest.map(({ latest }) => latest.version_id),
      report,
    );
    const at = (value: Date | string) => new Date(value).toISOString();
    return newest.flatMap(({ thread, latest }) => {
      const sealed = versions.get(latest.version_id);
      if (!sealed) return [];
      return [
        {
          spaceId: latest.space_id,
          pageId: latest.page_id,
          thread: latest.thread,
          audience: latest.audience,
          count: thread.length,
          latest: {
            commentId: latest.id,
            authorId: latest.author_identity_id,
            createdAt: at(latest.created_at),
            editedAt: latest.edited_at === null ? null : at(latest.edited_at),
            sealed,
          },
        },
      ];
    });
  });
}

/**
 * Which of the changed comments' pages a person can read the changed
 * comment on now (decision 8), for the comment changes stream: by its
 * audience, and for readers by the reader history it was made in.
 */
export async function commentChangesSeenBy(
  db: Database,
  accountId: string,
  changes: readonly { pageId: string; audience: Audience; readerHistoryFrom: number }[],
): Promise<Set<string>> {
  const seen = new Set<string>();
  const caller = await requireCaller(db, humanActor(accountId)).catch(() => null);
  if (!caller) return seen;
  for (const change of changes) {
    if (seen.has(change.pageId)) continue;
    const [page] = await db
      .select({ id: nodes.id, spaceId: nodes.spaceId })
      .from(nodes)
      .where(and(eq(nodes.id, change.pageId), eq(nodes.kind, 'page')));
    const access = page && (await accessTo(db, caller, { spaceId: page.spaceId, nodeId: page.id }));
    const [heads] = page
      ? await db.select().from(pageHeads).where(eq(pageHeads.pageId, page.id))
      : [];
    if (!access || !heads) continue;
    const readable =
      canEdit(access) ||
      (change.audience === 'published' &&
        heads.publishedHead !== null &&
        change.readerHistoryFrom === heads.readerHistoryFrom);
    if (readable) seen.add(change.pageId);
  }
  return seen;
}

/** The current versions of the comments on `pageIds`, by version ID. */
export async function commentsOn(tx: Database, spaceId: string, pageIds: readonly string[]) {
  if (pageIds.length === 0) return [];
  const rows = await tx
    .select({ id: commentVersions.id })
    .from(commentVersions)
    .innerJoin(comments, eq(comments.id, commentVersions.commentId))
    .where(and(eq(comments.spaceId, spaceId), anyId(comments.pageId, pageIds)));
  return rows.map((row) => row.id);
}

/**
 * The current versions of comments with key material in one region of the
 * space, but on a copy's hidden pages: wrapped under share `shareId`, or
 * for `null` with no wrap, the owner region's. By key material, so pages
 * in the trash count.
 */
export async function commentsInRegion(tx: Database, spaceId: string, shareId: string | null) {
  const rows = await tx
    .select({ id: commentVersions.id })
    .from(commentVersions)
    .innerJoin(comments, eq(comments.id, commentVersions.commentId))
    .innerJoin(nodes, eq(nodes.id, comments.pageId))
    .leftJoin(commentWraps, eq(commentWraps.versionId, commentVersions.id))
    .where(
      and(
        eq(comments.spaceId, spaceId),
        isNull(nodes.copyId),
        shareId === null ? isNull(commentWraps.versionId) : eq(commentWraps.shareId, shareId),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Scan entries of kind `comment` (section 5.9): each current version whole,
 * with the caller's key material and the page, thread and audience the
 * server records, which the owner's app checks against what it opens.
 */
export async function scannedComments(
  db: Database,
  identity: PublicIdentity,
  versionIds: readonly string[],
  report: ReportUnreadable,
) {
  const out = new Map<
    string,
    Served & { kind: 'comment'; pageId: string; thread: string | null; audience: Audience }
  >();
  if (versionIds.length === 0) return out;
  const served = await servedVersions(db, identity, versionIds, report);
  const rows = await db
    .select({
      versionId: commentVersions.id,
      pageId: comments.pageId,
      thread: comments.threadId,
      audience: comments.audience,
    })
    .from(commentVersions)
    .innerJoin(comments, eq(comments.id, commentVersions.commentId))
    .where(anyId(commentVersions.id, versionIds));
  for (const { versionId, ...place } of rows) {
    const version = served.get(versionId);
    if (version) out.set(versionId, { kind: 'comment', ...version, ...place });
  }
  return out;
}

/** The byte sizes of comment versions, for a scan's parts. */
export async function commentSizes(db: Database, versionIds: readonly string[]) {
  if (versionIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ id: commentVersions.id, size: commentVersions.payloadSize })
    .from(commentVersions)
    .where(inArray(commentVersions.id, [...versionIds]));
  return new Map(rows.map((row) => [row.id, row.size]));
}

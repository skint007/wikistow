import {
  KeyEnvelopeV2,
  pageRoutes,
  RevisionId,
  RevisionRecord,
  RevisionRecordV2,
  SealedRevision,
  SealedRevisionV2,
  structureRoutes,
  type Audience,
  type KeyWrap,
  type PublicIdentity,
} from '@wikistow/contracts';
import {
  hash,
  keyEnvelopeV2Bytes,
  revisionRecordV2Bytes,
  sealedBytes,
  verifySignature,
} from '@wikistow/client';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { BlobTooLarge, type BlobStore, type StagedBlob } from '../blobs/store.ts';
import { anyId } from '../db/any.ts';
import type { Database } from '../db/client.ts';
import { transactOnce, type Once } from '../idempotency.ts';
import {
  agentEdits,
  agentProfiles,
  blobs,
  identities,
  keyEnvelopes,
  metadataRevisions,
  nodes,
  pageHeads,
  publications,
  revisionBlobs,
  revisions,
  revisionWraps,
  spaces,
  users,
} from '../db/schema/index.ts';
import { readSettings } from '../settings.ts';
import {
  accessTo,
  accessToPages,
  canEdit,
  isHidden,
  isOwner,
  lockShare,
  lockSpace,
  lockSpaceOf,
  pathUp,
  readSnapshot,
  requireRoom,
  shareAt,
  type Access,
  type Holder,
  type ShareRow,
} from './access.ts';
import { ContentError } from './errors.ts';
import { DEFAULT_CONTENT_LIMITS, requireCapacity } from './limits.ts';
import { currentIdentity, requireCaller, type Actor } from './identities.ts';
import { checkKeyMaterial } from './key-material.ts';
import { charge, usedBytes } from './quota.ts';
import { copyUploadAccess, sweepCopies } from './copies.ts';
import { endPublicationsFrom } from './publications.ts';
import { endCopies, endLinkFor, endLinks } from '../public-links/endings.ts';
import { revisionKeyMaterial } from './serving.ts';
import { readStored, type ReportUnreadable } from './stored.ts';

/**
 * A new page version and its content key: a key wrap in a share, or
 * envelopes to the owners outside one (protocol section 6.8).
 */
export type RevisionCommit = {
  revision: SealedRevisionV2;
  envelopes: KeyEnvelopeV2[];
  wrap: KeyWrap | null;
  /** Hashes of every blob the revision's attachments use; the server can't read the payload. */
  blobRefs: string[];
  permissionVersion: number;
};

async function requireIdentity(db: Database, accountId: string): Promise<PublicIdentity> {
  const identity = await currentIdentity(db, accountId);
  if (!identity) throw new ContentError('vault-missing', 'Set up your vault first');
  return identity;
}

/**
 * The page's node row. Writers hold it `FOR SHARE` for their transaction, so
 * a delete or a change of access (which bumps its permission version) waits
 * for them, or they wait for it and see the result.
 */
export async function requirePage(db: Database, pageId: string, { lock = false } = {}) {
  const query = db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, pageId), eq(nodes.kind, 'page')));
  const [page] = lock ? await query.for('share') : await query;
  if (!page) throw new ContentError('not-found');
  return page;
}

/** Access to a page, or not-found: readers can't see pages that were never published. */
export async function requirePageAccess(
  db: Database,
  who: Holder,
  page: { id: string; spaceId: string },
) {
  const access = await accessTo(db, who, { spaceId: page.spaceId, nodeId: page.id });
  if (!access) throw new ContentError('not-found');
  return access;
}

// Stable comparison for idempotent replays: jsonb doesn't keep key order.
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

/**
 * A retry of a revision that was already stored is answered as a replay
 * (the client-made revision ID is the idempotency key). The same ID with
 * different content is refused.
 */
export async function replayed(
  tx: Database,
  revision: SealedRevisionV2,
  expected: { pageId: string; audience: Audience },
): Promise<boolean> {
  const [existing] = await tx
    .select({ sealed: revisions.sealed, pageId: revisions.pageId, audience: revisions.audience })
    .from(revisions)
    .where(eq(revisions.id, revision.record.revisionId));
  if (!existing) return false;
  // Only the same request again counts: same content, page, and kind of write.
  const same =
    existing.pageId === expected.pageId &&
    existing.audience === expected.audience &&
    stable(existing.sealed) === stable(revision);
  if (same) return true;
  throw new ContentError('duplicate', 'That revision ID is taken');
}

/**
 * Everything the server can check about a new page version: a v2 record,
 * bound to this page and audience, signed by the caller, built on the
 * current head, with the key material of the page's region.
 */
export async function verifyRevisionCommit(
  tx: Database,
  { revision, envelopes, wrap }: RevisionCommit,
  expected: {
    author: PublicIdentity;
    spaceId: string;
    pageId: string;
    audience: Audience;
    basedOn: string | null;
    share: ShareRow | null;
    /** The page's heads, which a stale base is refused with: the caller can edit there. */
    heads: { draftHead: string | null; publishedHead: string | null } | null;
  },
) {
  const { record, signature, payload } = revision;
  const { installationId } = await readSettings(tx);
  const bound =
    record.installationId === installationId &&
    record.spaceId === expected.spaceId &&
    record.pageId === expected.pageId &&
    record.audience === expected.audience;
  if (!bound)
    throw new ContentError('binding-mismatch', 'Revision describes another page or audience');
  if (
    record.authorId !== expected.author.id ||
    record.authorKeyVersion !== expected.author.keyVersion
  ) {
    throw new ContentError('forbidden', 'Revisions must be written by your own identity');
  }
  if (record.basedOn !== expected.basedOn)
    throw new ContentError(
      'stale-head',
      'The page changed since you loaded it',
      expected.heads ?? undefined,
    );
  if (!verifySignature(expected.author, revisionRecordV2Bytes(record), signature)) {
    throw new ContentError('bad-signature', 'Revision signature is invalid');
  }
  if (hash(sealedBytes(payload)) !== record.payloadHash) {
    throw new ContentError('bad-signature', 'Revision ciphertext does not match its signed hash');
  }
  await checkKeyMaterial(tx, {
    spaceId: expected.spaceId,
    share: expected.share,
    wrap,
    envelopes,
    author: expected.author,
    namesVersion: (e) => e.revisionId === record.revisionId,
    signedBytes: (e) => keyEnvelopeV2Bytes(record, e),
  });
}

/**
 * Link a revision to the blobs it declares. Each must belong to this page and
 * audience, and a staged upload only counts for the person who uploaded it.
 */
async function attachBlobs(
  tx: Database,
  {
    revisionId,
    pageId,
    audience,
    accountId,
    blobRefs,
  }: {
    revisionId: string;
    pageId: string;
    audience: Audience;
    accountId: string;
    blobRefs: string[];
  },
) {
  const refs = [...new Set(blobRefs)];
  if (refs.length === 0) return;
  // Held until commit, so the sweep can't remove a staged blob being attached.
  const rows = await tx
    .select()
    .from(blobs)
    .where(inArray(blobs.hash, refs))
    .orderBy(blobs.hash)
    .for('share');
  const usable = rows.filter(
    (b) =>
      b.pageId === pageId &&
      b.audience === audience &&
      (b.state === 'committed' || b.uploadedBy === accountId),
  );
  if (usable.length !== refs.length)
    throw new ContentError('missing-blob', 'An attachment was not uploaded for this page');
  await tx.insert(revisionBlobs).values(refs.map((blobHash) => ({ revisionId, blobHash })));
  await tx
    .update(blobs)
    .set({ state: 'committed', committedAt: sql`now()` })
    .where(and(inArray(blobs.hash, refs), eq(blobs.state, 'staged')));
}

export async function storeRevision(
  tx: Database,
  commit: RevisionCommit,
  {
    accountId,
    draftSeq,
    publishedSeq,
    restoredFrom,
    sourceRevisionId = null,
    storageBytes,
  }: {
    accountId: string;
    draftSeq: number | null;
    publishedSeq: number | null;
    restoredFrom: string | null;
    sourceRevisionId?: string | null;
    /** The account's storage, or null when the caller charged this version already. */
    storageBytes: number | null;
  },
) {
  const { record } = commit.revision;
  // The plaintext's limit, as the server can count it. Versions stored before stay.
  if (commit.revision.payload.ciphertext.length > pageRoutes.MAX_PAYLOAD_CIPHERTEXT)
    throw new ContentError('too-large', 'This version is larger than a page may hold');
  if (storageBytes !== null) {
    await charge(tx, accountId, commit.revision.payload.ciphertext.length, storageBytes);
  }
  await tx.insert(revisions).values({
    id: record.revisionId,
    pageId: record.pageId,
    spaceId: record.spaceId,
    audience: record.audience,
    basedOn: record.basedOn,
    authorIdentityId: record.authorId,
    authorKeyVersion: record.authorKeyVersion,
    authorAccountId: accountId,
    sealed: commit.revision,
    payloadSize: commit.revision.payload.ciphertext.length,
    draftSeq,
    publishedSeq,
    restoredFrom,
    sourceRevisionId,
  });
  // An agent's latest edit of the page, kept when draft retention removes the version.
  await tx.execute(sql`
    insert into ${agentEdits} (agent_id, page_id, revision_id, audience)
    select agent_id, ${record.pageId}, ${record.revisionId}, ${record.audience}
    from ${agentProfiles} where agent_id = ${record.authorId}
    on conflict (agent_id, page_id) do update set revision_id = excluded.revision_id,
      audience = excluded.audience, created_at = excluded.created_at`);
  if (commit.envelopes.length > 0) {
    await tx.insert(keyEnvelopes).values(
      commit.envelopes.map((envelope) => ({
        subjectKind: 'revision' as const,
        subjectId: record.revisionId,
        recipientIdentityId: envelope.recipientId,
        recipientKeyVersion: envelope.recipientKeyVersion,
        envelope,
      })),
    );
  }
  if (commit.wrap) {
    await tx.insert(revisionWraps).values({
      revisionId: record.revisionId,
      shareId: commit.wrap.shareId,
      keyVersion: commit.wrap.keyVersion,
      wrap: commit.wrap,
    });
  }
  await attachBlobs(tx, {
    revisionId: record.revisionId,
    pageId: record.pageId,
    audience: record.audience,
    accountId,
    blobRefs: commit.blobRefs,
  });
}

/** A new page under a folder (or the space root), with its first draft. */
export async function createPage(
  db: Database,
  input: {
    actor: Actor;
    spaceId: string;
    pageId: string;
    maxPages?: number;
    parentId: string | null;
    storageBytes: number;
    once?: Once | undefined;
  } & RevisionCommit,
) {
  return transactOnce(db, input.once, async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    const { identity } = caller;
    await lockSpace(tx, input.spaceId);
    const access = await accessTo(tx, caller, {
      spaceId: input.spaceId,
      nodeId: input.parentId,
    });
    if (!access) throw new ContentError('not-found');
    if (!canEdit(access)) throw new ContentError('forbidden');
    const share = await lockShare(tx, access.share);
    const parent =
      input.parentId === null
        ? (
            await tx
              .select({ permissionVersion: spaces.permissionVersion })
              .from(spaces)
              .where(eq(spaces.id, input.spaceId))
              .for('no key update')
          )[0]
        : (
            await tx
              .select({ permissionVersion: nodes.permissionVersion })
              .from(nodes)
              .where(
                and(
                  eq(nodes.id, input.parentId),
                  eq(nodes.spaceId, input.spaceId),
                  eq(nodes.kind, 'folder'),
                ),
              )
              .for('no key update')
          )[0];
    if (!parent) throw new ContentError('not-found');
    if (parent.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    requireRoom(await pathUp(tx, input.spaceId, input.parentId), 1);
    await verifyRevisionCommit(tx, input, {
      author: identity,
      spaceId: input.spaceId,
      pageId: input.pageId,
      audience: 'draft',
      basedOn: null,
      share,
      heads: null,
    });
    // A retry after a lost response is answered as before; a taken ID is refused.
    if (await replayed(tx, input.revision, { pageId: input.pageId, audience: 'draft' }))
      return { revisionId: input.revision.record.revisionId };
    await requireCapacity(
      tx,
      caller.accountId,
      'page',
      input.maxPages ?? DEFAULT_CONTENT_LIMITS.pages,
    );
    const created = await tx
      .insert(nodes)
      .values({
        id: input.pageId,
        spaceId: input.spaceId,
        parentId: input.parentId,
        kind: 'page',
        createdBy: caller.accountId,
        permissionVersion: parent.permissionVersion,
      })
      .onConflictDoNothing()
      .returning({ id: nodes.id });
    if (created.length === 0) throw new ContentError('duplicate', 'That page ID is taken');
    await storeRevision(tx, input, {
      accountId: caller.accountId,
      storageBytes: input.storageBytes,
      draftSeq: 1,
      publishedSeq: null,
      restoredFrom: null,
    });
    await tx
      .insert(pageHeads)
      .values({ pageId: input.pageId, draftHead: input.revision.record.revisionId, draftCount: 1 });
    return { revisionId: input.revision.record.revisionId };
  });
}

/** Save a new draft on top of the current one. A stale base is a conflict, never an overwrite. */
export async function saveDraft(
  db: Database,
  input: {
    actor: Actor;
    pageId: string;
    restoredFrom: string | null;
    storageBytes: number;
    once?: Once | undefined;
  } & RevisionCommit,
) {
  return transactOnce(db, input.once, async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    const { identity } = caller;
    await lockSpaceOf(tx, input.pageId);
    const access = await requirePageAccess(tx, caller, await requirePage(tx, input.pageId));
    if (!canEdit(access)) throw new ContentError('not-found');
    const share = await lockShare(tx, access.share);
    const page = await requirePage(tx, input.pageId, { lock: true });
    const [heads] = await tx
      .select()
      .from(pageHeads)
      .where(eq(pageHeads.pageId, page.id))
      .for('update');
    if (!heads) throw new ContentError('not-found');
    if (await replayed(tx, input.revision, { pageId: page.id, audience: 'draft' }))
      return { revisionId: input.revision.record.revisionId, replayed: true };
    // A page published from another page has no draft until it is detached
    // from its source, which writes the first (section 13).
    if (heads.draftHead === null) {
      throw new ContentError('forbidden', 'Detach this page from its source to edit it here');
    }
    if (page.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    if (input.restoredFrom !== null) {
      const [source] = await tx
        .select({ id: revisions.id })
        .from(revisions)
        .where(
          and(
            eq(revisions.id, input.restoredFrom),
            eq(revisions.pageId, page.id),
            eq(revisions.audience, 'published'),
          ),
        );
      if (!source)
        throw new ContentError(
          'not-found',
          'Only a published version of this page can be restored',
        );
    }
    await verifyRevisionCommit(tx, input, {
      author: identity,
      spaceId: page.spaceId,
      pageId: page.id,
      audience: 'draft',
      basedOn: heads.draftHead,
      share,
      heads: { draftHead: heads.draftHead, publishedHead: heads.publishedHead },
    });
    const draftSeq = heads.draftCount + 1;
    await storeRevision(tx, input, {
      accountId: caller.accountId,
      storageBytes: input.storageBytes,
      draftSeq,
      publishedSeq: null,
      restoredFrom: input.restoredFrom,
    });
    await tx
      .update(pageHeads)
      .set({
        draftHead: input.revision.record.revisionId,
        draftCount: draftSeq,
        updatedAt: sql`now()`,
      })
      .where(eq(pageHeads.pageId, page.id));
    return { revisionId: input.revision.record.revisionId, replayed: false };
  });
}

/**
 * Publish the exact current draft as a separately encrypted version for the
 * published audience. Readers never see a half-made publication: it either
 * commits whole, with every attachment present, or not at all. The page's
 * public copies, of the version it replaces, go with it; its link stays.
 */
export async function publish(
  db: Database,
  input: {
    actor: Actor;
    pageId: string;
    expectedPublishedHead: string | null;
    storageBytes: number;
    once?: Once | undefined;
  } & RevisionCommit,
) {
  return transactOnce(db, input.once, async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    const { identity } = caller;
    await lockSpaceOf(tx, input.pageId);
    const access = await requirePageAccess(tx, caller, await requirePage(tx, input.pageId));
    // Publishing starts from the draft, so it needs edit access as well.
    if (!canEdit(access)) throw new ContentError('not-found');
    if (!access.canPublish) throw new ContentError('forbidden');
    const share = await lockShare(tx, access.share);
    const page = await requirePage(tx, input.pageId, { lock: true });
    const [heads] = await tx
      .select()
      .from(pageHeads)
      .where(eq(pageHeads.pageId, page.id))
      .for('update');
    if (!heads?.draftHead) throw new ContentError('not-found');
    if (await replayed(tx, input.revision, { pageId: page.id, audience: 'published' }))
      return { revisionId: input.revision.record.revisionId, replayed: true };
    if (page.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    if (input.expectedPublishedHead !== heads.publishedHead) {
      throw new ContentError('stale-head', 'Someone published since you loaded the page', {
        draftHead: heads.draftHead,
        publishedHead: heads.publishedHead,
      });
    }
    await verifyRevisionCommit(tx, input, {
      author: identity,
      spaceId: page.spaceId,
      pageId: page.id,
      audience: 'published',
      basedOn: heads.draftHead,
      share,
      heads: { draftHead: heads.draftHead, publishedHead: heads.publishedHead },
    });
    const publishedSeq = heads.publishedCount + 1;
    await storeRevision(tx, input, {
      accountId: caller.accountId,
      storageBytes: input.storageBytes,
      draftSeq: null,
      publishedSeq,
      restoredFrom: null,
    });
    // A public copy is only ever of the current published version (ADR 0005).
    await endCopies(tx, page.id);
    await tx
      .update(pageHeads)
      .set({
        publishedHead: input.revision.record.revisionId,
        publishedCount: publishedSeq,
        updatedAt: sql`now()`,
      })
      .where(eq(pageHeads.pageId, page.id));
    return { revisionId: input.revision.record.revisionId, replayed: false };
  });
}

/**
 * Hide a published page from readers (section 11), for someone who can
 * publish there. Under the page's lock, its permission version must still
 * be `permissionVersion` (`permission-version`), as for every write, and its
 * published head `expectedPublishedHead` (`stale-head`, with the heads),
 * unless it was already unpublished just after that one, as when a retry
 * follows a lost answer: then nothing changes, and that is no error. It then
 * has none, its current reader history ends, so the next publish starts a
 * new one, its permission version moves on, and its public link, if it has
 * one, is turned off. No keys change: editors and owners keep the whole
 * history, and readers keep what they already read.
 */
export async function unpublish(
  db: Database,
  input: { actor: Actor; pageId: string; expectedPublishedHead: string; permissionVersion: number },
) {
  await db.transaction(async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    await lockSpaceOf(tx, input.pageId);
    const access = await requirePageAccess(tx, caller, await requirePage(tx, input.pageId));
    // As for publishing, which it undoes.
    if (!canEdit(access)) throw new ContentError('not-found');
    if (!access.canPublish) throw new ContentError('forbidden');
    // Publishing's locks, in its order, which turning a public link on takes too.
    await lockShare(tx, access.share);
    const page = await requirePage(tx, input.pageId, { lock: true });
    const [heads] = await tx
      .select()
      .from(pageHeads)
      .where(eq(pageHeads.pageId, page.id))
      .for('update');
    if (!heads) throw new ContentError('not-found');
    // A retry after a lost answer: already unpublished, at that publication.
    if (heads.publishedHead === null && heads.readerHistoryFrom === heads.publishedCount + 1) {
      const [last] = await tx
        .select({ id: revisions.id })
        .from(revisions)
        .where(
          and(eq(revisions.pageId, page.id), eq(revisions.publishedSeq, heads.publishedCount)),
        );
      if (last?.id === input.expectedPublishedHead) return;
    }
    if (page.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    if (heads.publishedHead === null || heads.publishedHead !== input.expectedPublishedHead) {
      throw new ContentError('stale-head', 'The page changed since you loaded it', {
        draftHead: heads.draftHead,
        publishedHead: heads.publishedHead,
      });
    }
    await tx
      .update(pageHeads)
      .set({
        publishedHead: null,
        readerHistoryFrom: heads.publishedCount + 1,
        updatedAt: sql`now()`,
      })
      .where(eq(pageHeads.pageId, page.id));
    await tx
      .update(nodes)
      .set({ permissionVersion: sql`${nodes.permissionVersion} + 1` })
      .where(eq(nodes.id, page.id));
    // Its public link ends with it, and every copy (ADR 0005, decision 8).
    await endLinkFor(tx, page, { actor: caller.accountId, reason: 'unpublished' });
  });
}

/**
 * What the page view needs. Readers see only published state. A page whose
 * stored IDs today's rules refuse is `not-found`, and reported.
 */
export async function pageInfo(
  db: Database,
  actor: Actor,
  pageId: string,
  report: ReportUnreadable,
) {
  const caller = await requireCaller(db, actor);
  const page = await requirePage(db, pageId);
  const access = await requirePageAccess(db, caller, page);
  const [heads] = await db.select().from(pageHeads).where(eq(pageHeads.pageId, page.id));
  if (!heads) throw new ContentError('not-found');
  const reader = !canEdit(access);
  if (reader && !heads.publishedHead) throw new ContentError('not-found');
  const [published] = heads.publishedHead
    ? await db
        .select({ basedOn: revisions.basedOn })
        .from(revisions)
        .where(eq(revisions.id, heads.publishedHead))
    : [];
  const info = readStored(
    pageRoutes.PageInfo,
    {
      pageId: page.id,
      spaceId: page.spaceId,
      parentId: page.parentId,
      permissionVersion: page.permissionVersion,
      role: access.role,
      canPublish: access.canPublish,
      heads: {
        draftHead: reader ? null : heads.draftHead,
        publishedHead: heads.publishedHead,
        // A reader counts only the current reader history (section 11).
        publishedCount: reader
          ? heads.publishedCount - heads.readerHistoryFrom + 1
          : heads.publishedCount,
        draftChanges: !reader && heads.draftHead !== (published?.basedOn ?? null),
      },
      agentEdit: reader ? null : await draftOnlyAgentEdit(db, page),
      readerHistoryFrom: reader || !heads.publishedHead ? null : heads.readerHistoryFrom,
    },
    { table: 'nodes', id: page.id },
    report,
  );
  if (!info) throw new ContentError('not-found');
  return info;
}

/**
 * The newest version an agent wrote of any of `pageIds` (all in `spaceId`),
 * with its agent's name and that agent's person's account name, and whether
 * it is still only a draft: no publication of its page came after it. Read
 * from what was recorded as agents wrote (`agentEdits`), since draft
 * retention may have removed the version. Null when no agent wrote any.
 * Only for pages the caller can edit, since it tells of drafts.
 */
export async function latestAgentEdit(db: Database, spaceId: string, pageIds: readonly string[]) {
  if (pageIds.length === 0) return null;
  const [edit] = await db
    .select({
      pageId: agentEdits.pageId,
      agentId: agentEdits.agentId,
      agentName: agentProfiles.name,
      personId: agentProfiles.ownerIdentityId,
      personName: users.name,
      audience: agentEdits.audience,
      at: agentEdits.createdAt,
    })
    .from(agentEdits)
    .innerJoin(nodes, eq(nodes.id, agentEdits.pageId))
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agentEdits.agentId))
    .leftJoin(users, eq(users.id, agentProfiles.accountId))
    // One array parameter, however many pages: a list of them could pass
    // Postgres's limit on parameters in a large space.
    .where(
      and(
        eq(nodes.spaceId, spaceId),
        sql`${agentEdits.pageId} = any(${sql.param([...pageIds])}::text[])`,
      ),
    )
    .orderBy(desc(agentEdits.createdAt), desc(agentEdits.revisionId))
    .limit(1);
  if (!edit) return null;
  const [published] = await db
    .select({ at: revisions.createdAt })
    .from(pageHeads)
    .innerJoin(revisions, eq(revisions.id, pageHeads.publishedHead))
    .where(eq(pageHeads.pageId, edit.pageId));
  const { audience, at, ...rest } = edit;
  return {
    ...rest,
    at: at.toISOString(),
    draftOnly: audience === 'draft' && !(published && published.at >= at),
  };
}

// The latest draft an agent saved of a page since its latest publication.
async function draftOnlyAgentEdit(db: Database, page: { id: string; spaceId: string }) {
  const edit = await latestAgentEdit(db, page.spaceId, [page.id]);
  if (!edit?.draftOnly) return null;
  const { agentId, agentName, personId, personName, at } = edit;
  return { agentId, agentName, personId, personName, at };
}

/**
 * Ciphertext one answer may carry. A version can be nearly as large as a
 * request body, so a batch of them is answered in parts.
 */
export const REVISION_BATCH_BYTES = 2 * 1024 * 1024;

/**
 * Revisions the caller may read, each with its key wrap or the caller's own
 * envelopes for it (section 16). Others are left out. Readable ones past `REVISION_BATCH_BYTES` of
 * ciphertext are listed in `deferred` for the caller to ask for again; at
 * least one is always sent, so asking again makes progress. A stored row the
 * current schemas refuse is left out and reported.
 */
export async function fetchRevisions(
  db: Database,
  actor: Actor,
  ids: readonly string[],
  report: ReportUnreadable,
) {
  const caller = await requireCaller(db, actor);
  const { identity } = caller;
  if (ids.length === 0) return { revisions: [], deferred: [] };
  // One snapshot for the rows, their keys and the access that filters them,
  // so a move, share or member change can't land between them.
  const { answered, deferred } = await readSnapshot(db, async (tx) => {
    // Everything but the ciphertext, which is loaded only for what is sent.
    const rows = await tx
      .select({
        id: revisions.id,
        pageId: revisions.pageId,
        spaceId: revisions.spaceId,
        audience: revisions.audience,
        payloadSize: revisions.payloadSize,
        createdAt: revisions.createdAt,
        draftSeq: revisions.draftSeq,
        publishedSeq: revisions.publishedSeq,
        restoredFrom: revisions.restoredFrom,
      })
      .from(revisions)
      .where(inArray(revisions.id, [...ids]));
    const keysFor = await revisionKeyMaterial(tx, identity, ids, report);
    const readable = await readableRevisions(tx, caller, rows);
    const sent = [];
    const deferred = [];
    let bytes = 0;
    // In the order asked, so the first ones asked for are the ones sent.
    const position = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
    for (const row of rows) {
      const from = readable.get(row.id);
      const keys = keysFor.get(row.id);
      if (from === undefined || !keys) continue;
      if (sent.length > 0 && bytes + row.payloadSize > REVISION_BATCH_BYTES) {
        deferred.push(row.id);
        continue;
      }
      bytes += row.payloadSize;
      sent.push({ row, keys, from });
    }
    const sealed =
      sent.length === 0
        ? []
        : await tx
            .select({ id: revisions.id, sealed: revisions.sealed })
            .from(revisions)
            .where(
              inArray(
                revisions.id,
                sent.map(({ row }) => row.id),
              ),
            );
    const sealedFor = new Map(sealed.map((r) => [r.id, r.sealed]));
    const answered = sent.flatMap(({ row, keys, from }) => {
      const sealedRow = sealedFor.get(row.id);
      if (sealedRow === undefined) return [];
      const stored = { table: 'revisions', id: row.id };
      const revision = readStored(AnyRevision, sealedRow, stored, report);
      if (!revision) return [];
      // A refused restoredFrom is only a note about where the revision came
      // from: it is reported and sent as null, and the revision still goes.
      const restoredFrom =
        row.restoredFrom === null
          ? null
          : (readStored(RevisionId, row.restoredFrom, stored, report) ?? null);
      return [
        {
          revision,
          ...keys,
          meta: {
            createdAt: row.createdAt,
            draftSeq: row.draftSeq,
            publishedSeq: readerSeq(row.publishedSeq, from),
            restoredFrom,
          },
        },
      ];
    });
    return { answered, deferred };
  });
  // If every one sent was unreadable, answer from the rest
  // instead, so the answer still carries one when any is left. The rest is
  // always shorter.
  if (answered.length === 0 && deferred.length > 0) {
    return fetchRevisions(db, actor, deferred, report);
  }
  return { revisions: answered, deferred };
}

/** What decides whether a revision may be read. */
export type RevisionPlace = Pick<
  typeof revisions.$inferSelect,
  'id' | 'pageId' | 'spaceId' | 'audience' | 'publishedSeq'
>;

/**
 * The revisions `who` may read, each with where its page's history starts as
 * they count it: editors read every version, from 1, and readers only the
 * published versions of the current reader history (section 11). Access is
 * worked out for all their pages at once (`accessToPages`).
 */
export async function readableRevisions(
  db: Database,
  who: Holder,
  rows: readonly RevisionPlace[],
): Promise<Map<string, number>> {
  const access = new Map<string, Access | null>();
  for (const [spaceId, inSpace] of Map.groupBy(rows, (row) => row.spaceId)) {
    const pageIds = [...new Set(inSpace.map((row) => row.pageId))];
    for (const [pageId, at] of await accessToPages(db, who, spaceId, pageIds)) {
      access.set(pageId, at);
    }
  }
  const from = await readerHistoriesFrom(
    db,
    [...access].flatMap(([pageId, at]) => (at && !canEdit(at) ? [pageId] : [])),
  );
  const readable = new Map<string, number>();
  for (const row of rows) {
    const at = access.get(row.pageId) ?? null;
    if (canEdit(at)) {
      readable.set(row.id, 1);
      continue;
    }
    const start = from.get(row.pageId) ?? null;
    if (
      at !== null &&
      row.audience === 'published' &&
      start !== null &&
      row.publishedSeq !== null &&
      row.publishedSeq >= start
    ) {
      readable.set(row.id, start);
    }
  }
  return readable;
}

// Milestone 1 versions are served beside v2 ones.
const AnyRevision = z.union([SealedRevision, SealedRevisionV2]);

// A published version's signed parts, with the IDs beside them, each of
// which may be one Milestone 1 allowed and today's rules refuse.
const HistoryRow = z.object({
  record: z.union([RevisionRecord, RevisionRecordV2]),
  signature: SealedRevision.shape.signature,
  revisionId: RevisionId,
  basedOn: RevisionId.nullable(),
});

/**
 * Published versions, newest first, with who published each. A version whose
 * stored record the current schemas refuse is left out and reported.
 */
export async function pageHistory(
  db: Database,
  actor: Actor,
  pageId: string,
  report: ReportUnreadable,
) {
  const caller = await requireCaller(db, actor);
  const page = await requirePage(db, pageId);
  const access = await requirePageAccess(db, caller, page);
  const reader = !canEdit(access);
  const from = reader ? await readerHistoryFrom(db, page.id) : 1;
  if (from === null) throw new ContentError('not-found');
  const versions = await db
    .select({
      revisionId: revisions.id,
      publishedSeq: revisions.publishedSeq,
      publishedAt: revisions.createdAt,
      basedOn: revisions.basedOn,
      publisherIdentityId: revisions.authorIdentityId,
      // An agent's identity row is its person's account, so this names the
      // person an agent published for.
      publisherName: users.name,
      publisherAgentName: agentProfiles.name,
      publisherPersonId: agentProfiles.ownerIdentityId,
      // Just the signed parts: the ciphertext stays in the database.
      record: sql<unknown>`${revisions.sealed} -> 'record'`,
      signature: sql<unknown>`${revisions.sealed} -> 'signature'`,
    })
    .from(revisions)
    .leftJoin(
      identities,
      and(
        eq(identities.id, revisions.authorIdentityId),
        eq(identities.keyVersion, revisions.authorKeyVersion),
      ),
    )
    .leftJoin(users, eq(users.id, identities.accountId))
    .leftJoin(agentProfiles, eq(agentProfiles.agentId, revisions.authorIdentityId))
    .where(
      and(
        eq(revisions.pageId, page.id),
        eq(revisions.audience, 'published'),
        gte(revisions.publishedSeq, from),
      ),
    )
    .orderBy(desc(revisions.publishedSeq));
  return versions.flatMap(({ record, signature, revisionId, basedOn, ...version }) => {
    const row = { table: 'revisions', id: revisionId };
    const checked = readStored(HistoryRow, { record, signature, revisionId, basedOn }, row, report);
    if (!checked) return [];
    // Which draft each came from names drafts, which readers never see. The
    // signed record still names it, as it does when the version is fetched.
    return [
      {
        ...version,
        ...checked,
        publishedSeq: readerSeq(version.publishedSeq, from),
        basedOn: reader ? null : checked.basedOn,
      },
    ];
  });
}

/**
 * A version's number as someone counts it whose history starts at `from`:
 * readers count from 1 since the page was last unpublished, so no number
 * tells them of an earlier publication (section 11). Editors start at 1.
 */
const readerSeq = (publishedSeq: number | null, from: number) =>
  publishedSeq === null ? null : publishedSeq - from + 1;

/** Readers know a page only while it is published. */
export async function requirePublished(db: Database, pageId: string) {
  if ((await readerHistoryFrom(db, pageId)) === null) throw new ContentError('not-found');
}

/**
 * Where a page's current reader history starts, as a published sequence
 * number, or null while the page isn't published: readers see only the
 * versions published since it was last unpublished (section 11).
 */
async function readerHistoryFrom(db: Database, pageId: string): Promise<number | null> {
  const [heads] = await db
    .select({ publishedHead: pageHeads.publishedHead, from: pageHeads.readerHistoryFrom })
    .from(pageHeads)
    .where(eq(pageHeads.pageId, pageId));
  return heads?.publishedHead ? heads.from : null;
}

/** `readerHistoryFrom` for each of `pageIds`. */
async function readerHistoriesFrom(
  db: Database,
  pageIds: readonly string[],
): Promise<Map<string, number | null>> {
  if (pageIds.length === 0) return new Map();
  const heads = await db
    .select({
      pageId: pageHeads.pageId,
      publishedHead: pageHeads.publishedHead,
      from: pageHeads.readerHistoryFrom,
    })
    .from(pageHeads)
    .where(inArray(pageHeads.pageId, [...pageIds]));
  return new Map(heads.map((head) => [head.pageId, head.publishedHead ? head.from : null]));
}

/**
 * The given pages with their heads, for the tree; a reader's only if
 * published, and without their drafts. A page whose stored IDs today's rules
 * refuse is left out and reported.
 */
export async function listPages(
  db: Database,
  visible: readonly { id: string; reader: boolean }[],
  report: ReportUnreadable,
) {
  if (visible.length === 0) return [];
  const readers = new Set(visible.flatMap(({ id, reader }) => (reader ? [id] : [])));
  const rows = await db
    .select({
      id: nodes.id,
      parentId: nodes.parentId,
      permissionVersion: nodes.permissionVersion,
      heads: pageHeads,
      publishedFrom: revisions.basedOn,
    })
    .from(nodes)
    .innerJoin(pageHeads, eq(pageHeads.pageId, nodes.id))
    .leftJoin(revisions, eq(revisions.id, pageHeads.publishedHead))
    .where(
      and(
        inArray(
          nodes.id,
          visible.map(({ id }) => id),
        ),
        eq(nodes.kind, 'page'),
      ),
    );
  return rows
    .filter((row) => !readers.has(row.id) || row.heads.publishedHead !== null)
    .flatMap((row) => {
      const reader = readers.has(row.id);
      const summary = readStored(
        structureRoutes.PageSummary,
        {
          id: row.id,
          parentId: row.parentId,
          permissionVersion: row.permissionVersion,
          draftHead: reader ? null : row.heads.draftHead,
          publishedHead: row.heads.publishedHead,
          draftChanges: !reader && row.heads.draftHead !== row.publishedFrom,
        },
        { table: 'nodes', id: row.id },
        report,
      );
      return summary ? [summary] : [];
    });
}

/**
 * Store an encrypted attachment for a page and audience, streamed from
 * `body`. It stays staged until a revision lists it, and counts against the
 * uploader's quota until its page is deleted. Its labels never change, so
 * the same bytes can't be re-uploaded as another page's or audience's blob.
 */
export async function uploadBlob(
  db: Database,
  store: BlobStore,
  input: {
    actor: Actor;
    pageId: string;
    audience: Audience;
    body: ReadableStream<Uint8Array>;
    /** The upload's Content-Length: reserved before any byte is stored, and enforced. */
    declaredSize: number;
    limits: { uploadBytes: number; storageBytes: number };
  },
) {
  const caller = await requireCaller(db, input.actor);
  const { accountId } = caller;
  const page = await requirePage(db, input.pageId);
  // A copy's hidden page takes uploads from its opener only (section 10).
  const access = page.copyId
    ? await copyUploadAccess(db, caller, page.copyId)
    : await requirePageAccess(db, caller, page);
  if (!access || !canEdit(access)) throw new ContentError('not-found');
  if (input.audience === 'published' && !access.canPublish) throw new ContentError('forbidden');
  if (input.declaredSize > input.limits.uploadBytes) {
    throw new ContentError('too-large', 'Attachment is too large');
  }

  const release = await reserve(db, accountId, input.declaredSize, input.limits);
  try {
    const staged = await store.stage(input.body, input.declaredSize).catch((error: unknown) => {
      if (error instanceof BlobTooLarge) throw new ContentError('too-large', error.message);
      throw error;
    });
    try {
      await storeBlob(db, staged, {
        page,
        accountId,
        audience: input.audience,
        storageBytes: input.limits.storageBytes,
      });
    } finally {
      await staged.discard();
    }
    return { hash: staged.hash, size: staged.size };
  } finally {
    release();
  }
}

// Held by everything that writes or removes a blob's row or file: uploads of
// the same bytes, page deletes, and the sweep. A row lock can't do it, since the row may
// not exist yet, or may be gone while its file remains.
const lockBlob = (tx: Database, hash: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wikistow:blob:${hash}`}))`);

/**
 * Delete a blob's file if it has no row, under the blob's lock. Callers that
 * delete a row run this after that delete commits, never inside it: had the
 * commit failed, the row would be left without its file. The lock only lasts
 * a transaction, so this takes it again in one of its own and checks for a
 * row once more, since an upload of the same bytes may have stored one since.
 */
export async function deleteUnlistedFile(db: Database, store: BlobStore, hash: string) {
  await db.transaction(async (tx) => {
    await lockBlob(tx, hash);
    const [row] = await tx.select({ hash: blobs.hash }).from(blobs).where(eq(blobs.hash, hash));
    if (!row) await store.delete(hash);
  });
}

/** Record a staged blob for a page, moving its bytes into place first. */
async function storeBlob(
  db: Database,
  staged: StagedBlob,
  {
    page,
    accountId,
    audience,
    storageBytes,
  }: {
    page: { id: string; spaceId: string };
    accountId: string;
    audience: Audience;
    storageBytes: number;
  },
) {
  await db.transaction(async (tx) => {
    // The page can't be deleted while this row goes in.
    await requirePage(tx, page.id, { lock: true });
    await lockBlob(tx, staged.hash);
    const [existing] = await tx.select().from(blobs).where(eq(blobs.hash, staged.hash));
    if (existing) {
      if (existing.pageId !== page.id || existing.audience !== audience) {
        throw new ContentError(
          'blob-label-mismatch',
          'These bytes already belong to another page or audience',
        );
      }
      // The same bytes again, as from a retry: put the file back in case it
      // went missing, and give an unlisted upload a fresh day before the sweep.
      await staged.commit();
      await tx
        .update(blobs)
        .set({ createdAt: sql`now()` })
        .where(eq(blobs.hash, staged.hash));
      return;
    }
    await charge(tx, accountId, staged.size, storageBytes);
    // File first: a failure after this leaves an unreferenced file for the
    // sweep, never a row without bytes.
    await staged.commit();
    await tx.insert(blobs).values({
      hash: staged.hash,
      spaceId: page.spaceId,
      pageId: page.id,
      audience,
      size: staged.size,
      uploadedBy: accountId,
    });
  });
}

// Bytes of uploads still streaming, per account, so they count toward the
// quota before they arrive. In process: WikiStow runs as a single server.
const inFlight = new Map<string, { bytes: number; uploads: number }>();
const MAX_UPLOADS_IN_FLIGHT = 4;

/** Hold `bytes` of the account's storage for an upload; call the result when it ends. */
async function reserve(
  db: Database,
  accountId: string,
  bytes: number,
  limits: { storageBytes: number },
): Promise<() => void> {
  const used = await usedBytes(db, accountId);
  // Read after the await, so uploads starting together see each other.
  const current = inFlight.get(accountId) ?? { bytes: 0, uploads: 0 };
  if (current.uploads >= MAX_UPLOADS_IN_FLIGHT) {
    throw new ContentError('busy', 'Too many uploads at once; wait for one to finish');
  }
  if (used + current.bytes + bytes > limits.storageBytes) {
    throw new ContentError('storage-full', 'Your storage is full');
  }
  inFlight.set(accountId, { bytes: current.bytes + bytes, uploads: current.uploads + 1 });
  return () => {
    const now = inFlight.get(accountId);
    if (!now) return;
    if (now.uploads <= 1) inFlight.delete(accountId);
    else inFlight.set(accountId, { bytes: now.bytes - bytes, uploads: now.uploads - 1 });
  };
}

/** Encrypted bytes for someone allowed to read them; not-found for everyone else. */
export async function downloadBlob(
  db: Database,
  store: BlobStore,
  input: { actor: Actor; hash: string },
) {
  const caller = await requireCaller(db, input.actor);
  const [blob] = await db.select().from(blobs).where(eq(blobs.hash, input.hash));
  if (!blob) throw new ContentError('not-found');
  const access = await accessTo(db, caller, { spaceId: blob.spaceId, nodeId: blob.pageId });
  // A staged blob is its uploader's account's: a person and their agents
  // can read one another's, which stays within one person.
  const readable =
    access !== null &&
    (canEdit(access) || (blob.audience === 'published' && (await readerMayRead(db, blob)))) &&
    (blob.state === 'committed' || blob.uploadedBy === caller.accountId);
  if (!readable) throw new ContentError('not-found');
  const stored = await store.get(blob.hash);
  if (!stored) throw new ContentError('not-found');
  return stored;
}

/**
 * Whether a published blob is listed by a version in its page's current
 * reader history, so a reader may download it (section 11). One copy can be
 * listed by an earlier version too (section 12); that one doesn't count.
 */
async function readerMayRead(db: Database, blob: { hash: string; pageId: string }) {
  const from = await readerHistoryFrom(db, blob.pageId);
  if (from === null) return false;
  const [listed] = await db
    .select({ id: revisions.id })
    .from(revisionBlobs)
    .innerJoin(revisions, eq(revisions.id, revisionBlobs.revisionId))
    .where(
      and(
        eq(revisionBlobs.blobHash, blob.hash),
        eq(revisions.pageId, blob.pageId),
        eq(revisions.audience, 'published'),
        gte(revisions.publishedSeq, from),
      ),
    )
    .limit(1);
  return listed !== undefined;
}

/**
 * Lock a node and everything beneath it. New children need their parent
 * locked, and writes to a page hold it `FOR SHARE`, so once the whole set is
 * locked nothing can be added to it or written into it.
 */
async function lockSubtree(tx: Database, spaceId: string, nodeId: string): Promise<string[]> {
  let locked = new Set<string>();
  for (;;) {
    // The space is carried through the walk, as in `subtreeOf`.
    const subtree = await tx.execute<{ id: string }>(sql`
      with recursive subtree(id, space_id) as (
        select id, space_id from nodes where id = ${nodeId} and space_id = ${spaceId}
        union all
        select n.id, n.space_id from nodes n
          join subtree s on n.space_id = s.space_id and n.parent_id = s.id
      )
      select id from subtree`);
    const ids = [...subtree].map((row) => row.id);
    if (ids.every((id) => locked.has(id))) return ids;
    await tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(anyId(nodes.id, ids), eq(nodes.spaceId, spaceId)))
      // In ID order, so everything that holds several nodes holds them alike.
      .orderBy(nodes.id)
      .for('update');
    locked = new Set(ids);
  }
}

/**
 * Lock, for update, every share rooted at or under `nodeId`. Saves and
 * rotations take a share's row before its nodes, so a delete that takes
 * the shares it removes first, before any node, never waits on one of them
 * while holding what it waits for. No share can be made meanwhile, since
 * the caller holds the space.
 */
async function lockSharesUnder(tx: Database, spaceId: string, nodeId: string): Promise<void> {
  await tx.execute(sql`
    with recursive subtree(id, space_id) as (
      select id, space_id from nodes where id = ${nodeId} and space_id = ${spaceId}
      union all
      select n.id, n.space_id from nodes n
        join subtree s on n.space_id = s.space_id and n.parent_id = s.id
    )
    select sh.id from shares sh join subtree on sh.root_id = subtree.id
    where sh.space_id = ${spaceId}
    order by sh.id
    for update of sh`);
}

/**
 * Delete a folder or page and everything beneath it, for space owners, with
 * the shares rooted in it (`removeSubtree`). It holds the space against a
 * share being made meanwhile. Its blob files, and those of any opening that
 * goes, are removed after the transaction commits, each kept if an upload
 * of the same bytes has stored it again by then. Any left by a failure
 * here go in the sweep's pass over files without rows. A copy's hidden
 * nodes are its own to remove (section 10).
 */
export async function deleteNode(
  db: Database,
  store: BlobStore,
  input: { accountId: string; spaceId: string; nodeId: string },
) {
  const hashes = await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    await lockSpace(tx, input.spaceId);
    if (!(await isOwner(tx, identity.id, input.spaceId))) {
      const access = await accessTo(tx, { identity, personId: null }, input);
      throw new ContentError(access ? 'forbidden' : 'not-found');
    }
    if (await isHidden(tx, input.nodeId)) throw new ContentError('not-found');
    return removeSubtree(tx, input.spaceId, input.nodeId, await holdSubtree(tx, input));
  });
  for (const hash of hashes) await deleteUnlistedFile(db, store, hash);
}

/**
 * Hold a node and everything beneath it for `removeSubtree`, a copy's
 * hidden nodes inside it included: first the shares rooted there, as saves
 * and rotations lock them, then the nodes. The caller holds the space
 * against a share being made meanwhile. The nodes held; not-found if none.
 */
export async function holdSubtree(
  tx: Database,
  { spaceId, nodeId }: { spaceId: string; nodeId: string },
): Promise<string[]> {
  await lockSharesUnder(tx, spaceId, nodeId);
  const ids = await lockSubtree(tx, spaceId, nodeId);
  if (ids.length === 0) throw new ContentError('not-found');
  return ids;
}

/**
 * Delete a node and everything beneath it (`ids`, held by `holdSubtree`),
 * with the shares rooted in it. Its pages' publications into other spaces
 * end with them (`endPublicationsFrom`), and so do their public links and
 * copies. The hashes of the blobs that went, whose files the caller
 * removes once the transaction commits (`deleteUnlistedFile`).
 */
export async function removeSubtree(
  tx: Database,
  spaceId: string,
  nodeId: string,
  ids: readonly string[],
): Promise<string[]> {
  const openingFiles = await endPublicationsFrom(tx, ids);
  // Its pages' public links, copies and the target rows naming them, in
  // their lock order, rather than by the cascade (ADR 0005, decision 5).
  await endLinks(tx, ids);
  const doomed = await tx.select({ hash: blobs.hash }).from(blobs).where(anyId(blobs.pageId, ids));
  // Envelopes and folder metadata point at their subject by ID, not by
  // foreign key, so they are removed explicitly.
  const pageRevisions = tx
    .select({ id: revisions.id })
    .from(revisions)
    .where(anyId(revisions.pageId, ids));
  const folderMetadata = and(
    eq(metadataRevisions.subjectKind, 'folder'),
    anyId(metadataRevisions.subjectId, ids),
  );
  await tx
    .delete(keyEnvelopes)
    .where(
      or(
        and(
          eq(keyEnvelopes.subjectKind, 'revision'),
          inArray(keyEnvelopes.subjectId, pageRevisions),
        ),
        and(
          eq(keyEnvelopes.subjectKind, 'metadata'),
          inArray(
            keyEnvelopes.subjectId,
            tx.select({ id: metadataRevisions.id }).from(metadataRevisions).where(folderMetadata),
          ),
        ),
      ),
    );
  await tx.delete(metadataRevisions).where(folderMetadata);
  await tx.delete(nodes).where(and(eq(nodes.id, nodeId), eq(nodes.spaceId, spaceId)));
  return [...doomed.map((b) => b.hash), ...openingFiles];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Remove attachment data nothing uses: uploads no revision listed within a
 * day (such as the losing side of two publishes at once), committed blobs
 * whose last revision was compacted, files without a row, and staging files
 * from interrupted uploads. Recent files stay, since an upload writes its
 * file just before its row. Each blob is
 * checked again and its row removed under its lock, then its file once that
 * commits, so an upload of the same bytes either keeps it or waits and
 * stores it anew.
 *
 * First, publications into another space opened more than a day ago that
 * never got a version, with nothing uploaded for them within the day
 * either (`sweepOpenings`): their uploads then go with them. And copies
 * nobody sent anything to for a day (`sweepCopies`), with their nodes; one
 * that fails is counted in `copiesFailed` and tried again next time.
 */
export async function sweepBlobs(db: Database, store: BlobStore, { graceMs = DAY_MS } = {}) {
  const cutoff = new Date(Date.now() - graceMs);
  const openings = await sweepOpenings(db, cutoff);
  const { removed: copies, failed: copiesFailed } = await sweepCopies(db, store, cutoff);
  const unlisted = and(
    lt(blobs.createdAt, cutoff),
    sql`not exists (select 1 from revision_blobs ref where ref.blob_hash = ${blobs.hash})`,
  );
  let staged = 0;
  for (const { hash } of await db.select({ hash: blobs.hash }).from(blobs).where(unlisted)) {
    const removed = await db.transaction(async (tx) => {
      await lockBlob(tx, hash);
      // Attaching holds this row for share. Wait for it before the fresh
      // reference check, including reuses that don't change the blob row.
      await tx.select({ hash: blobs.hash }).from(blobs).where(eq(blobs.hash, hash)).for('update');
      const rows = await tx
        .delete(blobs)
        .where(and(eq(blobs.hash, hash), unlisted))
        .returning({ hash: blobs.hash });
      return rows.length;
    });
    if (removed > 0) await deleteUnlistedFile(db, store, hash);
    staged += removed;
  }

  for await (const file of store.list()) {
    if (file.writtenAt < cutoff) await deleteUnlistedFile(db, store, file.hash);
  }
  await store.clearStaging(graceMs);
  return { staged, openings, copies, copiesFailed };
}

/**
 * Remove publications into another space opened before `cutoff` that
 * never got a version (section 13), unless something was uploaded for one
 * since, which means someone is finishing it. Nobody ever saw them. Each
 * is checked again under the locks a send takes, in its order (the space,
 * the page's share, the page, then the publication), so a send either
 * lands first and keeps it, or finds it gone. One that goes takes its row
 * and its uploads' rows with it; their files are older than `cutoff`, so
 * the sweep removes them too. How many went.
 */
async function sweepOpenings(db: Database, cutoff: Date): Promise<number> {
  const old = await db
    .select({ pageId: publications.destinationPageId, spaceId: publications.destinationSpaceId })
    .from(publications)
    .leftJoin(pageHeads, eq(pageHeads.pageId, publications.destinationPageId))
    .where(
      and(
        isNull(publications.detachedAt),
        isNull(pageHeads.pageId),
        lt(publications.createdAt, cutoff),
      ),
    );
  let removed = 0;
  for (const { pageId, spaceId } of old) {
    const gone = await db.transaction(async (tx) => {
      const [space] = await tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .for('key share');
      if (!space) return false;
      await shareAt(tx, spaceId, pageId, { lock: 'share' });
      const [page] = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(eq(nodes.id, pageId))
        .for('update');
      if (!page) return false;
      const [row] = await tx
        .select({ detachedAt: publications.detachedAt })
        .from(publications)
        .where(eq(publications.destinationPageId, pageId))
        .for('update');
      const [heads] = await tx
        .select({ pageId: pageHeads.pageId })
        .from(pageHeads)
        .where(eq(pageHeads.pageId, pageId));
      const [recent] = await tx
        .select({ hash: blobs.hash })
        .from(blobs)
        .where(and(eq(blobs.pageId, pageId), gte(blobs.createdAt, cutoff)))
        .limit(1);
      if (row?.detachedAt !== null || heads || recent) return false;
      await tx.delete(nodes).where(eq(nodes.id, pageId));
      return true;
    });
    if (gone) removed += 1;
  }
  return removed;
}

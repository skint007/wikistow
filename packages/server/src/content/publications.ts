// Publishing chosen versions of a page into a page in another space
// (protocol section 13). The destination is an ordinary page whose
// published versions are copies, sealed for its own space; the server
// only checks who may send them, and keeps which page they came from.
//
// Every change here takes its locks in one order, so no two wait on each
// other: the destination space (key share, as every write), then shares
// (`share`, by ID when there are two), then nodes, then the publication
// row, then the page's heads. No transaction waits on a lock in another
// space: changes elsewhere lock in orders of their own (a delete locks its
// subtree as it finds it), so waiting across spaces could close a cycle.
// The source is only read, but an open or a send holds its page (key
// share), last, and only if no one holds it (`holdSource`): a delete of the
// source then waits for it, and draft retention keeps the version a send
// names. A delete ends the source's publications the other way round
// (`endPublicationsFrom`): it takes their rows, and any opening it removes,
// without waiting, so a change in their space may wait for it without
// closing a cycle.
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { isLockNotAvailable } from '../db/errors.ts';
import { transactOnce, type Once } from '../idempotency.ts';
import { blobs, nodes, pageHeads, publications, revisions, spaces } from '../db/schema/index.ts';
import {
  accessTo,
  canEdit,
  lockShare,
  lockSpace,
  lockSpaceOf,
  pathUp,
  readSnapshot,
  shareAt,
  requireRoom,
  type Access,
  type Holder,
  type ShareRow,
} from './access.ts';
import { ContentError } from './errors.ts';
import { DEFAULT_CONTENT_LIMITS, requireCapacity } from './limits.ts';
import { requireCaller, type Actor } from './identities.ts';
import {
  replayed,
  requirePage,
  requirePageAccess,
  storeRevision,
  verifyRevisionCommit,
  type RevisionCommit,
} from './pages.ts';

type PublicationRow = typeof publications.$inferSelect;

// Whether the destination page has had a version yet: until then it has no
// heads row, and nobody sees it.
async function headsOf(db: Database, pageId: string, { lock = false } = {}) {
  const query = db.select().from(pageHeads).where(eq(pageHeads.pageId, pageId));
  const [heads] = lock ? await query.for('update') : await query;
  return heads ?? null;
}

// The source page's live publication in a space, if any, unlocked: a change
// locks its row only after the nodes it changes (`requirePublicationAt`).
async function livePublication(
  db: Database,
  { sourcePageId, spaceId }: { sourcePageId: string; spaceId: string },
): Promise<PublicationRow | null> {
  const [row] = await db
    .select()
    .from(publications)
    .where(
      and(
        eq(publications.sourcePageId, sourcePageId),
        eq(publications.destinationSpaceId, spaceId),
        isNull(publications.detachedAt),
      ),
    );
  return row ?? null;
}

// Hold shares for a write, in the database's order of their IDs, as a
// change that locks several does (`deleteNode`), so none waits on another.
async function lockShares(tx: Database, held: readonly (ShareRow | null)[]) {
  const ids = held.flatMap((share) => (share ? [share.id] : []));
  if (ids.length === 0) return;
  await tx.execute(sql`
    select id from shares where id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )}) order by id for share`);
}

// Whether access lets someone publish: edit access with publish rights.
const publishes = (access: Access | null) => canEdit(access) && access?.canPublish === true;

/**
 * The source page, for someone who can publish it: only they publish it
 * into another space, learn where it went, or end a publication of it
 * (section 13), so its readers can't take a copy elsewhere. Agents follow
 * their pick and their person, as everywhere (section 9.5). Not-found when
 * the caller can't see the page, forbidden when they can't publish it.
 */
async function requireSourcePublisher(db: Database, who: Holder, sourcePageId: string) {
  const source = await requirePage(db, sourcePageId);
  if (!publishes(await requirePageAccess(db, who, source))) {
    throw new ContentError(
      'forbidden',
      'Only someone who can publish a page publishes it elsewhere',
    );
  }
  return source;
}

/**
 * What a source page's publisher learns of one of its live publications. A
 * pending one they can't publish at is null, since opening one there
 * replaces it; one with versions they can't publish at is `blocked`, and
 * names nothing there, so they learn no more of a place they can't see
 * than that it stops them.
 */
async function seenBy(db: Database, caller: Holder, row: PublicationRow) {
  const pageId = row.destinationPageId;
  const [page] = await db
    .select({ parentId: nodes.parentId })
    .from(nodes)
    .where(eq(nodes.id, pageId));
  if (!page) return null;
  const pending = (await headsOf(db, pageId)) === null;
  const access = await accessTo(db, caller, { spaceId: row.destinationSpaceId, nodeId: pageId });
  if (!publishes(access)) return pending ? null : { state: 'blocked' as const };
  return {
    state: pending ? ('pending' as const) : ('live' as const),
    pageId,
    parentId: page.parentId,
  };
}

/** The source page's live publication in `spaceId` (`seenBy`), for someone who can publish the source page. */
export async function publicationOf(
  db: Database,
  actor: Actor,
  { sourcePageId, spaceId }: { sourcePageId: string; spaceId: string },
) {
  const caller = await requireCaller(db, actor);
  // One snapshot, so a move between reading the copy's folder and the
  // caller's access there can't name a folder outside their shares.
  return readSnapshot(db, async (tx) => {
    await requireSourcePublisher(tx, caller, sourcePageId);
    const row = await livePublication(tx, { sourcePageId, spaceId });
    const seen = row && (await seenBy(tx, caller, row));
    return seen?.state === 'live' ? { state: seen.state, pageId: seen.pageId } : seen;
  });
}

/**
 * Every live publication of the source page, oldest first, each as
 * `publicationOf` would give it with the space it is in, and a `live`
 * one's folder too, for someone who can publish the source page. A delete
 * ends a page's publications (`endPublicationsFrom`), so a page made later
 * with its ID learns nothing of where that one went.
 */
export async function publicationsOf(db: Database, actor: Actor, sourcePageId: string) {
  const caller = await requireCaller(db, actor);
  return readSnapshot(db, async (tx) => {
    const source = await requireSourcePublisher(tx, caller, sourcePageId);
    const rows = await tx
      .select()
      .from(publications)
      .where(and(eq(publications.sourcePageId, source.id), isNull(publications.detachedAt)))
      .orderBy(publications.createdAt, publications.destinationPageId);
    const listed = [];
    for (const row of rows) {
      const seen = await seenBy(tx, caller, row);
      if (seen) listed.push({ spaceId: row.destinationSpaceId, ...seen });
    }
    return listed;
  });
}

/**
 * Open a publication of `sourcePageId` into another space (section 13):
 * make its destination page under `parentId`, where the caller can publish,
 * with no version yet, so the copy's attachments can be uploaded to it.
 * Nobody sees it until its first version arrives (`sendPublication`). The
 * caller must be able to publish the source page, which must have a
 * version (an opening has none). A source page has one live publication
 * per space: if it has one already, this is `stale-head`, unless that one
 * never got a version and is in another folder: then it is deleted and
 * replaced, since nobody saw it, and a publication goes only where its
 * publisher chose. One pending in the folder asked for is the caller's to
 * finish instead. Asked again for the same page, it is no error.
 */
export async function openPublication(
  db: Database,
  input: {
    actor: Actor;
    sourcePageId: string;
    destinationSpaceId: string;
    maxPages?: number;
    pageId: string;
    parentId: string | null;
    permissionVersion: number;
    once?: Once | undefined;
  },
) {
  return transactOnce(db, input.once, async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    const source = await requireSourcePublisher(tx, caller, input.sourcePageId);
    // An opening nobody has seen yet is no page to publish from: it goes
    // without ending anything published from it.
    if ((await headsOf(tx, source.id)) === null) throw new ContentError('not-found');
    if (source.spaceId === input.destinationSpaceId) {
      throw new ContentError('forbidden', 'A page publishes only into another space');
    }
    await lockSpace(tx, input.destinationSpaceId);
    const access = await accessTo(tx, caller, {
      spaceId: input.destinationSpaceId,
      nodeId: input.parentId,
    });
    if (!access) throw new ContentError('not-found');
    if (!publishes(access)) throw new ContentError('forbidden');
    const live = await livePublication(tx, {
      sourcePageId: source.id,
      spaceId: input.destinationSpaceId,
    });
    const other = live && live.destinationPageId !== input.pageId ? live.destinationPageId : null;
    // An opening being replaced may be under another share: both are held.
    await lockShares(tx, [
      access.share,
      other ? await shareAt(tx, input.destinationSpaceId, other) : null,
    ]);
    const parent =
      input.parentId === null
        ? (
            await tx
              .select({ permissionVersion: spaces.permissionVersion })
              .from(spaces)
              .where(eq(spaces.id, input.destinationSpaceId))
              .for('no key update')
          )[0]
        : (
            await tx
              .select({ permissionVersion: nodes.permissionVersion })
              .from(nodes)
              .where(
                and(
                  eq(nodes.id, input.parentId),
                  eq(nodes.spaceId, input.destinationSpaceId),
                  eq(nodes.kind, 'folder'),
                ),
              )
              .for('no key update')
          )[0];
    if (!parent) throw new ContentError('not-found');
    if (parent.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    requireRoom(await pathUp(tx, input.destinationSpaceId, input.parentId), 1);

    if (live && !other) return { pageId: input.pageId };
    if (other) {
      const [pending] = await tx.select().from(nodes).where(eq(nodes.id, other)).for('update');
      const row = await publicationAt(tx, other);
      // Ended meanwhile, it is in nobody's way.
      if (pending && row?.detachedAt === null) {
        const elsewhere =
          (await headsOf(tx, other)) === null && pending.parentId !== input.parentId;
        if (!elsewhere) {
          throw new ContentError('stale-head', 'This page was published into that space meanwhile');
        }
        // Nothing was ever published there, so nobody saw it. Its row and
        // any attachments uploaded for it go with it.
        await tx.delete(nodes).where(eq(nodes.id, other));
      }
    }
    // Held, so a delete of the source waits for this row and ends it. One
    // deleted since it was read is gone, even if a page has its ID again.
    if ((await holdSource(tx, source.id)).getTime() !== source.createdAt.getTime()) {
      throw new ContentError('not-found');
    }
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
        spaceId: input.destinationSpaceId,
        parentId: input.parentId,
        kind: 'page',
        createdBy: caller.accountId,
        permissionVersion: parent.permissionVersion,
      })
      .onConflictDoNothing()
      .returning({ id: nodes.id });
    if (created.length === 0) throw new ContentError('duplicate', 'That page ID is taken');
    // Another publication of this page into the space, opened at once, wins
    // the unique index; this one rolls back.
    const opened = await tx
      .insert(publications)
      .values({
        destinationPageId: input.pageId,
        destinationSpaceId: input.destinationSpaceId,
        sourceSpaceId: source.spaceId,
        sourcePageId: source.id,
        createdBy: caller.accountId,
      })
      .onConflictDoNothing()
      .returning({ pageId: publications.destinationPageId });
    if (opened.length === 0) {
      throw new ContentError('stale-head', 'This page was published into that space meanwhile');
    }
    return { pageId: input.pageId };
  });
}

/**
 * Whether `who` may copy the source version `revisionId` of `sourcePageId`
 * (section 13): only someone who can publish the source page sends any of
 * its versions, and only a version of that page.
 */
async function requireSourceVersion(
  db: Database,
  who: Holder,
  { sourcePageId, revisionId }: { sourcePageId: string; revisionId: string },
) {
  await requireSourcePublisher(db, who, sourcePageId);
  const [version] = await db
    .select({ id: revisions.id })
    .from(revisions)
    .where(and(eq(revisions.id, revisionId), eq(revisions.pageId, sourcePageId)));
  if (!version) throw new ContentError('not-found', 'That version of the source isn’t there');
}

/**
 * Hold the source page `sourcePageId` (key share) until the change commits:
 * a delete of it holds it for update, so it waits and then ends the
 * publication, and so does draft retention, so the version a copy names
 * stays. Never waited for, as the module's lock order says: whoever holds
 * it (a delete or retention in its space) may be waiting on this space, so
 * the change is refused as `busy`, holding nothing, to be tried again.
 * Not-found once the page is gone. When the held page was made.
 */
async function holdSource(tx: Database, sourcePageId: string): Promise<Date> {
  const [held] = await tx
    .select({ createdAt: nodes.createdAt })
    .from(nodes)
    .where(eq(nodes.id, sourcePageId))
    .for('key share', { noWait: true })
    .catch((error: unknown) => {
      if (!isLockNotAvailable(error)) throw error;
      throw new ContentError('busy', 'Someone is changing the source page. Try again in a moment.');
    });
  if (!held) throw new ContentError('not-found');
  return held.createdAt;
}

// The live publication whose destination is `pageId`, held for the change.
async function requireLiveAt(tx: Database, pageId: string): Promise<PublicationRow> {
  const row = await requirePublicationAt(tx, pageId);
  if (row.detachedAt !== null) {
    throw new ContentError('not-found', 'This page isn’t published from another page any more');
  }
  return row;
}

// The publication whose destination is `pageId`, live or ended, held for the change.
async function publicationAt(tx: Database, pageId: string): Promise<PublicationRow | null> {
  const [row] = await tx
    .select()
    .from(publications)
    .where(eq(publications.destinationPageId, pageId))
    .for('update');
  return row ?? null;
}

async function requirePublicationAt(tx: Database, pageId: string): Promise<PublicationRow> {
  const row = await publicationAt(tx, pageId);
  if (!row) throw new ContentError('not-found', 'This page isn’t published from another page');
  return row;
}

/**
 * Send a copy of the source version `sourceRevisionId` as the destination
 * page's next published version (section 13). The caller must be able to
 * copy that version (`requireSourceVersion`) and publish at the destination.
 * The copy is a published version with no draft behind it, bound to the
 * destination, with the key material of its region there, under its
 * current key version. Its permission version must still be
 * `permissionVersion`, and its published head `expectedPublishedHead`
 * (`stale-head` otherwise), so of two sent at once only one goes. A retry
 * of the same version is answered as before. Its first version is what
 * makes the page visible.
 */
export async function sendPublication(
  db: Database,
  input: {
    actor: Actor;
    pageId: string;
    sourceRevisionId: string;
    expectedPublishedHead: string | null;
    storageBytes: number;
    once?: Once | undefined;
  } & RevisionCommit,
) {
  return transactOnce(db, input.once, async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    await lockSpaceOf(tx, input.pageId);
    const access = await requirePageAccess(tx, caller, await requirePage(tx, input.pageId));
    if (!publishes(access)) throw new ContentError('forbidden');
    const share = await lockShare(tx, access.share);
    const page = await requirePage(tx, input.pageId, { lock: true });
    const row = await requireLiveAt(tx, page.id);
    const heads = await headsOf(tx, page.id, { lock: true });
    if (await replayed(tx, input.revision, { pageId: page.id, audience: 'published' }))
      return { revisionId: input.revision.record.revisionId, replayed: true };
    await holdSource(tx, row.sourcePageId);
    await requireSourceVersion(tx, caller, {
      sourcePageId: row.sourcePageId,
      revisionId: input.sourceRevisionId,
    });
    if (page.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    const current = {
      draftHead: heads?.draftHead ?? null,
      publishedHead: heads?.publishedHead ?? null,
    };
    if (input.expectedPublishedHead !== current.publishedHead) {
      throw new ContentError('stale-head', 'Someone published here since you looked', current);
    }
    await verifyRevisionCommit(tx, input, {
      author: caller.identity,
      spaceId: page.spaceId,
      pageId: page.id,
      audience: 'published',
      basedOn: null,
      share,
      heads: current,
    });
    const publishedSeq = (heads?.publishedCount ?? 0) + 1;
    await storeRevision(tx, input, {
      accountId: caller.accountId,
      storageBytes: input.storageBytes,
      draftSeq: null,
      publishedSeq,
      restoredFrom: null,
      sourceRevisionId: input.sourceRevisionId,
    });
    const revisionId = input.revision.record.revisionId;
    if (heads) {
      await tx
        .update(pageHeads)
        .set({ publishedHead: revisionId, publishedCount: publishedSeq, updatedAt: sql`now()` })
        .where(eq(pageHeads.pageId, page.id));
    } else {
      await tx
        .insert(pageHeads)
        .values({ pageId: page.id, publishedHead: revisionId, publishedCount: publishedSeq });
    }
    await tx
      .update(publications)
      .set({ lastSourceRevisionId: input.sourceRevisionId })
      .where(eq(publications.destinationPageId, page.id));
    return { revisionId, replayed: false };
  });
}

/**
 * Detach a destination page from its source (section 13): store its first
 * draft, which the caller's app made from its latest publication, and end
 * the publication, if the source's publisher hasn't already
 * (`endPublication`), so it is an ordinary page from now on. Only someone
 * who can publish there detaches it. A retry of the same draft is answered
 * as before.
 */
export async function detachPublication(
  db: Database,
  input: {
    actor: Actor;
    pageId: string;
    storageBytes: number;
    once?: Once | undefined;
  } & RevisionCommit,
) {
  return transactOnce(db, input.once, async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    await lockSpaceOf(tx, input.pageId);
    const access = await requirePageAccess(tx, caller, await requirePage(tx, input.pageId));
    if (!canEdit(access)) throw new ContentError('not-found');
    if (!access.canPublish) throw new ContentError('forbidden');
    const share = await lockShare(tx, access.share);
    const page = await requirePage(tx, input.pageId, { lock: true });
    const row = await requirePublicationAt(tx, page.id);
    const heads = await headsOf(tx, page.id, { lock: true });
    if (!heads) throw new ContentError('not-found');
    if (await replayed(tx, input.revision, { pageId: page.id, audience: 'draft' }))
      return { revisionId: input.revision.record.revisionId, replayed: true };
    if (page.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    const current = { draftHead: heads.draftHead, publishedHead: heads.publishedHead };
    // A copy has no draft until it is detached (`saveDraft` refuses its first).
    if (heads.draftHead !== null) {
      throw new ContentError('stale-head', 'This page has a draft already', current);
    }
    await verifyRevisionCommit(tx, input, {
      author: caller.identity,
      spaceId: page.spaceId,
      pageId: page.id,
      audience: 'draft',
      basedOn: null,
      share,
      heads: current,
    });
    await storeRevision(tx, input, {
      accountId: caller.accountId,
      storageBytes: input.storageBytes,
      draftSeq: heads.draftCount + 1,
      publishedSeq: null,
      restoredFrom: null,
    });
    await tx
      .update(pageHeads)
      .set({
        draftHead: input.revision.record.revisionId,
        draftCount: heads.draftCount + 1,
        updatedAt: sql`now()`,
      })
      .where(eq(pageHeads.pageId, page.id));
    if (row.detachedAt === null) {
      await tx
        .update(publications)
        .set({ detachedAt: sql`now()` })
        .where(eq(publications.destinationPageId, page.id));
    }
    return { revisionId: input.revision.record.revisionId, replayed: false };
  });
}

/**
 * End the source page's live publication in `spaceId` (section 13), for
 * someone who can publish the source, even where they can't see its copy,
 * so a copy nobody at the source can reach never keeps its publishers from
 * that space. A copy with versions stays as it is, a page of its own that
 * its publishers there detach to edit; an opening that never got a version
 * is removed, since nobody saw it. Whether there was one to end.
 */
export async function endPublication(
  db: Database,
  input: { actor: Actor; sourcePageId: string; spaceId: string },
): Promise<{ ended: boolean }> {
  return db.transaction(async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    await requireSourcePublisher(tx, caller, input.sourcePageId);
    const live = await livePublication(tx, {
      sourcePageId: input.sourcePageId,
      spaceId: input.spaceId,
    });
    if (!live) return { ended: false };
    const pageId = live.destinationPageId;
    await lockSpace(tx, input.spaceId);
    await shareAt(tx, input.spaceId, pageId, { lock: 'share' });
    const [page] = await tx.select().from(nodes).where(eq(nodes.id, pageId)).for('update');
    if (!page) return { ended: false };
    const row = await publicationAt(tx, pageId);
    if (row?.detachedAt !== null) return { ended: false };
    if ((await headsOf(tx, pageId, { lock: true })) === null) {
      // Nothing was ever published there, so nobody saw it.
      await tx.delete(nodes).where(eq(nodes.id, pageId));
    } else {
      await tx
        .update(publications)
        .set({ detachedAt: sql`now()` })
        .where(eq(publications.destinationPageId, pageId));
    }
    return { ended: true };
  });
}

/**
 * End the live publications of the pages a delete removes (`pageIds`, all
 * in its space, held for update), so a page made later with one of their
 * IDs has none of them (section 13). A copy with versions stays, as
 * `endPublication` leaves it; an opening that never got a version goes,
 * since nobody saw it, and the hashes of what was uploaded for it are
 * returned, for their files to go once the delete commits.
 *
 * Copies and openings are in other spaces, so nothing here waits for them
 * (the module's lock order): if anyone holds one, the delete is refused as
 * `busy`, to be tried again. It holds the publications into its own pages
 * the same way before its cascade removes them, so two deletes that each
 * end a publication into the other's pages can't wait on each other.
 */
export async function endPublicationsFrom(
  tx: Database,
  pageIds: readonly string[],
): Promise<string[]> {
  const deleted = new Set(pageIds);
  try {
    const held = await tx
      .select({ pageId: publications.destinationPageId, sourcePageId: publications.sourcePageId })
      .from(publications)
      .where(
        or(
          and(inArray(publications.sourcePageId, pageIds), isNull(publications.detachedAt)),
          inArray(publications.destinationPageId, pageIds),
        ),
      )
      .for('update', { noWait: true });
    const ending = held.flatMap((row) => (deleted.has(row.sourcePageId) ? [row.pageId] : []));
    if (ending.length === 0) return [];
    // Read once the rows are held, so a send that gave one its first
    // version has committed, and shows.
    const sent = new Set(
      (
        await tx
          .select({ pageId: pageHeads.pageId })
          .from(pageHeads)
          .where(inArray(pageHeads.pageId, ending))
      ).map((heads) => heads.pageId),
    );
    const copies = ending.filter((pageId) => sent.has(pageId));
    const openings = ending.filter((pageId) => !sent.has(pageId));
    if (copies.length > 0) {
      await tx
        .update(publications)
        .set({ detachedAt: sql`now()` })
        .where(inArray(publications.destinationPageId, copies));
    }
    if (openings.length === 0) return [];
    // As `sweepOpenings` removes one: its space, then the page.
    await tx
      .select({ id: spaces.id })
      .from(spaces)
      .innerJoin(nodes, eq(nodes.spaceId, spaces.id))
      .where(inArray(nodes.id, openings))
      .for('key share', { of: spaces, noWait: true });
    await tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(inArray(nodes.id, openings))
      .for('update', { noWait: true });
    const uploaded = await tx
      .select({ hash: blobs.hash })
      .from(blobs)
      .where(inArray(blobs.pageId, openings));
    await tx.delete(nodes).where(inArray(nodes.id, openings));
    return uploaded.map((blob) => blob.hash);
  } catch (error) {
    if (!isLockNotAvailable(error)) throw error;
    throw new ContentError(
      'busy',
      'Someone is changing a page this one is published to. Try again in a moment.',
    );
  }
}

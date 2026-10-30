// Copying a page or folder, with everything under it, as new nodes under a
// folder of any space, and moving one into another space: a copy that
// deletes its source when it finishes (protocol section 10, "Copies, and
// moves between spaces"; ADR 0007).
//
// A copy is made in three steps, as a publication into another space is.
// Opening makes the new nodes, hidden: nobody has access to them
// (`isHidden`), no tree lists them, and they count for nothing outside
// their copy. Only the opener uploads attachments to them and sends their
// records, each node's in one entry that replaces what it sent before. The
// finish checks everything again under locks on both spaces, taken in ID
// order, shows the new nodes and, for a move, deletes the source as
// deleting it would. A source head that moved on is `stale-head`, naming
// the nodes to seal again; any other refusal at the finish deletes the copy.
// A finished copy is kept a day, no longer holding its nodes, so a finish or
// cancel sent again answers as the finish did.
//
// Locks, in order: the spaces (key share, by ID), the copy's row, the
// destination's share, then nodes; a move's finish then holds the source's
// shares and subtree as a delete does (`holdSubtree`).
import type { copyRoutes } from '@wikistow/contracts';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../admin/audit.ts';
import type { BlobStore } from '../blobs/store.ts';
import type { Database } from '../db/client.ts';
import { transactOnce, type Once } from '../idempotency.ts';
import {
  copies,
  copyNodes,
  keyEnvelopes,
  metadataRevisions,
  metadataWraps,
  nodes,
  pageHeads,
  publications,
  revisions,
  revisionWraps,
  spaces,
} from '../db/schema/index.ts';
import {
  accessTo,
  canEdit,
  isOwner,
  lockShare,
  lockSpace,
  pathUp,
  requireRoom,
  subtreeOf,
  type Holder,
  type ShareRow,
} from './access.ts';
import { ContentError } from './errors.ts';
import { requireCaller, type Actor, type Caller } from './identities.ts';
import { DEFAULT_CONTENT_LIMITS, requireCapacity } from './limits.ts';
import {
  deleteUnlistedFile,
  holdSubtree,
  removeSubtree,
  storeRevision,
  verifyRevisionCommit,
} from './pages.ts';
import { insertChunked } from './sharing.ts';
import { storeMetadata, verifyMetadataCommit } from './structure.ts';

type CopyRow = typeof copies.$inferSelect;
type Open = z.output<typeof copyRoutes.open.body>;
type Entry = z.output<typeof copyRoutes.CopiedRecords>;

/**
 * A node of a source subtree as trees list it, with the heads a copy of it
 * is sealed from. A publication opening nobody finished isn't listed: it has
 * no heads yet. A copy's hidden nodes aren't either (`subtreeOf`).
 */
type Listed = {
  id: string;
  parentId: string | null;
  kind: 'folder' | 'page';
  depth: number;
  permissionVersion: number;
  metadataHead: string | null;
  draftHead: string | null;
  publishedHead: string | null;
};

async function listedSubtree(tx: Database, spaceId: string, nodeId: string): Promise<Listed[]> {
  const rows = await tx.execute<{
    id: string;
    parent_id: string | null;
    kind: 'folder' | 'page';
    depth: number;
    permission_version: string | number;
    metadata_head: string | null;
    draft_head: string | null;
    published_head: string | null;
  }>(sql`
    ${subtreeOf(spaceId, nodeId)}
    select n.id, n.parent_id, n.kind, s.depth, n.permission_version, n.metadata_head,
      h.draft_head, h.published_head
    from subtree s join nodes n on n.id = s.id
    left join page_heads h on h.page_id = n.id
    where n.copy_id is null and (n.kind = 'folder' or h.page_id is not null)
    order by s.depth, n.id`);
  return [...rows].map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    depth: Number(row.depth),
    permissionVersion: Number(row.permission_version),
    metadataHead: row.metadata_head,
    draftHead: row.draft_head,
    publishedHead: row.published_head,
  }));
}

// Both spaces, in the database's order of their IDs, so two copies between
// them, either way round, never wait on each other.
async function lockSpaces(tx: Database, ...spaceIds: string[]) {
  for (const spaceId of [...new Set(spaceIds)].sort()) await lockSpace(tx, spaceId);
}

/** A folder's or the space's permission version, or not-found. */
async function parentVersion(tx: Database, spaceId: string, parentId: string | null) {
  const [parent] =
    parentId === null
      ? await tx
          .select({ permissionVersion: spaces.permissionVersion })
          .from(spaces)
          .where(eq(spaces.id, spaceId))
      : await tx
          .select({ permissionVersion: nodes.permissionVersion })
          .from(nodes)
          .where(
            and(
              eq(nodes.id, parentId),
              eq(nodes.spaceId, spaceId),
              eq(nodes.kind, 'folder'),
              isNull(nodes.copyId),
            ),
          );
  if (!parent) throw new ContentError('not-found');
  return parent.permissionVersion;
}

const requireVersion = (actual: number, given: number) => {
  if (actual !== given) {
    throw new ContentError('permission-version', 'Access changed; reload and try again');
  }
};

/**
 * Who may copy (section 10, **Who**), checked at the opening and again at
 * the finish: for a move, an owner of the source space, a person; for a
 * copy, someone who can edit at the source node, which an agent may within
 * its picks, and which covers everything under it, since shares don't
 * nest; and for both, someone who can make pages at the destination
 * parent. Their access there, and its share. A source node deleted
 * meanwhile is not-found; nodes under it deleted meanwhile don't matter to
 * a copy, which shows what was sealed from them.
 */
async function requireCopier(
  tx: Database,
  caller: Caller,
  copy: Pick<
    CopyRow,
    'kind' | 'sourceSpaceId' | 'sourceNodeId' | 'destinationSpaceId' | 'destinationParentId'
  >,
): Promise<{ share: ShareRow | null; canPublish: boolean }> {
  const holder: Holder = caller;
  if (copy.kind === 'move') {
    // Moves are for people, as sharing is (section 9.5).
    if (caller.personId !== null || !(await isOwner(tx, caller.identity.id, copy.sourceSpaceId))) {
      const access = await accessTo(tx, holder, {
        spaceId: copy.sourceSpaceId,
        nodeId: copy.sourceNodeId,
      });
      throw new ContentError(
        access ? 'forbidden' : 'not-found',
        'Only an owner of its space moves a page or folder into another space',
      );
    }
  } else {
    // Owners have access anywhere in their space, so the node is looked for first.
    const [there] = await tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.id, copy.sourceNodeId),
          eq(nodes.spaceId, copy.sourceSpaceId),
          isNull(nodes.copyId),
        ),
      );
    const access =
      there && (await accessTo(tx, holder, { spaceId: copy.sourceSpaceId, nodeId: there.id }));
    if (!access) throw new ContentError('not-found');
    if (!canEdit(access)) {
      throw new ContentError('forbidden', 'Only someone who can edit it copies it');
    }
  }
  const at = await accessTo(tx, holder, {
    spaceId: copy.destinationSpaceId,
    nodeId: copy.destinationParentId,
  });
  if (!at) throw new ContentError('not-found');
  if (!canEdit(at)) throw new ContentError('forbidden');
  return { share: at.share, canPublish: at.canPublish };
}

/**
 * Open a copy (section 10, step 1): check who may make it, that both
 * permission versions are those the preview was made at, that it isn't
 * refused, and that `nodes` mirror the source subtree's listed nodes as they
 * are now, under the same parents; then make them, hidden, in the
 * destination parent's region, under its permission version. Asked again
 * with the same `Idempotency-Key`, it is answered as before.
 */
export async function openCopy(
  db: Database,
  input: {
    actor: Actor;
    maxPages?: number;
    maxFolders?: number;
    once?: Once | undefined;
  } & Open,
) {
  return transactOnce(db, input.once, async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    if (input.kind === 'move' && input.sourceSpaceId === input.destinationSpaceId) {
      throw new ContentError('forbidden', 'A move within one space is an ordinary move');
    }
    await lockSpaces(tx, input.sourceSpaceId, input.destinationSpaceId);
    const listed = await listedSubtree(tx, input.sourceSpaceId, input.sourceNodeId);
    const [top] = listed;
    if (top?.id !== input.sourceNodeId) throw new ContentError('not-found');
    const copy = {
      kind: input.kind,
      sourceSpaceId: input.sourceSpaceId,
      sourceNodeId: input.sourceNodeId,
      destinationSpaceId: input.destinationSpaceId,
      destinationParentId: input.parentId,
    };
    const who = await requireCopier(tx, caller, copy);
    if (input.bringsPublished && !who.canPublish) {
      throw new ContentError('forbidden', 'Published versions go only where you can publish');
    }
    requireVersion(top.permissionVersion, input.sourcePermissionVersion);
    const permissionVersion = await parentVersion(tx, input.destinationSpaceId, input.parentId);
    requireVersion(permissionVersion, input.permissionVersion);

    const path = await pathUp(tx, input.destinationSpaceId, input.parentId);
    if (input.sourceSpaceId === input.destinationSpaceId && path?.includes(input.sourceNodeId)) {
      throw new ContentError('binding-mismatch', 'Nothing copies into itself');
    }
    requireRoom(path, Math.max(...listed.map((node) => node.depth)) + 1);
    await requireNoPublication(
      tx,
      listed.flatMap((node) => (node.kind === 'page' ? [node.id] : [])),
    );
    // A page with neither a draft nor a publication, as one whose publication
    // ended and was then unpublished, has nothing to copy.
    const empty = listed.filter(
      (node) => node.kind === 'page' && node.draftHead === null && node.publishedHead === null,
    );
    if (empty.length > 0) {
      throw new ContentError('forbidden', 'A page with no version is published again first', {
        nodeIds: empty.slice(0, NAMED).map((node) => node.id),
      });
    }
    const mirrored = mirror(input, listed);

    for (const kind of ['folder', 'page'] as const) {
      const adding = listed.filter((node) => node.kind === kind).length;
      if (adding === 0) continue;
      const maximum =
        kind === 'folder'
          ? (input.maxFolders ?? DEFAULT_CONTENT_LIMITS.folders)
          : (input.maxPages ?? DEFAULT_CONTENT_LIMITS.pages);
      await requireCapacity(tx, caller.accountId, kind, maximum, adding);
    }
    const opened = await tx
      .insert(copies)
      .values({
        id: input.copyId,
        kind: input.kind,
        bringsPublished: input.bringsPublished,
        openedBy: caller.accountId,
        openerId: caller.identity.id,
        sourceSpaceId: input.sourceSpaceId,
        sourceNodeId: input.sourceNodeId,
        sourcePermissionVersion: input.sourcePermissionVersion,
        destinationSpaceId: input.destinationSpaceId,
        destinationParentId: input.parentId,
        permissionVersion,
      })
      .onConflictDoNothing()
      .returning({ id: copies.id });
    if (opened.length === 0) throw new ContentError('duplicate', 'That copy ID is taken');
    // Parents first: `listed` is in order of depth.
    let made = 0;
    await insertChunked(mirrored, async (chunk) => {
      const rows = await tx
        .insert(nodes)
        .values(
          chunk.map(({ node }) => ({
            id: node.nodeId,
            spaceId: input.destinationSpaceId,
            parentId: node.parentId,
            kind: node.kind,
            createdBy: caller.accountId,
            permissionVersion,
            copyId: input.copyId,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: nodes.id });
      made += rows.length;
    });
    if (made !== mirrored.length) throw new ContentError('duplicate', 'A node ID is taken');
    await insertChunked(mirrored, (chunk) =>
      tx.insert(copyNodes).values(
        chunk.map(({ node, source }) => ({
          nodeId: node.nodeId,
          copyId: input.copyId,
          sourceId: source.id,
          sourceParentId: source.id === input.sourceNodeId ? null : source.parentId,
        })),
      ),
    );
    return { copyId: input.copyId };
  });
}

/**
 * The new nodes paired with the listed source nodes they copy, in the
 * order of `listed`, if they mirror them exactly: one each, of its kind,
 * under the copy of its parent, the top one under the destination parent.
 * Otherwise the source changed since the preview (`stale-head`).
 */
function mirror(input: Open, listed: readonly Listed[]) {
  const bySource = new Map(input.nodes.map((node) => [node.sourceId, node]));
  const newIds = new Set(input.nodes.map((node) => node.nodeId));
  const stale = () =>
    new ContentError('stale-head', 'What you are copying changed since you looked');
  if (bySource.size !== input.nodes.length || newIds.size !== input.nodes.length) {
    throw new ContentError('binding-mismatch', 'A node is listed twice');
  }
  if (input.nodes.length !== listed.length) throw stale();
  return listed.map((source) => {
    const node = bySource.get(source.id);
    const parentId =
      source.id === input.sourceNodeId
        ? input.parentId
        : (bySource.get(source.parentId ?? '')?.nodeId ?? null);
    if (!node || node.kind !== source.kind || node.parentId !== parentId) throw stale();
    return { node, source };
  });
}

/** How many pages a refusal of the opening names, at most (`detail.nodeIds`). */
const NAMED = 100;

/**
 * Refuse a source holding a live publication from another page (section
 * 13): one with a version, not detached, the first hundred named in
 * `detail.nodeIds` so the dialog lists them. Its publishers detach them first. An opening nobody
 * finished has no version, and isn't listed anyway.
 */
async function requireNoPublication(tx: Database, pageIds: readonly string[]) {
  if (pageIds.length === 0) return;
  const live = await tx
    .selectDistinct({ pageId: publications.destinationPageId })
    .from(publications)
    .innerJoin(pageHeads, eq(pageHeads.pageId, publications.destinationPageId))
    .where(
      and(
        isNull(publications.detachedAt),
        sql`${publications.destinationPageId} = any(${sql.param([...pageIds])}::text[])`,
      ),
    )
    .orderBy(publications.destinationPageId)
    .limit(NAMED);
  if (live.length > 0) {
    throw new ContentError(
      'forbidden',
      'A page published from another page is detached before it is copied',
      { nodeIds: live.map((row) => row.pageId) },
    );
  }
}

/**
 * The copy, for its opener; not-found for anyone else, and once it finished,
 * unless `finished` is set. Held for the change when `lock` is set.
 */
async function requireOpener(
  tx: Database,
  caller: Caller,
  copyId: string,
  { lock = false, finished = false } = {},
) {
  const query = tx.select().from(copies).where(eq(copies.id, copyId));
  const [copy] = lock ? await query.for('update') : await query;
  if (!copy || copy.openerId !== caller.identity.id) throw new ContentError('not-found');
  if (copy.finishedAt !== null && !finished) throw new ContentError('not-found');
  return copy;
}

/**
 * For records' large body, before it is read: the caller opened the copy,
 * or is refused as sending would refuse them. Sending checks it again.
 */
export async function checkCopyOpener(db: Database, actor: Actor, copyId: string) {
  await requireOpener(db, await requireCaller(db, actor), copyId);
}

/**
 * A hidden page's access for an upload (`uploadBlob`): only its copy's
 * opener uploads to it, as they could make pages at the copy's destination,
 * and published attachments only where they can publish. Every upload
 * counts as a request, so the sweep leaves the copy a day more.
 */
export async function copyUploadAccess(db: Database, caller: Caller, copyId: string) {
  const copy = await requireOpener(db, caller, copyId);
  const access = await accessTo(db, caller, {
    spaceId: copy.destinationSpaceId,
    nodeId: copy.destinationParentId,
  });
  await db
    .update(copies)
    .set({ touchedAt: sql`now()` })
    .where(eq(copies.id, copyId));
  return access;
}

/**
 * Store records for the copy's new nodes (section 10, step 2), for its
 * opener, as the hidden nodes' own versions at once, so the attachments
 * they list are committed as any write's are: each entry replaces the
 * records sent for its node before, and is checked as any write is in the
 * destination parent's region, at the parent's (or for the top of the
 * space, the space's) permission version sent at the opening
 * (`permission-version` otherwise, which ends the copy, as at the finish:
 * the app previews again), under its current key version, apart from
 * the head check: every record is a first version (`basedOn` null, or for
 * a published version, the draft of its own entry), written by the caller.
 * Each names a version of its node's source it was
 * sealed from. An entry holds one set of records, of one node listed once:
 * a folder's metadata, or a page's draft and at most one published version,
 * each of its own audience (`verifyRevisionCommit`). A published version
 * goes only in a copy that brings them, where the caller can still publish:
 * its audience is all the server sees of it.
 */
export async function sendCopyRecords(
  db: Database,
  store: BlobStore,
  input: { actor: Actor; copyId: string; nodes: Entry[]; storageBytes: number },
) {
  if (new Set(input.nodes.map((entry) => entry.nodeId)).size !== input.nodes.length) {
    throw new ContentError('binding-mismatch', 'A node is listed twice');
  }
  let opener: Caller | null = null;
  try {
    await db.transaction(async (tx) => {
      const caller = await requireCaller(tx, input.actor);
      const found = await requireOpener(tx, caller, input.copyId);
      opener = caller;
      await lockSpace(tx, found.destinationSpaceId);
      const copy = await requireOpener(tx, caller, input.copyId, { lock: true });
      const access = await accessTo(tx, caller, {
        spaceId: copy.destinationSpaceId,
        nodeId: copy.destinationParentId,
      });
      if (!access) throw new ContentError('not-found');
      if (!canEdit(access)) throw new ContentError('forbidden');
      const share = await lockShare(tx, access.share);
      // The records are written for the parent as it was at the opening.
      requireVersion(
        await parentVersion(tx, copy.destinationSpaceId, copy.destinationParentId),
        copy.permissionVersion,
      );
      await tx
        .update(copies)
        .set({ touchedAt: sql`now()` })
        .where(eq(copies.id, copy.id));
      for (const entry of input.nodes) {
        const [node] = await tx
          .select({ kind: nodes.kind, sourceId: copyNodes.sourceId })
          .from(copyNodes)
          .innerJoin(nodes, eq(nodes.id, copyNodes.nodeId))
          .where(and(eq(copyNodes.nodeId, entry.nodeId), eq(copyNodes.copyId, copy.id)))
          .for('update', { of: nodes });
        if (!node) throw new ContentError('not-found');
        if (node.kind !== entry.kind) {
          throw new ContentError('binding-mismatch', 'Those records are for another kind of node');
        }
        const target = {
          copy,
          share,
          caller,
          sourceId: node.sourceId,
          storageBytes: input.storageBytes,
        };
        if (entry.kind === 'page') {
          if (entry.published && !(copy.bringsPublished && access.canPublish)) {
            throw new ContentError('forbidden', 'This copy brings no published versions');
          }
          await clearPage(tx, entry.nodeId);
          await storePage(tx, entry, target);
        } else {
          await clearFolder(tx, entry.nodeId);
          await storeFolder(tx, entry, target);
        }
      }
    });
  } catch (error) {
    // Access at the destination changed since the opening: the copy ends, as at the finish.
    if (opener && error instanceof ContentError && error.code === 'permission-version') {
      await dropCopy(db, store, opener, input.copyId).catch(() => undefined);
    }
    throw error;
  }
}

type Target = {
  copy: CopyRow;
  share: ShareRow | null;
  caller: Caller;
  sourceId: string;
  storageBytes: number;
};

/**
 * Remove what was sent for a hidden page before: its versions with their
 * key material, and its heads. Attachments only they listed are left for
 * the sweep of attachments nothing lists (`sweepBlobs`).
 */
async function clearPage(tx: Database, pageId: string) {
  const sent = tx.select({ id: revisions.id }).from(revisions).where(eq(revisions.pageId, pageId));
  await tx
    .delete(keyEnvelopes)
    .where(and(eq(keyEnvelopes.subjectKind, 'revision'), inArray(keyEnvelopes.subjectId, sent)));
  // Their wraps and attachment lists go with them.
  await tx.delete(revisions).where(eq(revisions.pageId, pageId));
  await tx.delete(pageHeads).where(eq(pageHeads.pageId, pageId));
}

/** Remove what was sent for a hidden folder before: its metadata and key material. */
async function clearFolder(tx: Database, folderId: string) {
  const named = and(
    eq(metadataRevisions.subjectKind, 'folder'),
    eq(metadataRevisions.subjectId, folderId),
  );
  await tx
    .delete(keyEnvelopes)
    .where(
      and(
        eq(keyEnvelopes.subjectKind, 'metadata'),
        inArray(
          keyEnvelopes.subjectId,
          tx.select({ id: metadataRevisions.id }).from(metadataRevisions).where(named),
        ),
      ),
    );
  await tx.update(nodes).set({ metadataHead: null }).where(eq(nodes.id, folderId));
  await tx.delete(metadataRevisions).where(named);
}

// The source version a record names must be one of its source's: of its
// audience, or for a draft, the publication of a page with no draft, such as
// a publication ended without being detached (section 10).
async function requireSourceRevision(
  tx: Database,
  { sourceId, revisionId, audience }: { sourceId: string; revisionId: string; audience: string },
) {
  const [version] = await tx
    .select({ id: revisions.id })
    .from(revisions)
    .where(
      and(
        eq(revisions.id, revisionId),
        eq(revisions.pageId, sourceId),
        audience === 'draft' ? undefined : sql`${revisions.audience} = ${audience}`,
      ),
    );
  if (!version) throw new ContentError('not-found', 'That version of the source isn’t there');
}

async function storePage(
  tx: Database,
  entry: Extract<Entry, { kind: 'page' }>,
  { copy, share, caller, sourceId, storageBytes }: Target,
) {
  // The draft first: a published version names it as its base when the
  // source's was made from its current draft, or it had none, so the copy
  // shows no unpublished changes where the source had none (section 10).
  const draftId = entry.draft.revision.record.revisionId;
  const versions = [
    { audience: 'draft' as const, version: entry.draft, basedOn: null },
    ...(entry.published
      ? [
          {
            audience: 'published' as const,
            version: entry.published,
            basedOn: entry.published.revision.record.basedOn === draftId ? draftId : null,
          },
        ]
      : []),
  ];
  for (const { audience, version, basedOn } of versions) {
    await requireSourceRevision(tx, { sourceId, revisionId: version.sourceRevisionId, audience });
    const commit = { ...version, permissionVersion: copy.permissionVersion };
    await verifyRevisionCommit(tx, commit, {
      author: caller.identity,
      spaceId: copy.destinationSpaceId,
      pageId: entry.nodeId,
      audience,
      basedOn,
      share,
      heads: null,
    });
    await storeRevision(tx, commit, {
      accountId: caller.accountId,
      storageBytes,
      draftSeq: audience === 'draft' ? 1 : null,
      publishedSeq: audience === 'published' ? 1 : null,
      restoredFrom: null,
    });
  }
  await tx.insert(pageHeads).values({
    pageId: entry.nodeId,
    draftHead: entry.draft.revision.record.revisionId,
    draftCount: 1,
    publishedHead: entry.published?.revision.record.revisionId ?? null,
    publishedCount: entry.published ? 1 : 0,
  });
  // The source versions are kept here, not as the revisions' own source,
  // which draft retention keeps for a publication's label: a copy pins none.
  await tx
    .update(copyNodes)
    .set({
      draftFrom: entry.draft.sourceRevisionId,
      publishedFrom: entry.published?.sourceRevisionId ?? null,
    })
    .where(eq(copyNodes.nodeId, entry.nodeId));
}

async function storeFolder(
  tx: Database,
  entry: Extract<Entry, { kind: 'folder' }>,
  { copy, share, caller, sourceId, storageBytes }: Target,
) {
  const [source] = await tx
    .select({ id: metadataRevisions.id })
    .from(metadataRevisions)
    .where(
      and(
        eq(metadataRevisions.id, entry.sourceMetadataRevisionId),
        eq(metadataRevisions.subjectKind, 'folder'),
        eq(metadataRevisions.subjectId, sourceId),
      ),
    );
  if (!source) throw new ContentError('not-found', 'That name of the source isn’t there');
  await verifyMetadataCommit(tx, entry, {
    author: caller.identity,
    spaceId: copy.destinationSpaceId,
    subjectKind: 'folder',
    subjectId: entry.nodeId,
    basedOn: null,
    share,
  });
  await storeMetadata(tx, entry, { accountId: caller.accountId, storageBytes });
  await tx
    .update(nodes)
    .set({ metadataHead: entry.metadata.record.metadataRevisionId })
    .where(eq(nodes.id, entry.nodeId));
  await tx
    .update(copyNodes)
    .set({ metadataFrom: entry.sourceMetadataRevisionId })
    .where(eq(copyNodes.nodeId, entry.nodeId));
}

/**
 * Finish a copy (section 10, step 3), for its opener: check again who may
 * make it, that every new node has its records, that the destination
 * parent's permission version, region and current key version are those
 * the records were written at, and for a move, that the source node's
 * permission version is the one sent at the opening, its listed subtree is
 * still the one mirrored, and every source head an entry named is still
 * current. Then, at once, show the new nodes and, for a move, delete the
 * source as deleting it would. A head that moved on is `stale-head`,
 * naming the new nodes to seal again (`detail.nodeIds`), and the copy
 * stays; so it does when it is busy (`rate-limited`), as while a
 * publication the source's delete ends is being written, to finish again
 * shortly. Any other refusal deletes it, as does `stale-head` for a changed
 * subtree, which names none. A copy that finished already is answered as
 * it was, for a day (section 10), and nothing changes.
 */
export async function finishCopy(
  db: Database,
  store: BlobStore,
  input: { actor: Actor; copyId: string },
) {
  let opener: Caller | null = null;
  try {
    const hashes = await db.transaction(async (tx) => {
      const caller = await requireCaller(tx, input.actor);
      const found = await requireOpener(tx, caller, input.copyId, { finished: true });
      if (found.finishedAt !== null) return [];
      opener = caller;
      await lockSpaces(tx, found.sourceSpaceId, found.destinationSpaceId);
      const copy = await requireOpener(tx, caller, input.copyId, { lock: true, finished: true });
      if (copy.finishedAt !== null) return [];
      return finishHeld(tx, caller, copy);
    });
    for (const hash of hashes) await deleteUnlistedFile(db, store, hash);
  } catch (error) {
    const retry =
      error instanceof ContentError &&
      ((error.code === 'stale-head' && error.detail.nodeIds !== undefined) ||
        error.code === 'busy');
    if (opener && error instanceof ContentError && !retry) {
      await dropCopy(db, store, opener, input.copyId).catch(() => undefined);
    }
    throw error;
  }
}

async function finishHeld(tx: Database, caller: Caller, copy: CopyRow): Promise<string[]> {
  const made = await tx
    .select({
      nodeId: copyNodes.nodeId,
      sourceId: copyNodes.sourceId,
      sourceParentId: copyNodes.sourceParentId,
      kind: nodes.kind,
      draftFrom: copyNodes.draftFrom,
      publishedFrom: copyNodes.publishedFrom,
      metadataFrom: copyNodes.metadataFrom,
    })
    .from(copyNodes)
    .innerJoin(nodes, eq(nodes.id, copyNodes.nodeId))
    .where(eq(copyNodes.copyId, copy.id));
  // Every new node is shown, those whose source is gone with what was sealed from it.
  const who = await requireCopier(tx, caller, copy);
  if (!who.canPublish && (copy.bringsPublished || made.some((n) => n.publishedFrom !== null))) {
    throw new ContentError('forbidden', 'You can no longer publish there');
  }
  requireVersion(
    await parentVersion(tx, copy.destinationSpaceId, copy.destinationParentId),
    copy.permissionVersion,
  );
  const share = await lockShare(tx, who.share);
  // The nodes made at the opening, every one with its records.
  const [hidden] = await tx.select({ count: count() }).from(nodes).where(eq(nodes.copyId, copy.id));
  const missing = made.some((node) =>
    node.kind === 'page' ? node.draftFrom === null : node.metadataFrom === null,
  );
  const top = made.find((node) => node.sourceParentId === null);
  if (missing || !top || hidden?.count !== made.length) {
    throw new ContentError('not-found', 'Some of what you are copying has no records yet');
  }
  await requireRegion(tx, copy, share);

  let removed: string[] = [];
  if (copy.kind === 'move') {
    const held = await holdSubtree(tx, { spaceId: copy.sourceSpaceId, nodeId: copy.sourceNodeId });
    const listed = await listedSubtree(tx, copy.sourceSpaceId, copy.sourceNodeId);
    requireVersion(listed[0]?.permissionVersion ?? -1, copy.sourcePermissionVersion);
    const stale = staleNodes(made, listed, copy);
    if (stale.length > 0) {
      throw new ContentError('stale-head', 'Some of what you are moving changed since', {
        nodeIds: stale,
      });
    }
    removed = await removeSubtree(tx, copy.sourceSpaceId, copy.sourceNodeId, held);
  }
  // Shown, and no longer the copy's: removing it later leaves them.
  await tx.update(nodes).set({ copyId: null }).where(eq(nodes.copyId, copy.id));
  await tx.delete(copyNodes).where(eq(copyNodes.copyId, copy.id));
  await tx
    .update(copies)
    .set({ finishedAt: sql`now()`, touchedAt: sql`now()` })
    .where(eq(copies.id, copy.id));
  await audit(tx, {
    actor: copy.openedBy,
    action: copy.kind === 'move' ? 'node.moved-between-spaces' : 'node.copied',
    target: { kind: 'node', id: copy.sourceNodeId },
    details: {
      spaceId: copy.sourceSpaceId,
      toSpaceId: copy.destinationSpaceId,
      nodeId: top.nodeId,
      nodes: made.length,
    },
  });
  return removed;
}

/**
 * The records of the copy's nodes are all in the destination parent's
 * region (`share`, or the owner region) under its current key version.
 * Owners changing moves the parent's permission version on, which the
 * finish checks first.
 */
async function requireRegion(tx: Database, copy: CopyRow, share: ShareRow | null) {
  const hidden = tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.copyId, copy.id));
  const pageWraps = await tx
    .select({ shareId: revisionWraps.shareId, keyVersion: revisionWraps.keyVersion })
    .from(revisions)
    .leftJoin(revisionWraps, eq(revisionWraps.revisionId, revisions.id))
    .where(inArray(revisions.pageId, hidden));
  const nameWraps = await tx
    .select({ shareId: metadataWraps.shareId, keyVersion: metadataWraps.keyVersion })
    .from(metadataRevisions)
    .leftJoin(metadataWraps, eq(metadataWraps.metadataRevisionId, metadataRevisions.id))
    .where(
      and(
        eq(metadataRevisions.subjectKind, 'folder'),
        inArray(metadataRevisions.subjectId, hidden),
      ),
    );
  for (const wrap of [...pageWraps, ...nameWraps]) {
    if ((wrap.shareId ?? null) !== (share?.id ?? null)) {
      throw new ContentError('region-mismatch', 'Where you are copying to changed since');
    }
    if (share && wrap.keyVersion !== share.currentKeyVersion) {
      throw new ContentError('key-version', 'The share has another key version', {
        shareId: share.id,
        keyVersion: share.currentKeyVersion,
      });
    }
  }
}

/**
 * For a move, the new nodes whose source heads moved on since they were
 * sealed: a page's draft (its publication, for a page with no draft, so
 * one that has a draft now is stale), and
 * when the copy brings published versions, its published head, none for a
 * page not published; a folder's metadata head. If the listed source subtree isn't the one
 * mirrored, under the same parents, the move can't go on: `stale-head`
 * naming no nodes.
 */
function staleNodes(
  made: readonly {
    nodeId: string;
    sourceId: string;
    sourceParentId: string | null;
    kind: 'folder' | 'page';
    draftFrom: string | null;
    publishedFrom: string | null;
    metadataFrom: string | null;
  }[],
  listed: readonly Listed[],
  copy: CopyRow,
): string[] {
  const now = new Map(listed.map((node) => [node.id, node]));
  const same =
    listed.length === made.length &&
    made.every((node) => {
      const source = now.get(node.sourceId);
      return (
        source !== undefined &&
        source.kind === node.kind &&
        (node.sourceId === copy.sourceNodeId ? null : source.parentId) === node.sourceParentId
      );
    });
  if (!same) {
    throw new ContentError('stale-head', 'What you are moving changed since; move it again');
  }
  return made.flatMap((node) => {
    const source = now.get(node.sourceId);
    if (!source) return [];
    const stale =
      node.kind === 'folder'
        ? source.metadataHead !== node.metadataFrom
        : // Always compared: a page sealed with no draft, its publication
          // as its draft, is stale once it has one.
          (source.draftHead ?? source.publishedHead) !== node.draftFrom ||
          (copy.bringsPublished && source.publishedHead !== node.publishedFrom);
    return stale ? [node.nodeId] : [];
  });
}

/**
 * Delete the copy and its hidden nodes, with whatever was sent for them, as
 * deleting a node would; the hashes of their attachments, whose files go
 * once the transaction commits. The caller holds the destination space.
 * Its nodes are held by their copy, not by a walk: nothing but its own
 * nodes is ever under one of them, and no share is rooted in one.
 */
async function dropHeld(tx: Database, copy: CopyRow): Promise<string[]> {
  const [top] = await tx
    .select({ nodeId: copyNodes.nodeId })
    .from(copyNodes)
    .where(and(eq(copyNodes.copyId, copy.id), isNull(copyNodes.sourceParentId)));
  let removed: string[] = [];
  // Gone already if a delete at the destination took it.
  if (top) {
    const held = await tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.copyId, copy.id), eq(nodes.spaceId, copy.destinationSpaceId)))
      .for('update');
    const ids = held.map((node) => node.id);
    if (!ids.includes(top.nodeId)) throw new ContentError('not-found');
    removed = await removeSubtree(tx, copy.destinationSpaceId, top.nodeId, ids);
  }
  await tx.delete(copies).where(eq(copies.id, copy.id));
  return removed;
}

// A copy that finished meanwhile stays, with its nodes.
async function dropCopy(db: Database, store: BlobStore, caller: Caller, copyId: string) {
  const hashes = await db.transaction(async (tx) => {
    const found = await requireOpener(tx, caller, copyId, { finished: true });
    if (found.finishedAt !== null) return [];
    await lockSpace(tx, found.destinationSpaceId);
    const copy = await requireOpener(tx, caller, copyId, { lock: true, finished: true });
    return copy.finishedAt === null ? dropHeld(tx, copy) : [];
  });
  for (const hash of hashes) await deleteUnlistedFile(db, store, hash);
}

/**
 * Delete an unfinished copy and its hidden nodes at once, for its opener.
 * One that finished is answered as its finish was, and stays (section 10).
 */
export async function cancelCopy(
  db: Database,
  store: BlobStore,
  input: { actor: Actor; copyId: string },
) {
  await dropCopy(db, store, await requireCaller(db, input.actor), input.copyId);
}

/**
 * For deleting the space `spaceId`, which the caller holds for update: its
 * unfinished copies into other spaces, with their hidden nodes there and
 * whatever was sent for them, as cancelling does. The cascade from the
 * copy's row would take the nodes, but not their names and key material,
 * which name them by ID. The hashes of their attachments, whose files go
 * once the transaction commits.
 */
export async function dropCopiesFrom(tx: Database, spaceId: string): Promise<string[]> {
  const out = await tx
    .select({ id: copies.id, spaceId: copies.destinationSpaceId })
    .from(copies)
    .where(and(eq(copies.sourceSpaceId, spaceId), isNull(copies.finishedAt)))
    .orderBy(copies.destinationSpaceId, copies.id);
  const hashes: string[] = [];
  for (const { id, spaceId: destinationId } of out) {
    if (destinationId === spaceId) continue;
    await lockSpace(tx, destinationId);
    const [copy] = await tx.select().from(copies).where(eq(copies.id, id)).for('update');
    if (copy && copy.finishedAt === null) hashes.push(...(await dropHeld(tx, copy)));
  }
  return hashes;
}

/**
 * Delete unfinished copies nobody sent anything to since `cutoff`, with
 * their nodes and attachments, as cancelling one does. Each is checked
 * again under the locks sending takes, so one sent to or finished
 * meanwhile stays. How many went, and how many failed, which are left for
 * the next sweep rather than stopping this one. Copies finished before
 * `cutoff` go too, leaving their nodes, and aren't counted.
 */
export async function sweepCopies(
  db: Database,
  store: BlobStore,
  cutoff: Date,
): Promise<{ removed: number; failed: number }> {
  await db.delete(copies).where(sql`${copies.finishedAt} < ${cutoff.toISOString()}`);
  const old = await db
    .select({ id: copies.id, spaceId: copies.destinationSpaceId })
    .from(copies)
    .where(and(isNull(copies.finishedAt), sql`${copies.touchedAt} < ${cutoff.toISOString()}`));
  let removed = 0;
  let failed = 0;
  for (const { id, spaceId } of old) {
    const hashes = await db
      .transaction(async (tx) => {
        const [space] = await tx
          .select({ id: spaces.id })
          .from(spaces)
          .where(eq(spaces.id, spaceId))
          .for('key share');
        if (!space) return null;
        const [copy] = await tx.select().from(copies).where(eq(copies.id, id)).for('update');
        if (!copy || copy.finishedAt !== null || copy.touchedAt >= cutoff) return null;
        return dropHeld(tx, copy);
      })
      .catch(() => {
        failed += 1;
        return null;
      });
    if (!hashes) continue;
    removed += 1;
    for (const hash of hashes) await deleteUnlistedFile(db, store, hash);
  }
  return { removed, failed };
}

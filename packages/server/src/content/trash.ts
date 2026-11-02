// The trash (protocol section 10, "The trash"): a deleted page or folder,
// with everything under it, is kept for `TRASH_DAYS` days before it is deleted
// for good. Its nodes keep their rows, records and keys, marked with their
// trash row (`nodes.trashId`), and drop out of everything that lists or
// opens nodes (`isHidden`, `subtreeOf`, `accessToPages`, the tree). Only a
// space's owners see its trash, restore from it or empty it; agents never.
import { pageRoutes } from '@wikistow/contracts';
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { BlobStore } from '../blobs/store.ts';
import { anyId } from '../db/any.ts';
import type { Database } from '../db/client.ts';
import {
  metadataRevisions,
  metadataWraps,
  nodes,
  pageHeads,
  revisions,
  revisionWraps,
  shares,
  spaceOwners,
  trash,
  users,
} from '../db/schema/index.ts';
import { endLinks } from '../public-links/endings.ts';
import {
  accessTo,
  isHidden,
  isOwner,
  lockSpace,
  MAX_DEPTH,
  pathUp,
  requireRoom,
  shareAt,
  sharesByNode,
  subtreeOf,
} from './access.ts';
import { ContentError } from './errors.ts';
import { humanActor } from './identities.ts';
import {
  deleteUnlistedFile,
  fetchRevisions,
  holdSubtree,
  removeSubtree,
  type RevisionPlace,
} from './pages.ts';
import { servedMetadata } from './serving.ts';
import { bumpPermissions } from './sharing.ts';
import type { ReportUnreadable } from './stored.ts';
import { requireIdentity } from './structure.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// The caller's identity, owning the space, or refused as deleting was before
// the trash: forbidden for someone who can see the node, else not-found.
async function requireSpaceOwner(
  tx: Database,
  accountId: string,
  at: { spaceId: string; nodeId: string | null },
) {
  const identity = await requireIdentity(tx, accountId);
  if (await isOwner(tx, identity.id, at.spaceId)) return identity;
  const access = await accessTo(tx, { identity, personId: null }, at);
  throw new ContentError(access ? 'forbidden' : 'not-found');
}

/**
 * Move a folder or page, with everything under it, to its space's trash
 * (space owners). Its nodes leave every tree at once; its pages' public
 * links end, as deleting has always ended them, and stay off once it is
 * restored. What was already in the trash under it keeps its own row, and
 * a copy's hidden nodes are their copy's (section 10). It holds the space,
 * then the subtree, as deleting for good does.
 */
export async function trashNode(
  db: Database,
  input: { accountId: string; spaceId: string; nodeId: string },
) {
  await db.transaction(async (tx) => {
    await lockSpace(tx, input.spaceId);
    await requireSpaceOwner(tx, input.accountId, input);
    await holdSubtree(tx, input);
    // Looked at once held, so a delete of it that went first is seen.
    if (await isHidden(tx, input.nodeId)) throw new ContentError('not-found');
    const ids = [
      ...(await tx.execute<{ id: string }>(
        sql`${subtreeOf(input.spaceId, input.nodeId)} select id from subtree`,
      )),
    ].map((row) => row.id);
    const [row] = await tx
      .insert(trash)
      .values({ spaceId: input.spaceId, nodeId: input.nodeId, deletedBy: input.accountId })
      .returning({ id: trash.id });
    if (!row) throw new ContentError('not-found');
    await tx
      .update(nodes)
      .set({ trashId: row.id })
      .where(and(anyId(nodes.id, ids), eq(nodes.spaceId, input.spaceId)));
    await endLinks(tx, ids);
    // A write already past its access check, waiting on these rows, then
    // fails rather than landing in the trash.
    await bumpPermissions(tx, input.spaceId, ids);
  });
}

/** The spaces the person owns now. */
async function ownedSpaces(db: Database, identityId: string): Promise<string[]> {
  const rows = await db
    .select({ spaceId: spaceOwners.spaceId })
    .from(spaceOwners)
    .where(and(eq(spaceOwners.identityId, identityId), isNull(spaceOwners.removedAt)));
  return rows.map((row) => row.spaceId);
}

/**
 * Everything in the trash of the spaces the caller owns, newest first, with
 * who deleted it, a folder's name and a page's heads. A folder name whose
 * stored record today's rules refuse comes as none, and is reported.
 */
export async function listTrash(db: Database, accountId: string, report: ReportUnreadable) {
  const identity = await requireIdentity(db, accountId);
  const spaceIds = await ownedSpaces(db, identity.id);
  if (spaceIds.length === 0) return [];
  const rows = await db
    .select({
      trashId: trash.id,
      spaceId: trash.spaceId,
      nodeId: trash.nodeId,
      kind: nodes.kind,
      metadataHead: nodes.metadataHead,
      deletedAt: trash.deletedAt,
      deletedBy: users.name,
      draftHead: pageHeads.draftHead,
      publishedHead: pageHeads.publishedHead,
    })
    .from(trash)
    .innerJoin(nodes, eq(nodes.id, trash.nodeId))
    .leftJoin(users, eq(users.id, trash.deletedBy))
    .leftJoin(pageHeads, eq(pageHeads.pageId, trash.nodeId))
    .where(inArray(trash.spaceId, spaceIds))
    .orderBy(desc(trash.deletedAt), trash.id);
  const names = await servedMetadata(
    db,
    identity,
    rows.flatMap((row) => (row.metadataHead ? [row.metadataHead] : [])),
    report,
  );
  return rows.map(({ metadataHead, deletedAt, deletedBy, draftHead, publishedHead, ...row }) => ({
    ...row,
    deletedAt: deletedAt.toISOString(),
    deletedBy: deletedBy || null,
    name: (metadataHead && names.get(metadataHead)) || null,
    draftHead: draftHead ?? null,
    publishedHead: publishedHead ?? null,
  }));
}

/**
 * Versions of pages in the trash of spaces the caller owns, as owners read
 * them (`fetchRevisions`), so the trash can show their titles.
 */
export function trashRevisions(
  db: Database,
  accountId: string,
  ids: readonly string[],
  report: ReportUnreadable,
) {
  return fetchRevisions(db, humanActor(accountId), ids, report, async (tx, who, rows) => {
    const owned = new Set(await ownedSpaces(tx, who.identity.id));
    const pageIds = [...new Set(rows.map((row) => row.pageId))];
    const trashed = new Set(
      pageIds.length === 0
        ? []
        : (
            await tx
              .select({ id: nodes.id })
              .from(nodes)
              .where(and(anyId(nodes.id, pageIds), isNotNull(nodes.trashId)))
          ).map((node) => node.id),
    );
    return new Map(
      rows.flatMap((row: RevisionPlace) =>
        owned.has(row.spaceId) && trashed.has(row.pageId) ? [[row.id, 1] as const] : [],
      ),
    );
  });
}

// A trash row, held for the rest of the transaction once its space is, with
// its owner checked. Not-found for anyone else, and once it is gone.
async function holdTrash(tx: Database, accountId: string, trashId: string) {
  const [found] = await tx.select().from(trash).where(eq(trash.id, trashId));
  if (!found) throw new ContentError('not-found');
  await lockSpace(tx, found.spaceId);
  const identity = await requireIdentity(tx, accountId);
  if (!(await isOwner(tx, identity.id, found.spaceId))) throw new ContentError('not-found');
  const [row] = await tx.select().from(trash).where(eq(trash.id, trashId)).for('update');
  if (!row) throw new ContentError('not-found');
  return row;
}

/**
 * Put something back from the trash (space owners) with everything that
 * went with it: its versions, attachments and shares, and its pages'
 * published state, all of which stayed. Its public links stay ended.
 *
 * It goes back under the folder it was in. If that folder is in the trash
 * too, it goes to the top of the space, or, if it was in a shared folder,
 * to the top of that one: its keys are the share's. Its records' keys must
 * fit where it goes: the share there, or the owners outside one, as they
 * were when it was deleted. If a share was made, removed or moved around
 * it since, they don't, and it is refused as `region-mismatch`, and so it
 * is when the shared folder it was in is itself in the trash, naming that
 * folder. A share rooted in it can't go back inside another (`share-nesting`).
 */
export async function restoreTrash(
  db: Database,
  input: { accountId: string; trashId: string },
): Promise<{ spaceId: string; nodeId: string; parentId: string | null }> {
  return db.transaction(async (tx) => {
    const row = await holdTrash(tx, input.accountId, input.trashId);
    const { spaceId, nodeId } = row;
    const held = await tx
      .select({ id: nodes.id, parentId: nodes.parentId })
      .from(nodes)
      .where(and(eq(nodes.trashId, row.id), eq(nodes.spaceId, spaceId)))
      .orderBy(nodes.id)
      .for('update');
    const root = held.find((node) => node.id === nodeId);
    if (!root) throw new ContentError('not-found');
    const ids = held.map((node) => node.id);
    const rooted = await tx
      .select()
      .from(shares)
      .where(and(eq(shares.spaceId, spaceId), anyId(shares.rootId, ids)));

    const parentId = await destination(tx, root, rooted);
    const to = await shareAt(tx, spaceId, parentId);
    if (to && rooted.length > 0) {
      throw new ContentError('share-nesting', 'Shares never nest', { shareId: to.id });
    }
    requireRoom(await pathUp(tx, spaceId, parentId), depthOf(held, nodeId) + 1);
    await requireRegion(tx, { held, rooted, to });

    if (parentId !== root.parentId) {
      await tx.update(nodes).set({ parentId }).where(eq(nodes.id, nodeId));
    }
    await tx.update(nodes).set({ trashId: null }).where(eq(nodes.trashId, row.id));
    await tx.delete(trash).where(eq(trash.id, row.id));
    await bumpPermissions(tx, spaceId, ids);
    return { spaceId, nodeId, parentId };
  });
}

// Where a restored node goes: the folder it was in, unless that is in the
// trash or a copy's; then the top of its region (see `restoreTrash`).
async function destination(
  tx: Database,
  root: { id: string; parentId: string | null },
  rooted: readonly { id: string; rootId: string | null }[],
): Promise<string | null> {
  if (root.parentId === null) return null;
  const [parent] = await tx
    .select({ trashId: nodes.trashId, copyId: nodes.copyId })
    .from(nodes)
    .where(eq(nodes.id, root.parentId));
  if (parent && parent.trashId === null && parent.copyId === null) return root.parentId;
  // A share root keeps its share wherever it goes.
  if (rooted.some((share) => share.rootId === root.id)) return null;
  const [region] = await recordShares(tx, [root.id]);
  const shareId = region?.shareId ?? null;
  if (shareId === null) return null;
  const [share] = await tx.select().from(shares).where(eq(shares.id, shareId));
  if (!share?.rootId) return null;
  const [top] = await tx
    .select({ trashed: trash.nodeId })
    .from(nodes)
    .leftJoin(trash, eq(trash.id, nodes.trashId))
    .where(eq(nodes.id, share.rootId));
  // Named by what was deleted, which may be a folder above the shared one.
  if (top?.trashed) {
    throw new ContentError('region-mismatch', 'Restore the shared folder it was in first', {
      nodeIds: [top.trashed],
    });
  }
  return share.rootId;
}

// How deep under `nodeId` the deepest of `held` is.
function depthOf(held: readonly { id: string; parentId: string | null }[], nodeId: string) {
  const parents = new Map(held.map((node) => [node.id, node.parentId]));
  let deepest = 0;
  for (const node of held) {
    let depth = 0;
    for (let at: string | null | undefined = node.id; at && at !== nodeId; depth++) {
      if (depth > MAX_DEPTH) break;
      at = parents.get(at);
    }
    deepest = Math.max(deepest, depth);
  }
  return deepest;
}

// The share each record of `nodeIds` is wrapped in (null: the owners'
// envelopes), with the node it is of: page versions and folder names.
// `sealed` says whether it has envelopes, which a record whose share was
// deleted, taking its wraps, lacks.
async function recordShares(tx: Database, nodeIds: readonly string[]) {
  const sealed = (kind: 'revision' | 'metadata', id: unknown) =>
    sql<boolean>`exists (select 1 from key_envelopes e
      where e.subject_kind = ${kind} and e.subject_id = ${id})`;
  const pages = await tx
    .select({
      nodeId: revisions.pageId,
      shareId: revisionWraps.shareId,
      sealed: sealed('revision', revisions.id),
    })
    .from(revisions)
    .leftJoin(revisionWraps, eq(revisionWraps.revisionId, revisions.id))
    .where(anyId(revisions.pageId, nodeIds));
  const folders = await tx
    .select({
      nodeId: metadataRevisions.subjectId,
      shareId: metadataWraps.shareId,
      sealed: sealed('metadata', metadataRevisions.id),
    })
    .from(metadataRevisions)
    .leftJoin(metadataWraps, eq(metadataWraps.metadataRevisionId, metadataRevisions.id))
    .where(
      and(eq(metadataRevisions.subjectKind, 'folder'), anyId(metadataRevisions.subjectId, nodeIds)),
    );
  return [...pages, ...folders];
}

/**
 * Every record of the nodes going back is in the region it goes to: the
 * share `to`, or the owners' when none, but under a share rooted among them,
 * which keeps its own. A key version older than the share's current one
 * still opens for everyone holding the share.
 */
async function requireRegion(
  tx: Database,
  {
    held,
    rooted,
    to,
  }: {
    held: readonly { id: string; parentId: string | null }[];
    rooted: readonly (typeof shares.$inferSelect)[];
    to: { id: string } | null;
  },
) {
  const holding = sharesByNode(held, rooted);
  for (const record of await recordShares(
    tx,
    held.map((node) => node.id),
  )) {
    const expected = holding.get(record.nodeId)?.id ?? to?.id ?? null;
    const shareId = record.shareId ?? (record.sealed ? null : 'none');
    if (shareId !== expected) {
      throw new ContentError(
        'region-mismatch',
        'Who can see where it was changed after it was deleted, so it can’t go back there',
      );
    }
  }
}

/**
 * Delete one item in the trash for good (space owners), as deleting did
 * before the trash: with everything under it, its shares, versions and
 * attachments (`removeSubtree`). Anything deleted from under it earlier
 * goes too. Blob files go once that commits.
 */
export async function purgeTrash(
  db: Database,
  store: BlobStore,
  input: { accountId: string; trashId: string },
) {
  const hashes = await db.transaction(async (tx) => {
    const row = await holdTrash(tx, input.accountId, input.trashId);
    return purgeHeld(tx, row);
  });
  for (const hash of hashes) await deleteUnlistedFile(db, store, hash);
}

// Delete a held trash row's nodes for good; the caller holds the space.
async function purgeHeld(tx: Database, row: { spaceId: string; nodeId: string }) {
  const at = { spaceId: row.spaceId, nodeId: row.nodeId };
  return removeSubtree(tx, row.spaceId, row.nodeId, await holdSubtree(tx, at));
}

/**
 * Delete for good everything in the trash of `spaceId`, or of every space
 * the caller owns, one item at a time. How many items went.
 */
export async function emptyTrash(
  db: Database,
  store: BlobStore,
  input: { accountId: string; spaceId: string | null },
): Promise<number> {
  const identity = await requireIdentity(db, input.accountId);
  const owned = await ownedSpaces(db, identity.id);
  const spaceIds = input.spaceId === null ? owned : owned.filter((id) => id === input.spaceId);
  if (input.spaceId !== null && spaceIds.length === 0) {
    await requireSpaceOwner(db, input.accountId, { spaceId: input.spaceId, nodeId: null });
  }
  if (spaceIds.length === 0) return 0;
  const rows = await db
    .select({ id: trash.id })
    .from(trash)
    .where(inArray(trash.spaceId, spaceIds))
    .orderBy(trash.deletedAt);
  let removed = 0;
  for (const { id } of rows) {
    try {
      await purgeTrash(db, store, { accountId: input.accountId, trashId: id });
      removed += 1;
    } catch (error) {
      // Gone with something deleted for good before it.
      if (!(error instanceof ContentError && error.code === 'not-found')) throw error;
    }
  }
  return removed;
}

/**
 * Delete for good whatever has been in the trash for `TRASH_DAYS`. One
 * that fails is counted in `failed` and tried again next time.
 */
export async function sweepTrash(
  db: Database,
  store: BlobStore,
  { keptMs = pageRoutes.TRASH_DAYS * DAY_MS }: { keptMs?: number } = {},
) {
  const cutoff = new Date(Date.now() - keptMs);
  const old = await db
    .select({ id: trash.id })
    .from(trash)
    .where(lt(trash.deletedAt, cutoff))
    .orderBy(trash.deletedAt);
  let removed = 0;
  let failed = 0;
  for (const { id } of old) {
    try {
      const hashes = await db.transaction(async (tx) => {
        const [found] = await tx.select().from(trash).where(eq(trash.id, id));
        if (!found) return null;
        await lockSpace(tx, found.spaceId);
        const [row] = await tx.select().from(trash).where(eq(trash.id, id)).for('update');
        return row ? purgeHeld(tx, row) : null;
      });
      if (!hashes) continue;
      for (const hash of hashes) await deleteUnlistedFile(db, store, hash);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}

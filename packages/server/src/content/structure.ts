import {
  MetadataEnvelopeV2,
  SealedMetadataV2,
  structureRoutes,
  type KeyWrap,
  type PublicIdentity,
} from '@wikistow/contracts';
import {
  hash,
  metadataEnvelopeV2Bytes,
  metadataRecordV2Bytes,
  sealedBytes,
  verifySignature,
} from '@wikistow/client';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { audit } from '../admin/audit.ts';
import type { BlobStore } from '../blobs/store.ts';
import type { Database } from '../db/client.ts';
import { transactOnce, type Once } from '../idempotency.ts';
import {
  blobs,
  keyEnvelopes,
  metadataRevisions,
  metadataWraps,
  nodes,
  shareMembers,
  shares,
  spaceOwners,
  revisions,
  spaces,
  users,
} from '../db/schema/index.ts';
import { readSettings } from '../settings.ts';
import {
  accessTo,
  canEdit,
  agentGrantsOf,
  isOwner,
  capAgent,
  lockShare,
  lockSpace,
  pathUp,
  personAccess,
  readSnapshot,
  requireRoom,
  sharesByNode,
  treesSeenBy,
  treeView,
  type Access,
  type Holder,
  type ShareRow,
} from './access.ts';
import { highest } from './effective.ts';
import { ContentError } from './errors.ts';
import { DEFAULT_CONTENT_LIMITS, requireCapacity } from './limits.ts';
import { currentIdentity, requireCaller, type Actor } from './identities.ts';
import { checkKeyMaterial } from './key-material.ts';
import { deleteUnlistedFile, latestAgentEdit, listPages, requirePublished } from './pages.ts';
import { endPublicationsFrom } from './publications.ts';
import { charge } from './quota.ts';
import { servedMetadata } from './serving.ts';
import { readStored, type ReportUnreadable } from './stored.ts';

export type MetadataCommit = {
  metadata: SealedMetadataV2;
  envelopes: MetadataEnvelopeV2[];
  wrap: KeyWrap | null;
};

/** The caller's live identity; content needs a vault first. */
export async function requireIdentity(db: Database, accountId: string): Promise<PublicIdentity> {
  const identity = await currentIdentity(db, accountId);
  if (!identity) throw new ContentError('vault-missing', 'Set up your vault first');
  return identity;
}

/** Access at a node, or `not-found` so outsiders can't learn it exists. */
async function requireAccess(
  db: Database,
  who: Holder,
  at: { spaceId: string; nodeId: string | null },
) {
  const access = await accessTo(db, who, at);
  if (!access) throw new ContentError('not-found');
  return access;
}

/**
 * Everything the server can check about a new metadata version before
 * storing it, given what the operation expects it to describe: a v2
 * record, bound to this subject and signed by the caller, with the key
 * material of the subject's region.
 */
export async function verifyMetadataCommit(
  tx: Database,
  { metadata, envelopes, wrap }: MetadataCommit,
  expected: {
    author: PublicIdentity;
    spaceId: string;
    subjectKind: 'space' | 'folder' | 'group';
    subjectId: string;
    basedOn: string | null;
    share: ShareRow | null;
  },
) {
  const { record, signature, payload } = metadata;
  const { installationId } = await readSettings(tx);
  const bound =
    record.installationId === installationId &&
    record.spaceId === expected.spaceId &&
    record.subjectKind === expected.subjectKind &&
    record.subjectId === expected.subjectId;
  if (!bound) throw new ContentError('binding-mismatch', 'Metadata describes something else');
  if (
    record.authorId !== expected.author.id ||
    record.authorKeyVersion !== expected.author.keyVersion
  ) {
    throw new ContentError('forbidden', 'Metadata must be written by your own identity');
  }
  if (record.basedOn !== expected.basedOn)
    throw new ContentError('stale-head', 'Metadata changed since you loaded it');
  if (!verifySignature(expected.author, metadataRecordV2Bytes(record), signature)) {
    throw new ContentError('bad-signature', 'Metadata signature is invalid');
  }
  if (hash(sealedBytes(payload)) !== record.payloadHash) {
    throw new ContentError('bad-signature', 'Metadata ciphertext does not match its signed hash');
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

/** Store a checked metadata version, charging its ciphertext to its author's storage. */
export async function storeMetadata(
  tx: Database,
  { metadata, envelopes, wrap }: MetadataCommit,
  { accountId, storageBytes }: { accountId: string; storageBytes: number },
) {
  const { record } = metadata;
  await charge(tx, accountId, metadata.payload.ciphertext.length, storageBytes);
  const inserted = await tx
    .insert(metadataRevisions)
    .values({
      id: record.metadataRevisionId,
      spaceId: record.spaceId,
      subjectKind: record.subjectKind,
      subjectId: record.subjectId,
      basedOn: record.basedOn,
      authorIdentityId: record.authorId,
      authorKeyVersion: record.authorKeyVersion,
      sealed: metadata,
    })
    .onConflictDoNothing()
    .returning({ id: metadataRevisions.id });
  // Either the ID is taken, or another version already builds on the same head.
  if (inserted.length === 0)
    throw new ContentError('stale-head', 'Metadata changed since you loaded it');
  if (envelopes.length > 0) {
    await tx.insert(keyEnvelopes).values(
      envelopes.map((envelope) => ({
        subjectKind: 'metadata' as const,
        subjectId: record.metadataRevisionId,
        recipientIdentityId: envelope.recipientId,
        recipientKeyVersion: envelope.recipientKeyVersion,
        envelope,
      })),
    );
  }
  if (wrap) {
    await tx.insert(metadataWraps).values({
      metadataRevisionId: record.metadataRevisionId,
      shareId: wrap.shareId,
      keyVersion: wrap.keyVersion,
      wrap,
    });
  }
}

/**
 * A new space owned by the caller, with its encrypted name as the first
 * metadata version, sealed to the caller alone.
 */
export async function createSpace(
  db: Database,
  input: {
    accountId: string;
    spaceId: string;
    kind: 'personal' | 'shared';
    maxSpaces?: number;
    storageBytes: number;
  } & Omit<MetadataCommit, 'wrap'>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    await requireCapacity(
      tx,
      input.accountId,
      'space',
      input.maxSpaces ?? DEFAULT_CONTENT_LIMITS.spaces,
    );
    const created = await tx
      .insert(spaces)
      .values({ id: input.spaceId, kind: input.kind, createdBy: input.accountId })
      .onConflictDoNothing()
      .returning({ id: spaces.id });
    if (created.length === 0) throw new ContentError('duplicate', 'That space ID is taken');
    await tx.insert(spaceOwners).values({
      spaceId: input.spaceId,
      identityId: identity.id,
      addedBy: input.accountId,
    });
    const commit = { ...input, wrap: null };
    await verifyMetadataCommit(tx, commit, {
      author: identity,
      spaceId: input.spaceId,
      subjectKind: 'space',
      subjectId: input.spaceId,
      basedOn: null,
      share: null,
    });
    await storeMetadata(tx, commit, input);
    await tx
      .update(spaces)
      .set({ metadataHead: input.metadata.record.metadataRevisionId })
      .where(eq(spaces.id, input.spaceId));
  });
}

/**
 * Delete a space for everyone, for any of its owners (`forbidden` for its
 * members, `not-found` for anyone else). A space that is an owner's home
 * space stays (`home-space`). Everything in it goes in one transaction:
 * its folders and pages with every version, key and attachment, its names,
 * shares, groups and owners, and copies published into it. Its pages'
 * publications into other spaces end as a deleted page's do
 * (`endPublicationsFrom`), and it drops out of everyone's saved order.
 * Once the space's row is gone, the tree trigger tells everyone who saw
 * it. As in `deleteNode`, the space is locked first, then its shares, then
 * its nodes, and blob files are removed after the commit.
 */
export async function deleteSpace(
  db: Database,
  store: BlobStore,
  input: { accountId: string; spaceId: string },
): Promise<void> {
  const { spaceId } = input;
  const hashes = await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const [space] = await tx.select().from(spaces).where(eq(spaces.id, spaceId)).for('update');
    if (!space) throw new ContentError('not-found');
    if (!(await isOwner(tx, identity.id, spaceId))) {
      const seen = await treesSeenBy(tx, input.accountId, [spaceId]);
      throw new ContentError(seen.has(spaceId) ? 'forbidden' : 'not-found');
    }
    if (space.kind === 'personal' && (await isHomeSpace(tx, spaceId))) {
      throw new ContentError('home-space', 'A home space can’t be deleted');
    }
    const spaceShares = await tx
      .select({ id: shares.id })
      .from(shares)
      .where(eq(shares.spaceId, spaceId))
      .orderBy(shares.id)
      .for('update');
    const ids = (
      await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.spaceId, spaceId)).for('update')
    ).map((node) => node.id);
    // In parts, since a space can hold more pages than one query takes IDs.
    const openingFiles: string[] = [];
    for (let i = 0; i < ids.length; i += 5000) {
      openingFiles.push(...(await endPublicationsFrom(tx, ids.slice(i, i + 5000))));
    }
    const doomed = await tx
      .select({ hash: blobs.hash })
      .from(blobs)
      .innerJoin(nodes, eq(nodes.id, blobs.pageId))
      .where(eq(nodes.spaceId, spaceId));
    // Envelopes point at their subject by ID, not by foreign key, so they
    // are removed explicitly. Everything else goes with the space's row.
    await tx
      .delete(keyEnvelopes)
      .where(
        or(
          and(
            eq(keyEnvelopes.subjectKind, 'revision'),
            inArray(
              keyEnvelopes.subjectId,
              tx.select({ id: revisions.id }).from(revisions).where(eq(revisions.spaceId, spaceId)),
            ),
          ),
          and(
            eq(keyEnvelopes.subjectKind, 'metadata'),
            inArray(
              keyEnvelopes.subjectId,
              tx
                .select({ id: metadataRevisions.id })
                .from(metadataRevisions)
                .where(eq(metadataRevisions.spaceId, spaceId)),
            ),
          ),
        ),
      );
    await tx.delete(spaces).where(eq(spaces.id, spaceId));
    await tx
      .update(users)
      .set({ spaceOrder: sql`array_remove(${users.spaceOrder}, ${spaceId})` })
      .where(sql`${spaceId} = any(${users.spaceOrder})`);
    await audit(tx, {
      actor: input.accountId,
      action: 'space.deleted',
      target: { kind: 'space', id: spaceId },
      details: { nodes: ids.length, shares: spaceShares.length },
    });
    return [...doomed.map((blob) => blob.hash), ...openingFiles];
  });
  for (const hash of hashes) await deleteUnlistedFile(db, store, hash);
}

/**
 * A space or folder's permission version and metadata head, row-locked when
 * `lock` is set so a concurrent change waits for this transaction. The lock
 * doesn't block the key-share lock writes hold on the space.
 */
async function container(
  tx: Database,
  spaceId: string,
  folderId: string | null,
  { lock }: { lock: boolean },
) {
  if (folderId === null) {
    const query = tx.select().from(spaces).where(eq(spaces.id, spaceId));
    const [space] = lock ? await query.for('no key update') : await query;
    if (!space) throw new ContentError('not-found');
    return { permissionVersion: space.permissionVersion, metadataHead: space.metadataHead };
  }
  const query = tx
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, folderId), eq(nodes.spaceId, spaceId), eq(nodes.kind, 'folder')));
  const [folder] = lock ? await query.for('no key update') : await query;
  if (!folder) throw new ContentError('not-found');
  return { permissionVersion: folder.permissionVersion, metadataHead: folder.metadataHead };
}

/** A folder at the space root or inside another folder, in its parent's region. */
export async function createFolder(
  db: Database,
  input: {
    actor: Actor;
    spaceId: string;
    folderId: string;
    maxFolders?: number;
    parentId: string | null;
    permissionVersion: number;
    storageBytes: number;
    once?: Once | undefined;
  } & MetadataCommit,
): Promise<void> {
  await transactOnce(db, input.once, async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    const { identity } = caller;
    await lockSpace(tx, input.spaceId);
    const access = await requireAccess(tx, caller, {
      spaceId: input.spaceId,
      nodeId: input.parentId,
    });
    if (!canEdit(access)) throw new ContentError('forbidden');
    const share = await lockShare(tx, access.share);
    const parent = await container(tx, input.spaceId, input.parentId, { lock: true });
    if (parent.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    requireRoom(await pathUp(tx, input.spaceId, input.parentId), 1);
    await verifyMetadataCommit(tx, input, {
      author: identity,
      spaceId: input.spaceId,
      subjectKind: 'folder',
      subjectId: input.folderId,
      basedOn: null,
      share,
    });
    await requireCapacity(
      tx,
      caller.accountId,
      'folder',
      input.maxFolders ?? DEFAULT_CONTENT_LIMITS.folders,
    );
    const created = await tx
      .insert(nodes)
      .values({
        id: input.folderId,
        spaceId: input.spaceId,
        parentId: input.parentId,
        kind: 'folder',
        createdBy: caller.accountId,
        permissionVersion: parent.permissionVersion,
      })
      .onConflictDoNothing()
      .returning({ id: nodes.id });
    if (created.length === 0) throw new ContentError('duplicate', 'That folder ID is taken');
    await storeMetadata(tx, input, { ...input, accountId: caller.accountId });
    await tx
      .update(nodes)
      .set({ metadataHead: input.metadata.record.metadataRevisionId })
      .where(eq(nodes.id, input.folderId));
  });
}

/**
 * A new version of a space's or folder's metadata (rename, emoji, tint),
 * based on the current head. Renaming a space is for its owners; renaming a
 * folder needs edit rights there (section 5.4).
 */
export async function updateMetadata(
  db: Database,
  input: {
    accountId: string;
    spaceId: string;
    permissionVersion: number;
    storageBytes: number;
  } & MetadataCommit,
): Promise<void> {
  const { record } = input.metadata;
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const folderId = record.subjectKind === 'folder' ? record.subjectId : null;
    // A group is renamed through its own route.
    if (record.subjectKind === 'group') throw new ContentError('binding-mismatch');
    if (record.subjectKind === 'space' && record.subjectId !== input.spaceId)
      throw new ContentError('binding-mismatch');
    await lockSpace(tx, input.spaceId);
    const access = await requireAccess(
      tx,
      { identity, personId: null },
      { spaceId: input.spaceId, nodeId: folderId },
    );
    const allowed: (a: Access) => boolean = folderId === null ? (a) => a.role === 'owner' : canEdit;
    if (!allowed(access)) throw new ContentError('forbidden');
    const share = await lockShare(tx, access.share);
    const subject = await container(tx, input.spaceId, folderId, { lock: true });
    if (subject.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    await verifyMetadataCommit(tx, input, {
      author: identity,
      spaceId: input.spaceId,
      subjectKind: record.subjectKind,
      subjectId: record.subjectId,
      basedOn: subject.metadataHead,
      share,
    });
    await storeMetadata(tx, input, input);
    const head = { metadataHead: record.metadataRevisionId };
    if (folderId === null) await tx.update(spaces).set(head).where(eq(spaces.id, input.spaceId));
    else await tx.update(nodes).set(head).where(eq(nodes.id, folderId));
  });
}

/** A share's row, as the API describes it. */
export const shareOf = (row: ShareRow) => ({
  shareId: row.id,
  spaceId: row.spaceId,
  rootId: row.rootId,
  currentKeyVersion: row.currentKeyVersion,
});

/** A space in the caller's list, and since when they have it. */
type Listed = { space: typeof spaces.$inferSelect; access: Access; since: Date };

/**
 * The spaces a person can open: those they own, with every right, and those
 * whose own share they are a member of, with their role there.
 */
async function humanSpaces(db: Database, identityId: string) {
  const bySpace = new Map<string, Listed>();
  const owned = await db
    .select({ space: spaces, since: spaceOwners.createdAt })
    .from(spaceOwners)
    .innerJoin(spaces, eq(spaces.id, spaceOwners.spaceId))
    .where(and(eq(spaceOwners.identityId, identityId), isNull(spaceOwners.removedAt)));
  const held = await db
    .select({
      space: spaces,
      role: shareMembers.role,
      canPublish: shareMembers.canPublish,
      since: shareMembers.createdAt,
    })
    .from(shareMembers)
    .innerJoin(shares, and(eq(shares.id, shareMembers.shareId), isNull(shares.rootId)))
    .innerJoin(spaces, eq(spaces.id, shares.spaceId))
    .where(eq(shareMembers.identityId, identityId));
  for (const { space, role, canPublish, since } of held) {
    bySpace.set(space.id, { space, access: { role, canPublish }, since });
  }
  // An owner's own rights win over any share they also hold.
  for (const { space, since } of owned) {
    bySpace.set(space.id, { space, access: { role: 'owner', canPublish: true }, since });
  }
  // The home space is the personal space they have owned longest: the one
  // the app makes when the vault is set up, before anyone can add them as an
  // owner elsewhere. New space makes personal spaces too.
  const home = owned
    .filter(({ space }) => space.kind === 'personal')
    .reduce<(typeof owned)[number] | null>(
      (oldest, row) => (oldest && oldest.since <= row.since ? oldest : row),
      null,
    );
  return { bySpace, homeId: home?.space.id ?? null };
}

/** Whether the space is the home space of any of its current owners, which nobody can delete. */
async function isHomeSpace(db: Database, spaceId: string) {
  const owners = await db
    .select({ id: spaceOwners.identityId })
    .from(spaceOwners)
    .where(and(eq(spaceOwners.spaceId, spaceId), isNull(spaceOwners.removedAt)));
  for (const { id } of owners) {
    if ((await humanSpaces(db, id)).homeId === spaceId) return true;
  }
  return false;
}

/**
 * A person's spaces, home space and saved order. Spaces they left drop out
 * of the saved order here, so one they get back comes last; unless it was
 * saved again meanwhile.
 */
async function personSpaces(db: Database, accountId: string, identityId: string) {
  const { bySpace, homeId } = await humanSpaces(db, identityId);
  const [account] = await db
    .select({ spaceOrder: users.spaceOrder })
    .from(users)
    .where(eq(users.id, accountId));
  const stored = account?.spaceOrder ?? [];
  const saved = stored.filter((id) => bySpace.has(id));
  if (saved.length < stored.length) {
    await db
      .update(users)
      .set({ spaceOrder: saved })
      .where(and(eq(users.id, accountId), eq(users.spaceOrder, stored)));
  }
  return { bySpace, homeId, saved };
}

/**
 * Spaces in the person's order: the home space, then the saved order, then
 * the rest (new, or newly shared) in the order they got them.
 */
function inOrder(listed: Listed[], homeId: string | null, saved: string[]) {
  const rank = new Map(saved.map((id, index) => [id, index]));
  const at = (id: string) => (id === homeId ? -1 : (rank.get(id) ?? Infinity));
  // Two unsaved spaces give NaN, which falls through to when they came.
  return listed.toSorted(
    (a, b) => at(a.space.id) - at(b.space.id) || a.since.getTime() - b.since.getTime(),
  );
}

/**
 * The spaces the caller can open, each with its current encrypted name:
 * spaces they own, with every right, and spaces whose own share they are a
 * member of, with their role there. Folder shares are listed under Shared
 * with me instead (section 7.7). An agent's are the spaces whose own share
 * it was granted whole, within its person's current access. A person's
 * spaces come in their order, home space first; an agent's oldest first.
 */
export async function listSpaces(db: Database, actor: Actor, report: ReportUnreadable) {
  const caller = await requireCaller(db, actor);
  const { identity } = caller;
  let bySpace = new Map<string, Listed>();
  let homeId: string | null = null;
  let saved: string[] = [];
  if (caller.personId !== null) {
    const whole = (await agentGrantsOf(db, { agentIds: [identity.id] })).filter(
      (grant) => grant.folderId === null,
    );
    const granted =
      whole.length === 0
        ? []
        : await db
            .select({ space: spaces, share: shares })
            .from(shares)
            .innerJoin(spaces, eq(spaces.id, shares.spaceId))
            .where(
              and(
                isNull(shares.rootId),
                inArray(
                  shares.id,
                  whole.map((grant) => grant.shareId),
                ),
              ),
            );
    for (const { space, share } of granted) {
      const person = await personAccess(db, caller.personId, share);
      const grant = highest(whole.filter((g) => g.shareId === share.id));
      if (person && grant) {
        bySpace.set(space.id, { space, access: capAgent(grant, person), since: space.createdAt });
      }
    }
  } else {
    ({ bySpace, homeId, saved } = await personSpaces(db, caller.accountId, identity.id));
  }
  const listed = inOrder([...bySpace.values()], homeId, saved);
  const heads = await servedMetadata(
    db,
    identity,
    listed.flatMap(({ space }) => (space.metadataHead ? [space.metadataHead] : [])),
    report,
  );
  return listed.flatMap(({ space, access }) => {
    const head = space.metadataHead ? heads.get(space.metadataHead) : undefined;
    if (!head) return [];
    // Its ID too may be one Milestone 1 allowed and today's rules refuse.
    const summary = readStored(
      structureRoutes.SpaceSummary,
      {
        id: space.id,
        kind: space.kind,
        role: access.role,
        canPublish: access.canPublish,
        permissionVersion: space.permissionVersion,
        ...head,
      },
      { table: 'spaces', id: space.id },
      report,
    );
    return summary ? [summary] : [];
  });
}

/** A person's home space and saved order, as `listSpaces` sorts by them. */
export async function readSpaceOrder(db: Database, accountId: string) {
  const { identity } = await requireCaller(db, { accountId, agentId: null });
  const { homeId, saved } = await personSpaces(db, accountId, identity.id);
  return { homeId, spaceIds: saved };
}

/**
 * Save the order a person put their spaces in, dropping IDs of spaces they
 * can't open and repeats. Returns what was saved.
 */
export async function saveSpaceOrder(db: Database, accountId: string, spaceIds: string[]) {
  const { identity } = await requireCaller(db, { accountId, agentId: null });
  const { bySpace } = await humanSpaces(db, identity.id);
  const kept = [...new Set(spaceIds)].filter((id) => bySpace.has(id));
  await db.update(users).set({ spaceOrder: kept }).where(eq(users.id, accountId));
  return kept;
}

/**
 * What the caller can see of a space (section 7.7). An owner sees all of it.
 * A member sees the shares they belong to and what is in them, and the
 * space's name only through the space's own share; a share root's parent is
 * withheld, so nothing above it is named, not even by ID. An agent sees the
 * same of what it was granted, from a granted folder down, which its share
 * lists as its root. It is all read in one snapshot, so a move or a share
 * change can't land between two of its reads and mix the old tree and the new.
 */
export function loadTree(db: Database, actor: Actor, spaceId: string, report: ReportUnreadable) {
  return readSnapshot(db, (tx) => readTree(tx, actor, spaceId, report));
}

async function readTree(db: Database, actor: Actor, spaceId: string, report: ReportUnreadable) {
  const caller = await requireCaller(db, actor);
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId));
  if (!space?.metadataHead) throw new ContentError('not-found');
  const spaceShares = await db.select().from(shares).where(eq(shares.spaceId, spaceId));
  const all = await db
    .select({
      id: nodes.id,
      parentId: nodes.parentId,
      kind: nodes.kind,
      permissionVersion: nodes.permissionVersion,
      metadataHead: nodes.metadataHead,
    })
    .from(nodes)
    .where(eq(nodes.spaceId, spaceId));
  const parents = new Map(all.map((node) => [node.id, node.parentId]));
  const view = await treeView(db, caller, spaceId, spaceShares, parents);
  if (!view) throw new ContentError('not-found');

  const holding = sharesByNode(all, spaceShares);
  const visible = all.flatMap((node) => {
    const access = view.at(holding.get(node.id) ?? null, node.id);
    return access ? [{ node, access }] : [];
  });
  const spaceAccess = view.at(spaceShares.find((share) => share.rootId === null) ?? null, null);
  const folders = visible.filter(({ node }) => node.kind === 'folder');
  const heads = await servedMetadata(
    db,
    caller.identity,
    [
      ...(spaceAccess ? [space.metadataHead] : []),
      ...folders.flatMap(({ node }) => (node.metadataHead ? [node.metadataHead] : [])),
    ],
    report,
  );
  const spaceHead = spaceAccess ? heads.get(space.metadataHead) : undefined;
  if (spaceAccess && !spaceHead) throw new ContentError('not-found');
  return {
    space:
      spaceAccess && spaceHead
        ? {
            id: space.id,
            kind: space.kind,
            role: spaceAccess.role,
            canPublish: spaceAccess.canPublish,
            permissionVersion: space.permissionVersion,
            ...spaceHead,
          }
        : null,
    shares: spaceShares.flatMap((share) => {
      const held = view.held(share);
      return held ? [{ ...shareOf(share), rootId: held.rootId, ...held.access }] : [];
    }),
    pages: await listPages(
      db,
      visible.flatMap(({ node, access }) =>
        node.kind === 'page' ? [{ id: node.id, reader: !canEdit(access) }] : [],
      ),
      report,
    ),
    // Only pages the caller edits: an agent's drafts are no reader's business.
    agentActivity: await latestAgentEdit(
      db,
      spaceId,
      visible.flatMap(({ node, access }) =>
        node.kind === 'page' && canEdit(access) ? [node.id] : [],
      ),
    ),
    folders: folders.flatMap(({ node }) => {
      const head = node.metadataHead ? heads.get(node.metadataHead) : undefined;
      if (!head) return [];
      const parentId = view.starts.has(node.id) ? null : node.parentId;
      const summary = readStored(
        structureRoutes.FolderSummary,
        { id: node.id, parentId, permissionVersion: node.permissionVersion, ...head },
        { table: 'nodes', id: node.id },
        report,
      );
      return summary ? [summary] : [];
    }),
  };
}

/**
 * Where a node is, for a write there: the share whose region holds it, the
 * permission version the write carries (a page's own, or its container's),
 * and a folder's or the space's current name record, with its key material.
 */
export async function writeTarget(
  db: Database,
  input: { actor: Actor; spaceId: string; nodeId: string | null },
  report: ReportUnreadable,
) {
  const caller = await requireCaller(db, input.actor);
  const { identity } = caller;
  const access = await requireAccess(db, caller, input);
  const [node] =
    input.nodeId === null
      ? []
      : await db
          .select({
            id: nodes.id,
            kind: nodes.kind,
            permissionVersion: nodes.permissionVersion,
            metadataHead: nodes.metadataHead,
          })
          .from(nodes)
          .where(and(eq(nodes.id, input.nodeId), eq(nodes.spaceId, input.spaceId)));
  if (input.nodeId !== null && !node) throw new ContentError('not-found');
  if (node?.kind === 'page') {
    if (!canEdit(access)) await requirePublished(db, node.id);
    return {
      permissionVersion: node.permissionVersion,
      share: access.share && shareOf(access.share),
      name: null,
    };
  }
  const { permissionVersion, metadataHead } = await container(db, input.spaceId, input.nodeId, {
    lock: false,
  });
  const name = metadataHead
    ? (await servedMetadata(db, identity, [metadataHead], report)).get(metadataHead)
    : undefined;
  return {
    permissionVersion,
    share: access.share && shareOf(access.share),
    name: name ?? null,
  };
}

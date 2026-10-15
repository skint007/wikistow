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
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { transactOnce, type Once } from '../idempotency.ts';
import {
  agentGrants,
  keyEnvelopes,
  metadataRevisions,
  metadataWraps,
  nodes,
  shareMembers,
  shares,
  spaceOwners,
  spaces,
} from '../db/schema/index.ts';
import { readSettings } from '../settings.ts';
import {
  accessTo,
  canEdit,
  capAgent,
  lockShare,
  lockSpace,
  pathUp,
  personAccess,
  readSnapshot,
  requireRoom,
  sharesByNode,
  treeView,
  type Access,
  type Holder,
  type ShareRow,
} from './access.ts';
import { ContentError } from './errors.ts';
import { DEFAULT_CONTENT_LIMITS, requireCapacity } from './limits.ts';
import { currentIdentity, requireCaller, type Actor } from './identities.ts';
import { checkKeyMaterial } from './key-material.ts';
import { latestAgentEdit, listPages, requirePublished } from './pages.ts';
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

/**
 * The spaces the caller can open, each with its current encrypted name:
 * spaces they own, with every right, and spaces whose own share they are a
 * member of, with their role there. Folder shares are listed under Shared
 * with me instead (section 7.7). An agent's are the spaces whose own share
 * it was granted whole, within its person's current access.
 */
export async function listSpaces(db: Database, actor: Actor, report: ReportUnreadable) {
  const caller = await requireCaller(db, actor);
  const { identity } = caller;
  const bySpace = new Map<string, { space: typeof spaces.$inferSelect; access: Access }>();
  if (caller.personId !== null) {
    const granted = await db
      .select({ space: spaces, share: shares, grant: agentGrants })
      .from(agentGrants)
      .innerJoin(shares, and(eq(shares.id, agentGrants.shareId), isNull(shares.rootId)))
      .innerJoin(spaces, eq(spaces.id, shares.spaceId))
      .where(and(eq(agentGrants.agentId, identity.id), isNull(agentGrants.folderId)));
    for (const { space, share, grant } of granted) {
      const person = await personAccess(db, caller.personId, share);
      if (person) bySpace.set(space.id, { space, access: capAgent(grant, person) });
    }
  } else {
    const owned = await db
      .select({ space: spaces })
      .from(spaceOwners)
      .innerJoin(spaces, eq(spaces.id, spaceOwners.spaceId))
      .where(and(eq(spaceOwners.identityId, identity.id), isNull(spaceOwners.removedAt)));
    const held = await db
      .select({ space: spaces, role: shareMembers.role, canPublish: shareMembers.canPublish })
      .from(shareMembers)
      .innerJoin(shares, and(eq(shares.id, shareMembers.shareId), isNull(shares.rootId)))
      .innerJoin(spaces, eq(spaces.id, shares.spaceId))
      .where(eq(shareMembers.identityId, identity.id));
    for (const { space, role, canPublish } of held) {
      bySpace.set(space.id, { space, access: { role, canPublish } });
    }
    // An owner's own rights win over any share they also hold.
    for (const { space } of owned) {
      bySpace.set(space.id, { space, access: { role: 'owner', canPublish: true } });
    }
  }
  const heads = await servedMetadata(
    db,
    identity,
    [...bySpace.values()].flatMap(({ space }) => (space.metadataHead ? [space.metadataHead] : [])),
    report,
  );
  return [...bySpace.values()].flatMap(({ space, access }) => {
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

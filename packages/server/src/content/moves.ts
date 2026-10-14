// Moving pages and folders, within a region or across a share boundary
// (protocol section 10).
import { setImmediate } from 'node:timers/promises';
import {
  Hash32,
  InstallationId,
  SpaceId,
  type KeyEnvelopeV2,
  type MetadataEnvelopeV2,
  type PublicIdentity,
  type sharingRoutes,
} from '@wikistow/contracts';
import { keyEnvelopeV2Bytes, metadataEnvelopeV2Bytes, verifySignature } from '@wikistow/client';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../admin/audit.ts';
import type { Database } from '../db/client.ts';
import {
  agentGrants,
  keyEnvelopes,
  metadataWraps,
  nodes,
  revisionWraps,
  shares,
} from '../db/schema/index.ts';
import {
  accessTo,
  canEdit,
  currentOwners,
  isOwner,
  pathUp,
  requireRoom,
  shareAt,
  subtreeOf,
  type ShareRow,
} from './access.ts';
import { ContentError } from './errors.ts';
import {
  bumpPermissions,
  insertChunked,
  lockSpaceForUpdate,
  recordsUnder,
  requireCoverage,
  uncovered,
} from './sharing.ts';
import type { ReportUnreadable } from './stored.ts';
import { requireCaller, type Actor } from './identities.ts';

type Move = z.output<typeof sharingRoutes.move.body>;

/**
 * For a move's large body, before it is read: the caller (a person with a
 * vault, or their agent) may edit the node, or is refused as the move
 * would refuse them. Answers whether they own the space: only an owner's
 * move crosses a share and carries keys. The move checks everything again
 * under its lock.
 */
export async function checkMover(
  db: Database,
  actor: Actor,
  { spaceId, nodeId }: { spaceId: string; nodeId: string },
): Promise<{ owner: boolean }> {
  const access = await accessTo(db, await requireCaller(db, actor), { spaceId, nodeId });
  if (!access) throw new ContentError('not-found');
  if (!canEdit(access)) throw new ContentError('forbidden');
  return { owner: access.role === 'owner' };
}

/**
 * Move a page or folder, with everything under it, under `parentId` in the
 * same space, or to its top (section 10). Under a lock on the space, so no
 * write, rotation or share lands meanwhile:
 * - the walk up from the destination to the top doesn't pass the node
 *   (`binding-mismatch`), and nothing ends up more than `MAX_DEPTH` levels
 *   deep (`too-deep`);
 * - no share root, the node's own or one under it, ends up in a share
 *   (`share-nesting`);
 * - within one region, the caller may edit the node and both parents, and
 *   nothing is rewrapped. A share root keeps its own share wherever it goes.
 *   An agent moves only here, inside what it was picked for (section 9.5);
 * - the node is still under `expectedParentId` (`stale-head`, naming where
 *   it is now);
 * - across a region boundary, the caller is an owner, and every record of
 *   the subtree comes rewrapped under the destination share's current key
 *   version, or sealed to exactly the space's current owners. One written
 *   meanwhile and missing is `stale-head`, so the owner's app adds it.
 * Then the subtree moves, its old wraps or envelopes give way to the new
 * ones, agents' picks that left their share end, and permission versions
 * move on, all at once. Envelope signatures are checked before the lock,
 * so nothing in the space waits on them. A stored record of the subtree
 * that today's schemas refuse is reported and refuses the move
 * (`binding-mismatch`), rather than being left without keys.
 */
export async function moveNode(
  db: Database,
  input: { actor: Actor; spaceId: string; nodeId: string } & Move,
  report: ReportUnreadable,
): Promise<void> {
  await verifyGrants(db, input, report);
  await db.transaction(async (tx) => {
    const caller = await requireCaller(tx, input.actor);
    const { identity } = caller;
    const { spaceId, nodeId, parentId } = input;
    const space = await lockSpaceForUpdate(tx, spaceId);
    const [node] = await tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.spaceId, spaceId)));
    const access = node && (await accessTo(tx, caller, { spaceId, nodeId }));
    if (!node || !access) throw new ContentError('not-found');
    // A destination the caller can't see doesn't exist for them.
    const destination =
      parentId === null
        ? { permissionVersion: space.permissionVersion }
        : (
            await tx
              .select({ permissionVersion: nodes.permissionVersion })
              .from(nodes)
              .where(
                and(eq(nodes.id, parentId), eq(nodes.spaceId, spaceId), eq(nodes.kind, 'folder')),
              )
          )[0];
    const atDestination = await accessTo(tx, caller, { spaceId, nodeId: parentId });
    if (!destination || !atDestination) throw new ContentError('not-found');
    // Up from the destination to the top, so no depth of the subtree hides
    // the node on the way: one there would make a cycle.
    const path = await pathUp(tx, spaceId, parentId);
    if (path?.includes(nodeId)) {
      throw new ContentError('binding-mismatch', 'Nothing moves into itself');
    }
    const rows = [
      ...(await tx.execute<{ id: string; depth: number }>(
        sql`${subtreeOf(spaceId, nodeId)} select id, depth from subtree`,
      )),
    ];
    requireRoom(path, rows.reduce((deepest, row) => Math.max(deepest, row.depth), 0) + 1);
    // With room for it, the walk down was complete: it stops only past `MAX_DEPTH`.
    const subtree = rows.map((row) => row.id);

    const from = await shareAt(tx, spaceId, nodeId);
    const to = await shareAt(tx, spaceId, parentId);
    const spaceShares = await tx.select().from(shares).where(eq(shares.spaceId, spaceId));
    const inside = new Set(subtree);
    if (to && spaceShares.some((share) => share.rootId !== null && inside.has(share.rootId))) {
      throw new ContentError('share-nesting', 'Shares never nest', { shareId: to.id });
    }
    // A share root keeps its share, so only content outside one changes region.
    const crossing = from?.rootId !== nodeId && from?.id !== to?.id;
    if (crossing) {
      if (!(await isOwner(tx, identity.id, spaceId))) {
        throw new ContentError('forbidden', 'Only owners move across a share boundary');
      }
    } else {
      const atOldParent = await accessTo(tx, caller, { spaceId, nodeId: node.parentId });
      if (!canEdit(access) || !canEdit(atOldParent) || !canEdit(atDestination)) {
        throw new ContentError('forbidden');
      }
    }
    // Where it is now, told only to someone who may move it from there.
    if (node.parentId !== input.expectedParentId) {
      throw new ContentError('stale-head', 'It moved since you loaded it', {
        parentId: node.parentId,
      });
    }
    if (
      node.permissionVersion !== input.permissionVersion ||
      destination.permissionVersion !== input.parentPermissionVersion
    ) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }

    const records = await recordsUnder(tx, spaceId, nodeId);
    const rewrapped = crossing
      ? await checkRewrap(tx, input, records, { spaceId, to, identity, report })
      : null;
    if (!crossing && carriesKeys(input)) {
      throw new ContentError('region-mismatch', 'A move within one region changes no keys');
    }

    await tx.update(nodes).set({ parentId }).where(eq(nodes.id, nodeId));
    if (rewrapped) {
      await replaceKeyMaterial(tx, input, records);
      // An agent's pick that moved out of its share ends there (section 9.4).
      if (from) {
        await tx
          .delete(agentGrants)
          .where(and(eq(agentGrants.shareId, from.id), inArray(agentGrants.folderId, subtree)));
      }
    }
    await bumpPermissions(tx, spaceId, subtree);
    if (rewrapped) {
      // Who gained or lost keys follows from the shares, by ID only.
      await audit(tx, {
        actor: input.actor.accountId,
        action: 'node.moved',
        target: { kind: 'node', id: nodeId },
        details: {
          spaceId,
          fromShare: from?.id ?? null,
          toShare: to?.id ?? null,
          records: records.revision.length + records.metadata.length,
        },
      });
    }
  });
}

const carriesKeys = (move: Move) =>
  move.wraps.length > 0 || move.keyEnvelopes.length > 0 || move.metadataEnvelopes.length > 0;

type Records = Awaited<ReturnType<typeof recordsUnder>>;

/**
 * A move across a region boundary carries the destination's key material
 * for every record of the subtree, and nothing else: into share `to`, one
 * wrap each under its current key version (`key-version` naming it
 * otherwise); into the owner region, one envelope each to every owner.
 */
async function checkRewrap(
  tx: Database,
  move: Move,
  records: Records,
  {
    spaceId,
    to,
    identity,
    report,
  }: { spaceId: string; to: ShareRow | null; identity: PublicIdentity; report: ReportUnreadable },
): Promise<true> {
  if (to) {
    if (move.keyEnvelopes.length > 0 || move.metadataEnvelopes.length > 0) {
      throw new ContentError('region-mismatch', 'Content in a share carries key wraps');
    }
    if (
      move.wraps.some((w) => w.wrap.shareId === to.id && w.wrap.keyVersion !== to.currentKeyVersion)
    ) {
      throw new ContentError('key-version', 'The share has another key version', {
        shareId: to.id,
        keyVersion: to.currentKeyVersion,
      });
    }
    await requireCoverage(tx, move.wraps, records, {
      shareId: to.id,
      keyVersion: to.currentKeyVersion,
    });
    return true;
  }
  if (move.wraps.length > 0) {
    throw new ContentError('region-mismatch', 'Content outside shares is sealed to its owners');
  }
  const owners = await currentOwners(tx, spaceId);
  const granted = { owners, granter: identity };
  const missing = {
    revisions: await checkOwnerEnvelopes(tx, move.keyEnvelopes, {
      ...granted,
      subjectKind: 'revision',
      records: records.revision,
      versionOf: (e) => e.revisionId,
    }),
    metadata: await checkOwnerEnvelopes(tx, move.metadataEnvelopes, {
      ...granted,
      subjectKind: 'metadata',
      records: records.metadata,
      versionOf: (e) => e.metadataRevisionId,
    }),
  };
  if (missing.revisions.length > 0 || missing.metadata.length > 0) {
    // One no app could read, so none could grant, refuses the move: it
    // would otherwise lose its keys. Any other was written meanwhile.
    await recordParts(tx, 'revisions', spaceId, missing.revisions, report);
    await recordParts(tx, 'metadata_revisions', spaceId, missing.metadata, report);
    throw new ContentError('stale-head', 'The folder changed since you loaded it');
  }
  return true;
}

// The parts of a stored record its envelopes are signed over.
const RecordParts = z.object({
  installationId: InstallationId,
  spaceId: SpaceId,
  payloadHash: Hash32,
});
type RecordParts = z.output<typeof RecordParts>;

/**
 * The signed parts of each of `ids` that is stored. One today's schemas
 * refuse can't be signed over, so it is reported and refuses the move
 * (`binding-mismatch`).
 */
async function recordParts(
  db: Database,
  table: 'revisions' | 'metadata_revisions',
  spaceId: string,
  ids: readonly string[],
  report: ReportUnreadable,
): Promise<Map<string, RecordParts>> {
  if (ids.length === 0) return new Map();
  const rows = await db.execute<{ id: string; record: unknown }>(sql`
    select id, sealed -> 'record' as record from ${sql.identifier(table)}
    where space_id = ${spaceId} and id = any(${sql.param([...ids])}::text[])`);
  const parts = new Map<string, RecordParts>();
  for (const row of rows) {
    const record = RecordParts.safeParse(row.record);
    if (!record.success) {
      report({ table, id: row.id });
      throw new ContentError('binding-mismatch', 'A record there can’t be read');
    }
    parts.set(row.id, record.data);
  }
  return parts;
}

/** Signatures checked between turns of the event loop, so other requests go on meanwhile. */
const VERIFY_BATCH = 200;

/**
 * Check the signature of every owner envelope a move carries, before its
 * lock: each by the caller at their current key, over the stored record it
 * names (section 5.8), a batch at a time. Stored records never change, and
 * under its lock the move requires the envelopes' key to be the caller's
 * current one still, so the check holds there.
 */
async function verifyGrants(
  db: Database,
  move: { actor: Actor; spaceId: string } & Move,
  report: ReportUnreadable,
) {
  if (move.keyEnvelopes.length === 0 && move.metadataEnvelopes.length === 0) return;
  // Only an owner's move carries envelopes, and an agent is never an owner.
  const { identity: granter } = await requireCaller(db, move.actor);
  const named = <E>(envelopes: readonly E[], versionOf: (envelope: E) => string) => [
    ...new Set(envelopes.map(versionOf)),
  ];
  await verifyEach(db, move.keyEnvelopes, {
    granter,
    subjectKind: 'revision',
    records: await recordParts(
      db,
      'revisions',
      move.spaceId,
      named(move.keyEnvelopes, (e) => e.revisionId),
      report,
    ),
    versionOf: (e) => e.revisionId,
    signedBytes: keyEnvelopeV2Bytes,
  });
  await verifyEach(db, move.metadataEnvelopes, {
    granter,
    subjectKind: 'metadata',
    records: await recordParts(
      db,
      'metadata_revisions',
      move.spaceId,
      named(move.metadataEnvelopes, (e) => e.metadataRevisionId),
      report,
    ),
    versionOf: (e) => e.metadataRevisionId,
    signedBytes: metadataEnvelopeV2Bytes,
  });
}

async function verifyEach<E extends KeyEnvelopeV2 | MetadataEnvelopeV2>(
  db: Database,
  envelopes: readonly E[],
  {
    granter,
    subjectKind,
    records,
    versionOf,
    signedBytes,
  }: {
    granter: PublicIdentity;
    subjectKind: 'revision' | 'metadata';
    records: ReadonlyMap<string, RecordParts>;
    versionOf: (envelope: E) => string;
    signedBytes: (record: RecordParts, envelope: E) => Uint8Array;
  },
) {
  for (const [i, envelope] of envelopes.entries()) {
    if (i > 0 && i % VERIFY_BATCH === 0) await setImmediate();
    const record = records.get(versionOf(envelope));
    if (!record) {
      throw await uncovered(
        db,
        subjectKind,
        versionOf(envelope),
        new ContentError('binding-mismatch', 'An envelope is for something else'),
      );
    }
    const valid =
      envelope.granterId === granter.id &&
      envelope.granterKeyVersion === granter.keyVersion &&
      verifySignature(granter, signedBytes(record, envelope), envelope.signature);
    if (!valid) throw new ContentError('bad-signature', 'Every envelope must be signed by you');
  }
}

/**
 * v2 envelopes the moving owner grants for existing records (section 5.8),
 * whose signatures `verifyGrants` checked: for each of `records`, exactly
 * one to each of `owners` at their current key, from `granter` at their
 * current key. One for anything else is `binding-mismatch`, or `stale-head`
 * for a removed draft checkpoint (`uncovered`). Returns the records left
 * without them.
 */
async function checkOwnerEnvelopes<E extends KeyEnvelopeV2 | MetadataEnvelopeV2>(
  tx: Database,
  envelopes: readonly E[],
  {
    subjectKind,
    records,
    owners,
    granter,
    versionOf,
  }: {
    subjectKind: 'revision' | 'metadata';
    records: readonly string[];
    owners: readonly PublicIdentity[];
    granter: PublicIdentity;
    versionOf: (envelope: E) => string;
  },
): Promise<string[]> {
  const wanted = new Set(records);
  const current = new Map(owners.map((owner) => [owner.id, owner.keyVersion]));
  const given = new Map<string, Set<string>>();
  for (const envelope of envelopes) {
    const id = versionOf(envelope);
    if (!wanted.has(id)) {
      throw await uncovered(
        tx,
        subjectKind,
        id,
        new ContentError('binding-mismatch', 'An envelope is for something else'),
      );
    }
    const to = given.get(id) ?? new Set();
    if (
      current.get(envelope.recipientId) !== envelope.recipientKeyVersion ||
      to.has(envelope.recipientId)
    ) {
      throw new ContentError('recipients-mismatch', 'Keys must go to exactly the current owners');
    }
    to.add(envelope.recipientId);
    given.set(id, to);
    // The key `verifyGrants` checked the signature with is still the caller's.
    if (envelope.granterId !== granter.id || envelope.granterKeyVersion !== granter.keyVersion) {
      throw new ContentError('bad-signature', 'Every envelope must be signed by you');
    }
  }
  return records.filter((id) => (given.get(id)?.size ?? 0) !== owners.length);
}

/** Replace the subtree's wraps and envelopes with the checked ones of the move. */
async function replaceKeyMaterial(tx: Database, move: Move, records: Records) {
  if (records.revision.length > 0) {
    await tx.delete(revisionWraps).where(inArray(revisionWraps.revisionId, records.revision));
    await tx
      .delete(keyEnvelopes)
      .where(
        and(
          eq(keyEnvelopes.subjectKind, 'revision'),
          inArray(keyEnvelopes.subjectId, records.revision),
        ),
      );
  }
  if (records.metadata.length > 0) {
    await tx
      .delete(metadataWraps)
      .where(inArray(metadataWraps.metadataRevisionId, records.metadata));
    await tx
      .delete(keyEnvelopes)
      .where(
        and(
          eq(keyEnvelopes.subjectKind, 'metadata'),
          inArray(keyEnvelopes.subjectId, records.metadata),
        ),
      );
  }
  const wraps = (kind: 'revision' | 'metadata') => move.wraps.filter((w) => w.subjectKind === kind);
  await insertChunked(wraps('revision'), (chunk) =>
    tx.insert(revisionWraps).values(
      chunk.map(({ versionId, wrap }) => ({
        revisionId: versionId,
        shareId: wrap.shareId,
        keyVersion: wrap.keyVersion,
        wrap,
      })),
    ),
  );
  await insertChunked(wraps('metadata'), (chunk) =>
    tx.insert(metadataWraps).values(
      chunk.map(({ versionId, wrap }) => ({
        metadataRevisionId: versionId,
        shareId: wrap.shareId,
        keyVersion: wrap.keyVersion,
        wrap,
      })),
    ),
  );
  const envelopeRows = [
    ...move.keyEnvelopes.map((envelope) => ({
      subjectKind: 'revision' as const,
      subjectId: envelope.revisionId,
      recipientIdentityId: envelope.recipientId,
      recipientKeyVersion: envelope.recipientKeyVersion,
      envelope,
    })),
    ...move.metadataEnvelopes.map((envelope) => ({
      subjectKind: 'metadata' as const,
      subjectId: envelope.metadataRevisionId,
      recipientIdentityId: envelope.recipientId,
      recipientKeyVersion: envelope.recipientKeyVersion,
      envelope,
    })),
  ];
  await insertChunked(envelopeRows, (chunk) => tx.insert(keyEnvelopes).values(chunk));
}

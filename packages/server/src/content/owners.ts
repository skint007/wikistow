// A space's owners and owner statements (protocol sections 6.5 and 7.6),
// and deleting the space.
import {
  Hash32,
  InstallationId,
  ownerRoutes,
  OwnerStatement,
  SpaceId,
  PublicIdentity,
  type FolderKeyEnvelope,
  type KeyEnvelopeV2,
  type MetadataEnvelopeV2,
  type sharingRoutes,
} from '@wikistow/contracts';
import {
  keyEnvelopeV2Bytes,
  keyHash,
  metadataEnvelopeV2Bytes,
  ownerStatementBytes,
  verifySignature,
} from '@wikistow/client';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../admin/audit.ts';
import type { BlobStore } from '../blobs/store.ts';
import type { Database } from '../db/client.ts';
import {
  blobs,
  folderKeyEnvelopes,
  groupMembers,
  groups,
  identities,
  keyEnvelopes,
  metadataRevisions,
  nodes,
  ownerStatements,
  revisions,
  shareMembers,
  shares,
  spaceOwners,
  spaces,
  users,
} from '../db/schema/index.ts';
import { readSettings } from '../settings.ts';
import { currentOwners, isOwner } from './access.ts';
import { endAgentGrants } from './agents.ts';
import { lookupIdentities } from './identities.ts';
import {
  applyRotation,
  bumpPermissions,
  checkFolderEnvelopes,
  lockSpaceForUpdate,
  requireOwner,
  storeFolderEnvelopes,
  uncovered,
} from './sharing.ts';
import { ContentError } from './errors.ts';
import { deleteUnlistedFile } from './pages.ts';
import { peopleById } from './people.ts';
import { endPublicationsFrom } from './publications.ts';
import { readStored, type ReportUnreadable } from './stored.ts';
import { isHomeSpace, requireIdentity } from './structure.ts';

type Rotation = z.output<typeof sharingRoutes.Rotation>;

// A name record's signed parts, as the owners route serves them.
const SignedName = ownerRoutes.owners.response.shape.nameRecords.element;

/**
 * The caller's place in a space: an owner, a member of one of its shares,
 * or nothing, which is `not-found`.
 */
async function requireInSpace(db: Database, identityId: string, spaceId: string) {
  if (await isOwner(db, identityId, spaceId)) return 'owner' as const;
  const [held] = await db
    .select({ shareId: shareMembers.shareId })
    .from(shareMembers)
    .innerJoin(shares, eq(shares.id, shareMembers.shareId))
    .where(and(eq(shares.spaceId, spaceId), eq(shareMembers.identityId, identityId)))
    .limit(1);
  if (!held) throw new ContentError('not-found');
  return 'member' as const;
}

/**
 * The space's current owners at their current keys, for its owners and
 * members, and for owners the space's first name record without its
 * payload: an app accepts itself as an owner if it wrote that record
 * (section 6.5, step 1).
 */
export async function listOwners(
  db: Database,
  accountId: string,
  spaceId: string,
  report: ReportUnreadable,
) {
  const identity = await requireIdentity(db, accountId);
  const place = await requireInSpace(db, identity.id, spaceId);
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId));
  if (!space) throw new ContentError('not-found');
  const rows = await db
    .select({ id: spaceOwners.identityId })
    .from(spaceOwners)
    .where(and(eq(spaceOwners.spaceId, spaceId), isNull(spaceOwners.removedAt)));
  const firstNames =
    place === 'owner'
      ? await db
          .select({
            id: metadataRevisions.id,
            sealed: sql<unknown>`${metadataRevisions.sealed} - 'payload'`,
          })
          .from(metadataRevisions)
          .where(
            and(
              eq(metadataRevisions.spaceId, spaceId),
              eq(metadataRevisions.subjectKind, 'space'),
              eq(metadataRevisions.subjectId, spaceId),
              isNull(metadataRevisions.basedOn),
            ),
          )
      : [];
  return {
    owners: await peopleById(
      db,
      rows.map((row) => row.id),
    ),
    nameRecords: firstNames.flatMap(({ id, sealed }) => {
      const signed = readStored(SignedName, sealed, { table: 'metadata_revisions', id }, report);
      return signed ? [signed] : [];
    }),
    permissionVersion: space.permissionVersion,
  };
}

/** Every owner statement of the space, in the order stored, for its owners and members. */
export async function listStatements(
  db: Database,
  accountId: string,
  spaceId: string,
  report: ReportUnreadable,
) {
  const identity = await requireIdentity(db, accountId);
  await requireInSpace(db, identity.id, spaceId);
  const rows = await db
    .select({ id: ownerStatements.id, statement: ownerStatements.statement })
    .from(ownerStatements)
    .where(eq(ownerStatements.spaceId, spaceId))
    .orderBy(asc(ownerStatements.id));
  return rows.flatMap(({ id, statement }) => {
    const stored = { table: 'owner_statements', id: String(id) };
    const parsed = readStored(OwnerStatement, statement, stored, report);
    return parsed ? [parsed] : [];
  });
}

// The parts of a stored record a later envelope is signed over.
const RecordParts = z.object({
  installationId: InstallationId,
  spaceId: SpaceId,
  payloadHash: Hash32,
});
type RecordParts = z.output<typeof RecordParts>;

/**
 * The signed record of every owner-region version in the space, by ID:
 * every page and metadata version with no key wrap. These are what a new
 * co-owner must get an envelope for (section 7.6, step 2).
 */
async function ownerRegionRecords(tx: Database, spaceId: string) {
  // A stored record today's schemas refuse can't be signed over, and is left out.
  const read = async (table: 'revisions' | 'metadata_revisions', wraps: string, column: string) => {
    const rows = await tx.execute<{ id: string; record: unknown }>(sql`
      select r.id, r.sealed -> 'record' as record from ${sql.identifier(table)} r
      where r.space_id = ${spaceId}
        and not exists (select 1 from ${sql.identifier(wraps)} w where w.${sql.identifier(column)} = r.id)`);
    return new Map(
      [...rows].flatMap((row) => {
        const record = RecordParts.safeParse(row.record);
        return record.success ? [[row.id, record.data] as const] : [];
      }),
    );
  };
  return {
    revision: await read('revisions', 'revision_wraps', 'revision_id'),
    metadata: await read('metadata_revisions', 'metadata_wraps', 'metadata_revision_id'),
  };
}

type GrantCheck<E> = {
  records: ReadonlyMap<string, RecordParts>;
  versionOf: (envelope: E) => string;
  granter: PublicIdentity;
  signedBytes: (record: RecordParts, envelope: E) => Uint8Array;
};

/**
 * Granted envelopes whose signatures verify, each by `granter` over the
 * record it names in `records`, with the record's parts as verified. Run
 * before the space is locked, so the check under the lock repeats only
 * what changed meanwhile: a record's signed parts never do.
 */
function verifyGrantedAhead<E extends KeyEnvelopeV2 | MetadataEnvelopeV2>(
  envelopes: readonly E[],
  { records, versionOf, granter, signedBytes }: GrantCheck<E>,
): Map<E, string> {
  const verified = new Map<E, string>();
  for (const envelope of envelopes) {
    const record = records.get(versionOf(envelope));
    if (
      record &&
      envelope.granterId === granter.id &&
      envelope.granterKeyVersion === granter.keyVersion &&
      verifySignature(granter, signedBytes(record, envelope), envelope.signature)
    ) {
      verified.set(envelope, JSON.stringify(record));
    }
  }
  return verified;
}

/**
 * v2 envelopes an owner grants later, for existing records (section 5.8):
 * exactly one per record in `records`, to `recipient` at their key, each
 * naming its record and signed by `granter` over that record's space and
 * payload hash. One naming a removed draft checkpoint is `stale-head`
 * (`uncovered`). A signature `ahead` verified over the same record by the
 * same key isn't verified again.
 */
async function checkGrantedEnvelopes<E extends KeyEnvelopeV2 | MetadataEnvelopeV2>(
  tx: Database,
  envelopes: readonly E[],
  {
    subjectKind,
    records,
    versionOf,
    recipient,
    granter,
    signedBytes,
    ahead,
  }: GrantCheck<E> & {
    subjectKind: 'revision' | 'metadata';
    recipient: PublicIdentity;
    ahead: { granter: PublicIdentity; verified: ReadonlyMap<E, string> };
  },
) {
  const sameKey =
    ahead.granter.id === granter.id &&
    ahead.granter.keyVersion === granter.keyVersion &&
    ahead.granter.signPublicKey === granter.signPublicKey;
  const given = new Set<string>();
  for (const envelope of envelopes) {
    const id = versionOf(envelope);
    const record = records.get(id);
    const refused = new ContentError('recipients-mismatch', 'An envelope is for something else');
    if (given.has(id)) throw refused;
    if (!record) throw await uncovered(tx, subjectKind, id, refused);
    given.add(id);
    if (
      envelope.recipientId !== recipient.id ||
      envelope.recipientKeyVersion !== recipient.keyVersion
    ) {
      throw new ContentError('recipients-mismatch', 'Every envelope must go to the new owner');
    }
    const signed =
      envelope.granterId === granter.id &&
      envelope.granterKeyVersion === granter.keyVersion &&
      ((sameKey && ahead.verified.get(envelope) === JSON.stringify(record)) ||
        verifySignature(granter, signedBytes(record, envelope), envelope.signature));
    if (!signed) throw new ContentError('bad-signature', 'Every envelope must be signed by you');
  }
  if (given.size !== records.size) {
    throw new ContentError('stale-head', 'The space changed since you loaded it');
  }
}

/**
 * An owner statement the caller signs: for this installation and space, by
 * the caller at their current key, naming a person at the exact key the
 * identity row of that version has, with a valid signature.
 */
async function checkStatement(
  tx: Database,
  statement: OwnerStatement,
  { spaceId, signer, named }: { spaceId: string; signer: PublicIdentity; named: PublicIdentity },
) {
  const { installationId } = await readSettings(tx);
  if (statement.installationId !== installationId || statement.spaceId !== spaceId) {
    throw new ContentError('binding-mismatch', 'The statement is for another space');
  }
  if (
    named.kind !== 'human' ||
    statement.owner.id !== named.id ||
    statement.owner.keyVersion !== named.keyVersion ||
    statement.owner.keyHash !== keyHash(named)
  ) {
    throw new ContentError('binding-mismatch', 'The statement names someone else');
  }
  const signed =
    statement.signerId === signer.id &&
    statement.signerKeyVersion === signer.keyVersion &&
    verifySignature(signer, ownerStatementBytes(statement), statement.signature);
  if (!signed) throw new ContentError('bad-signature', 'The statement must be signed by you');
}

async function storeStatement(tx: Database, statement: OwnerStatement) {
  await tx
    .insert(ownerStatements)
    .values({
      spaceId: statement.spaceId,
      ownerIdentityId: statement.owner.id,
      ownerKeyVersion: statement.owner.keyVersion,
      signerIdentityId: statement.signerId,
      signerKeyVersion: statement.signerKeyVersion,
      statement,
    })
    .onConflictDoNothing();
}

/** One identity at one key version, as stored, or null. */
async function identityAt(tx: Database, id: string, keyVersion: number) {
  const [row] = await tx
    .select()
    .from(identities)
    .where(and(eq(identities.id, id), eq(identities.keyVersion, keyVersion)));
  return row
    ? PublicIdentity.parse({
        id: row.id,
        kind: row.kind,
        keyVersion: row.keyVersion,
        boxPublicKey: row.boxPublicKey,
        signPublicKey: row.signPublicKey,
      })
    : null;
}

/**
 * Add co-owner `Q`, or re-add one whose key changed (section 7.6). Under a
 * lock on the space, `Q` must be a person at their live key, and the
 * caller's envelopes must give them every key version of every share in the
 * space, with both keys, and every owner-region record's key, with the
 * caller's statement naming them. `Q` stops being a member of any share
 * there, and leaves its groups: owners hold every key. All or nothing.
 */
export async function addOwner(
  db: Database,
  input: {
    accountId: string;
    spaceId: string;
    identityId: string;
    keyVersion: number;
    statement: OwnerStatement;
    folderKeyEnvelopes: readonly FolderKeyEnvelope[];
    keyEnvelopes: readonly KeyEnvelopeV2[];
    metadataEnvelopes: readonly MetadataEnvelopeV2[];
    permissionVersion: number;
  },
): Promise<void> {
  // The envelope for every owner-region record is verified before the
  // space is locked, so writes there don't wait on thousands of signatures.
  const caller = await requireIdentity(db, input.accountId);
  const current = await ownerRegionRecords(db, input.spaceId);
  const keyGrants = {
    versionOf: (e: KeyEnvelopeV2) => e.revisionId,
    signedBytes: (record: RecordParts, e: KeyEnvelopeV2) => keyEnvelopeV2Bytes(record, e),
  };
  const metadataGrants = {
    versionOf: (e: MetadataEnvelopeV2) => e.metadataRevisionId,
    signedBytes: (record: RecordParts, e: MetadataEnvelopeV2) => metadataEnvelopeV2Bytes(record, e),
  };
  const ahead = {
    keys: verifyGrantedAhead(input.keyEnvelopes, {
      ...keyGrants,
      records: current.revision,
      granter: caller,
    }),
    metadata: verifyGrantedAhead(input.metadataEnvelopes, {
      ...metadataGrants,
      records: current.metadata,
      granter: caller,
    }),
  };
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const space = await lockSpaceForUpdate(tx, input.spaceId);
    await requireOwner(tx, identity, input.spaceId);
    if (space.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    const [added] = await lookupIdentities(tx, [input.identityId]);
    if (!added || added.kind !== 'human' || added.keyVersion !== input.keyVersion) {
      throw new ContentError(
        'recipients-mismatch',
        'An owner must be a person, at their current key',
      );
    }
    await checkStatement(tx, input.statement, {
      spaceId: input.spaceId,
      signer: identity,
      named: added,
    });
    const spaceShares = await tx.select().from(shares).where(eq(shares.spaceId, input.spaceId));
    for (const share of spaceShares) {
      await checkFolderEnvelopes(
        tx,
        input.folderKeyEnvelopes.filter((e) => e.shareId === share.id),
        {
          spaceId: input.spaceId,
          shareId: share.id,
          sealer: identity,
          expected: Array.from({ length: share.currentKeyVersion }, (_, i) => ({
            recipientId: added.id,
            recipientKeyVersion: added.keyVersion,
            keyVersion: i + 1,
            drafts: true,
          })),
        },
      );
    }
    const known = new Set(spaceShares.map((share) => share.id));
    if (!input.folderKeyEnvelopes.every((e) => known.has(e.shareId))) {
      throw new ContentError('binding-mismatch', 'An envelope is for another share');
    }
    const records = await ownerRegionRecords(tx, input.spaceId);
    await checkGrantedEnvelopes(tx, input.keyEnvelopes, {
      ...keyGrants,
      subjectKind: 'revision',
      records: records.revision,
      recipient: added,
      granter: identity,
      ahead: { granter: caller, verified: ahead.keys },
    });
    await checkGrantedEnvelopes(tx, input.metadataEnvelopes, {
      ...metadataGrants,
      subjectKind: 'metadata',
      records: records.metadata,
      recipient: added,
      granter: identity,
      ahead: { granter: caller, verified: ahead.metadata },
    });

    await tx
      .insert(spaceOwners)
      .values({ spaceId: input.spaceId, identityId: added.id, addedBy: input.accountId })
      .onConflictDoUpdate({
        target: [spaceOwners.spaceId, spaceOwners.identityId],
        set: { removedAt: null, addedBy: input.accountId },
      });
    const shareIds = [...known];
    if (shareIds.length > 0) {
      await tx
        .delete(shareMembers)
        .where(and(inArray(shareMembers.shareId, shareIds), eq(shareMembers.identityId, added.id)));
      await tx
        .delete(folderKeyEnvelopes)
        .where(
          and(
            inArray(folderKeyEnvelopes.shareId, shareIds),
            eq(folderKeyEnvelopes.recipientIdentityId, added.id),
            eq(folderKeyEnvelopes.recipientKeyVersion, added.keyVersion),
          ),
        );
    }
    const left = await tx
      .delete(groupMembers)
      .where(
        and(
          eq(groupMembers.identityId, added.id),
          inArray(
            groupMembers.groupId,
            tx.select({ id: groups.id }).from(groups).where(eq(groups.spaceId, input.spaceId)),
          ),
        ),
      )
      .returning({ groupId: groupMembers.groupId });
    for (const { groupId } of left) {
      await audit(tx, {
        actor: input.accountId,
        action: 'group.member-removed',
        target: { kind: 'group', id: groupId },
        details: { identityId: added.id },
      });
    }
    await storeFolderEnvelopes(tx, input.folderKeyEnvelopes);
    for (const [kind, envelopes] of [
      ['revision', input.keyEnvelopes.map((e) => ({ id: e.revisionId, envelope: e }))],
      ['metadata', input.metadataEnvelopes.map((e) => ({ id: e.metadataRevisionId, envelope: e }))],
    ] as const) {
      for (let i = 0; i < envelopes.length; i += 2000) {
        await tx
          .insert(keyEnvelopes)
          .values(
            envelopes.slice(i, i + 2000).map(({ id, envelope }) => ({
              subjectKind: kind,
              subjectId: id,
              recipientIdentityId: added.id,
              recipientKeyVersion: added.keyVersion,
              envelope,
            })),
          )
          .onConflictDoNothing();
      }
    }
    await storeStatement(tx, input.statement);
    await bumpPermissions(
      tx,
      input.spaceId,
      (await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.spaceId, input.spaceId))).map(
        (n) => n.id,
      ),
    );
    await audit(tx, {
      actor: input.accountId,
      action: 'space.owner-added',
      target: { kind: 'space', id: input.spaceId },
      details: { identityId: added.id, keyVersion: added.keyVersion },
    });
  });
}

/**
 * A new owner's statement naming the owner who added them (section 6.5):
 * signed by the caller, a current owner, at their current key, naming a
 * person who is, or has been, an owner of the space, at the exact key of
 * that identity version.
 */
export async function addStatement(
  db: Database,
  input: { accountId: string; spaceId: string; statement: OwnerStatement },
): Promise<void> {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    await requireOwner(tx, identity, input.spaceId);
    const { owner } = input.statement;
    const [everOwner] = await tx
      .select()
      .from(spaceOwners)
      .where(and(eq(spaceOwners.spaceId, input.spaceId), eq(spaceOwners.identityId, owner.id)));
    const named = everOwner ? await identityAt(tx, owner.id, owner.keyVersion) : null;
    if (!named) throw new ContentError('binding-mismatch', 'The statement names someone else');
    await checkStatement(tx, input.statement, { spaceId: input.spaceId, signer: identity, named });
    await storeStatement(tx, input.statement);
  });
}

/**
 * Remove owner `R`, the caller included (section 7.6), rotating every share
 * in the space at once, each leaving `R` out. Under a lock on the space:
 * `R` is a current owner, not the last one (`last-owner`), and there is
 * exactly one rotation for each share, each checked as a rotation is, with
 * every owner but `R`. A retry is the same request prepared again; once `R`
 * is no longer an owner there is nothing to retry (`not-found`).
 */
export async function removeOwner(
  db: Database,
  input: {
    accountId: string;
    spaceId: string;
    identityId: string;
    rotations: readonly (Rotation & { shareId: string })[];
    permissionVersion: number;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const space = await lockSpaceForUpdate(tx, input.spaceId);
    await requireOwner(tx, identity, input.spaceId);
    if (space.permissionVersion !== input.permissionVersion) {
      throw new ContentError('permission-version', 'Access changed; reload and try again');
    }
    const owners = await currentOwners(tx, input.spaceId);
    if (!owners.some((owner) => owner.id === input.identityId)) {
      throw new ContentError('not-found', 'That person is not an owner');
    }
    const remaining = owners.filter((owner) => owner.id !== input.identityId);
    if (remaining.length === 0) {
      throw new ContentError('last-owner', 'A space always keeps one owner');
    }
    const spaceShares = await tx
      .select()
      .from(shares)
      .where(eq(shares.spaceId, input.spaceId))
      .for('update');
    const byShare = new Map(input.rotations.map((rotation) => [rotation.shareId, rotation]));
    if (
      byShare.size !== input.rotations.length ||
      byShare.size !== spaceShares.length ||
      !spaceShares.every((share) => byShare.has(share.id))
    ) {
      throw new ContentError('stale-head', 'Every share in the space must rotate once');
    }
    for (const share of spaceShares) {
      const rotation = byShare.get(share.id);
      if (!rotation) continue;
      await applyRotation(tx, { share, rotation, sealer: identity, owners: remaining });
    }
    await tx
      .update(spaceOwners)
      .set({ removedAt: sql`now()` })
      .where(
        and(eq(spaceOwners.spaceId, input.spaceId), eq(spaceOwners.identityId, input.identityId)),
      );
    // Their agents held keys only through them (section 7.6).
    await endAgentGrants(tx, {
      personIds: [input.identityId],
      shareIds: spaceShares.map((share) => share.id),
    });
    await bumpPermissions(
      tx,
      input.spaceId,
      (await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.spaceId, input.spaceId))).map(
        (n) => n.id,
      ),
    );
    await audit(tx, {
      actor: input.accountId,
      action: 'space.owner-removed',
      target: { kind: 'space', id: input.spaceId },
      details: { identityId: input.identityId, shares: spaceShares.length },
    });
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
    const space = await lockSpaceForUpdate(tx, spaceId);
    await requireOwner(tx, identity, spaceId);
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

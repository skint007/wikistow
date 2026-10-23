// Shares, their members and their folder key envelopes (protocol sections
// 6.4, 6.7, 7.3 to 7.5 and 7.7).
import {
  FolderKeyEnvelope,
  InstallationId,
  sharingRoutes,
  type KeyWrap,
  type PublicIdentity,
} from '@wikistow/contracts';
import { folderKeyEnvelopeBytes, verifySignature } from '@wikistow/client';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../admin/audit.ts';
import type { Database } from '../db/client.ts';
import {
  agentGrants,
  agentProfiles,
  folderKeyEnvelopes,
  groupMembers,
  groups,
  keyEnvelopes,
  metadataRevisions,
  metadataWraps,
  nodes,
  revisions,
  revisionWraps,
  shareGroups,
  shareMembers,
  shares,
  spaceOwners,
  spaces,
} from '../db/schema/index.ts';
import { endLapsedWhere } from '../public-links/links.ts';
import { readSettings } from '../settings.ts';
import {
  accessTo,
  agentGrantsOf,
  agentStart,
  ancestorsOf,
  currentOwners,
  isOwner,
  subtreeOf,
  type ShareRow,
} from './access.ts';
import { endAgentGrants, requireOwnAgents, storeNewShareGrants } from './agents.ts';
import {
  groupAccess,
  highest,
  keysCover,
  keysExceed,
  recomputeMembers,
  type Grant,
} from './effective.ts';
import { ContentError } from './errors.ts';
import { lookupIdentities, requireCaller, type Actor, type Caller } from './identities.ts';
import { revisionKeyMaterial, servedMetadata } from './serving.ts';
import { readStored, type ReportUnreadable } from './stored.ts';
import { requireIdentity, shareOf } from './structure.ts';

type Member = z.output<typeof sharingRoutes.Member>;
type Rotation = z.output<typeof sharingRoutes.Rotation>;
type NewAgentGrant = z.output<typeof sharingRoutes.makeShare.body>['agentGrants'][number];
type NewGroupGrant = z.output<typeof sharingRoutes.makeShare.body>['groups'][number];

/** Inserts are split so no statement passes Postgres's limit on parameters. */
const CHUNK = 2000;

export async function insertChunked<T>(
  rows: readonly T[],
  insert: (chunk: T[]) => Promise<unknown>,
) {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
}

/**
 * Owner actions are for the space's current owners. Someone who holds
 * something in the space is told no; anyone else, that it doesn't exist.
 */
export async function requireOwner(tx: Database, identity: PublicIdentity, spaceId: string) {
  if (await isOwner(tx, identity.id, spaceId)) return;
  const [held] = await tx
    .select({ id: shareMembers.shareId })
    .from(shareMembers)
    .innerJoin(shares, eq(shares.id, shareMembers.shareId))
    .where(and(eq(shares.spaceId, spaceId), eq(shareMembers.identityId, identity.id)))
    .limit(1);
  throw new ContentError(held ? 'forbidden' : 'not-found');
}

/**
 * For an owner action with a large body, before the body is read: the
 * caller has a vault and owns the space, or is refused as `requireOwner`
 * refuses, so nobody else can make the server read and parse one. The
 * action checks again under its lock.
 */
export async function checkSpaceOwner(db: Database, accountId: string, spaceId: string) {
  await requireOwner(db, await requireIdentity(db, accountId), spaceId);
}

/** `checkSpaceOwner` for the space a share is in. */
export async function checkShareOwner(db: Database, accountId: string, shareId: string) {
  const identity = await requireIdentity(db, accountId);
  await requireOwner(db, identity, (await requireShare(db, shareId)).spaceId);
}

/**
 * Hold the space against every write and every other region or owner
 * change until the transaction ends: writes take a key-share lock on its
 * row first, which this blocks.
 */
export async function lockSpaceForUpdate(tx: Database, spaceId: string) {
  const [space] = await tx.select().from(spaces).where(eq(spaces.id, spaceId)).for('update');
  if (!space) throw new ContentError('not-found');
  return space;
}

/** Every node at or under `rootId`, or every node of the space for `null`. */
export async function nodesUnder(tx: Database, spaceId: string, rootId: string | null) {
  const rows =
    rootId === null
      ? await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.spaceId, spaceId))
      : [
          ...(await tx.execute<{ id: string }>(
            sql`${subtreeOf(spaceId, rootId)} select id from subtree`,
          )),
        ];
  return rows.map((row) => row.id);
}

/**
 * Every retained page and metadata version a share over `rootId` covers
 * (section 6.7): of every page and folder in its subtree, and for a space
 * share, the space's own name too. Group names stay in the owner region.
 */
export async function recordsUnder(tx: Database, spaceId: string, rootId: string | null) {
  const ids = await nodesUnder(tx, spaceId, rootId);
  const pageVersions =
    ids.length === 0
      ? []
      : await tx
          .select({ id: revisions.id })
          .from(revisions)
          .where(and(eq(revisions.spaceId, spaceId), inArray(revisions.pageId, ids)));
  const names = await tx
    .select({ id: metadataRevisions.id })
    .from(metadataRevisions)
    .where(
      and(
        eq(metadataRevisions.spaceId, spaceId),
        rootId === null
          ? inArray(metadataRevisions.subjectKind, ['space', 'folder'])
          : and(
              eq(metadataRevisions.subjectKind, 'folder'),
              ids.length === 0 ? sql`false` : inArray(metadataRevisions.subjectId, ids),
            ),
      ),
    );
  return {
    nodeIds: ids,
    revision: pageVersions.map((row) => row.id),
    metadata: names.map((row) => row.id),
  };
}

/** Bump the permission versions of the space and of `nodeIds`, so writes prepared before fail. */
export async function bumpPermissions(tx: Database, spaceId: string, nodeIds: readonly string[]) {
  await tx
    .update(spaces)
    .set({ permissionVersion: sql`${spaces.permissionVersion} + 1` })
    .where(eq(spaces.id, spaceId));
  if (nodeIds.length === 0) return;
  await tx
    .update(nodes)
    .set({ permissionVersion: sql`${nodes.permissionVersion} + 1` })
    .where(and(eq(nodes.spaceId, spaceId), inArray(nodes.id, [...nodeIds])));
}

/** The permission version a change to the share over `rootId` carries: its root's, or the space's. */
export async function rootPermissionVersion(tx: Database, spaceId: string, rootId: string | null) {
  if (rootId === null) {
    const [space] = await tx.select().from(spaces).where(eq(spaces.id, spaceId));
    if (!space) throw new ContentError('not-found');
    return space.permissionVersion;
  }
  const [folder] = await tx
    .select({ permissionVersion: nodes.permissionVersion })
    .from(nodes)
    .where(and(eq(nodes.id, rootId), eq(nodes.spaceId, spaceId), eq(nodes.kind, 'folder')));
  if (!folder) throw new ContentError('not-found');
  return folder.permissionVersion;
}

export function requirePermissionVersion(actual: number, given: number) {
  if (actual !== given) {
    throw new ContentError('permission-version', 'Access changed; reload and try again');
  }
}

/** An envelope the server expects: one key version, to one recipient key, with or without drafts. */
type Expected = {
  recipientId: string;
  recipientKeyVersion: number;
  keyVersion: number;
  drafts: boolean;
};

const envelopeKey = (e: { recipientId: string; recipientKeyVersion: number; keyVersion: number }) =>
  `${e.recipientId}@${e.recipientKeyVersion}#${e.keyVersion}`;

/**
 * The checks of section 6.4 on folder key envelopes an owner uploads: each
 * names this space and share, is sealed by the caller at their current key
 * with a valid signature, and together they go to exactly the expected
 * recipient keys and key versions, once each, with the draft key exactly
 * where the role needs it.
 */
export async function checkFolderEnvelopes(
  tx: Database,
  envelopes: readonly FolderKeyEnvelope[],
  {
    spaceId,
    shareId,
    sealer,
    expected,
  }: { spaceId: string; shareId: string; sealer: PublicIdentity; expected: readonly Expected[] },
) {
  const { installationId } = await readSettings(tx);
  if (!envelopes.every((e) => e.spaceId === spaceId && e.shareId === shareId)) {
    throw new ContentError('binding-mismatch', 'An envelope is for another share', { shareId });
  }
  const wanted = new Map(expected.map((e) => [envelopeKey(e), e]));
  const given = new Set<string>();
  for (const envelope of envelopes) {
    const key = envelopeKey(envelope);
    const expect = wanted.get(key);
    if (!expect || given.has(key) || (envelope.draftKey !== null) !== expect.drafts) {
      throw new ContentError('recipients-mismatch', 'Keys must go to exactly the people listed');
    }
    given.add(key);
  }
  if (given.size !== wanted.size) {
    throw new ContentError('recipients-mismatch', 'Keys must go to exactly the people listed');
  }
  const signed = envelopes.every(
    (e) =>
      e.sealerId === sealer.id &&
      e.sealerKeyVersion === sealer.keyVersion &&
      verifySignature(
        sealer,
        folderKeyEnvelopeBytes(InstallationId.parse(installationId), e),
        e.signature,
      ),
  );
  if (!signed) throw new ContentError('bad-signature', 'Every envelope must be signed by you');
}

/** Store checked envelopes. A caller replacing a member's envelopes deletes theirs first. */
export async function storeFolderEnvelopes(tx: Database, envelopes: readonly FolderKeyEnvelope[]) {
  await insertChunked(envelopes, (chunk) =>
    tx.insert(folderKeyEnvelopes).values(
      chunk.map((envelope) => ({
        shareId: envelope.shareId,
        keyVersion: envelope.keyVersion,
        recipientIdentityId: envelope.recipientId,
        recipientKeyVersion: envelope.recipientKeyVersion,
        spaceId: envelope.spaceId,
        sealerIdentityId: envelope.sealerId,
        drafts: envelope.draftKey !== null,
        envelope,
      })),
    ),
  );
}

/** Who may receive keys in a share, at their live key, with the access to seal by. */
export type Recipients = ReadonlyMap<string, { identity: PublicIdentity; access: Grant }>;

/**
 * People whose access in `share` (effective, from `access`) needs keys
 * they don't hold at their live key: no member row, a row at an older
 * identity key version, or a reader's keys where they are an editor. They
 * wait until an owner's app seals to them (section 7.9).
 */
export async function lackingKeys(
  tx: Database,
  share: ShareRow,
  access: ReadonlyMap<string, Grant>,
): Promise<Recipients> {
  const rows = new Map(
    (await tx.select().from(shareMembers).where(eq(shareMembers.shareId, share.id))).map((row) => [
      row.identityId,
      row,
    ]),
  );
  const live = await lookupIdentities(tx, [...access.keys()]);
  return new Map(
    live.flatMap((identity) => {
      const grant = access.get(identity.id);
      if (!grant || identity.kind !== 'human') return [];
      const row = rows.get(identity.id);
      if (row?.keyVersion === identity.keyVersion && keysCover(row.role, grant)) return [];
      return [[identity.id, { identity, access: grant }] as const];
    }),
  );
}

/**
 * Give people in `share` the keys their access needs (sections 7.3 and
 * 7.8): envelopes for every key version, at each recipient's live key, by
 * role, in place of any they had there. Every recipient must be in
 * `recipients`, and everyone in `must` among them; anyone else left out
 * waits. Their member rows take the new key version and role, with no
 * direct grant for a new row; the caller recomputes publish rights.
 * Returns who was given keys.
 */
export async function giveKeys(
  tx: Database,
  {
    share,
    sealer,
    envelopes,
    recipients,
    must = [],
    addedBy,
  }: {
    share: ShareRow;
    sealer: PublicIdentity;
    envelopes: readonly FolderKeyEnvelope[];
    recipients: Recipients;
    must?: readonly string[];
    addedBy: string;
  },
) {
  const given = [...new Set<string>(envelopes.map((e) => e.recipientId))];
  if (!given.every((id) => recipients.has(id)) || !must.every((id) => given.includes(id))) {
    throw new ContentError('recipients-mismatch', 'Keys must go to exactly the people listed');
  }
  const people = given.flatMap((id) => {
    const recipient = recipients.get(id);
    return recipient ? [recipient] : [];
  });
  await checkFolderEnvelopes(tx, envelopes, {
    spaceId: share.spaceId,
    shareId: share.id,
    sealer,
    expected: people.flatMap(({ identity, access }) =>
      Array.from({ length: share.currentKeyVersion }, (_, i) => ({
        recipientId: identity.id,
        recipientKeyVersion: identity.keyVersion,
        keyVersion: i + 1,
        drafts: access.role === 'editor',
      })),
    ),
  });
  if (given.length > 0) {
    await tx
      .delete(folderKeyEnvelopes)
      .where(
        and(
          eq(folderKeyEnvelopes.shareId, share.id),
          inArray(folderKeyEnvelopes.recipientIdentityId, given),
        ),
      );
  }
  for (const { identity, access } of people) {
    const row = { keyVersion: identity.keyVersion, role: access.role, canPublish: false };
    await tx
      .insert(shareMembers)
      .values({ shareId: share.id, identityId: identity.id, addedBy, ...row })
      .onConflictDoUpdate({ target: [shareMembers.shareId, shareMembers.identityId], set: row });
  }
  await storeFolderEnvelopes(tx, envelopes);
  return people;
}

/** People who become members must be people, at their live key, and not owners already. */
async function requireMembers(
  tx: Database,
  spaceId: string,
  members: readonly Member[],
): Promise<void> {
  const ids = members.map((m) => m.identityId);
  if (new Set(ids).size !== ids.length) {
    throw new ContentError('recipients-mismatch', 'A person is listed twice');
  }
  const live = new Map((await lookupIdentities(tx, ids)).map((i) => [i.id, i]));
  for (const member of members) {
    const identity = live.get(member.identityId);
    if (!identity || identity.kind !== 'human' || identity.keyVersion !== member.keyVersion) {
      throw new ContentError('recipients-mismatch', 'Members must be people, at their current key');
    }
    if (await isOwner(tx, member.identityId, spaceId)) {
      throw new ContentError('recipients-mismatch', 'Owners hold every key already');
    }
  }
}

/** Envelopes every current owner must get for one key version: both keys, at their live key. */
const ownersExpected = (owners: readonly PublicIdentity[], keyVersion: number): Expected[] =>
  owners.map((owner) => ({
    recipientId: owner.id,
    recipientKeyVersion: owner.keyVersion,
    keyVersion,
    drafts: true,
  }));

/**
 * The groups a new share is made with, each one of the space's, and the
 * access their human members get through them (section 7.8).
 */
async function newShareGroupAccess(
  tx: Database,
  spaceId: string,
  grants: readonly NewGroupGrant[],
) {
  const ids = grants.map((grant) => grant.groupId);
  const access = new Map<string, Grant>();
  if (ids.length === 0) return access;
  if (new Set(ids).size !== ids.length) {
    throw new ContentError('recipients-mismatch', 'A group is listed twice');
  }
  const found = await tx
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.spaceId, spaceId), inArray(groups.id, ids)));
  if (found.length !== ids.length) throw new ContentError('not-found', 'No such group');
  const members = await tx
    .select({ groupId: groupMembers.groupId, identityId: groupMembers.identityId })
    .from(groupMembers)
    .where(inArray(groupMembers.groupId, ids));
  for (const { groupId, identityId } of members) {
    const grant = grants.find((g) => g.groupId === groupId) ?? null;
    const best = highest([access.get(identityId) ?? null, grant]);
    if (best && !identityId.startsWith('agent-')) access.set(identityId, best);
  }
  return access;
}

/**
 * Make a folder, or the whole space, a share (section 6.7). Under a lock on
 * the space: the share ID is new anywhere, shares don't nest, every record
 * in the subtree has exactly one wrap under version 1 of this share, and
 * version 1 goes to every owner, every new member and each of the caller's
 * agents it is made for (section 9.4), and to those of the groups' members
 * the caller seals to, by their effective role (section 7.8). Anyone else
 * in the groups waits. Then the subtree's owner-region envelopes go, the
 * members, groups and agent grants are added, and permission versions move
 * on, so a write prepared against the old region fails. All or nothing.
 */
export async function makeShare(
  db: Database,
  input: {
    accountId: string;
    spaceId: string;
    shareId: string;
    rootId: string | null;
    wraps: readonly { subjectKind: 'revision' | 'metadata'; versionId: string; wrap: KeyWrap }[];
    envelopes: readonly FolderKeyEnvelope[];
    members: readonly Member[];
    agentGrants: readonly NewAgentGrant[];
    groups: readonly NewGroupGrant[];
    permissionVersion: number;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    await lockSpaceForUpdate(tx, input.spaceId);
    await requireOwner(tx, identity, input.spaceId);
    const [taken] = await tx
      .select({ id: shares.id })
      .from(shares)
      .where(eq(shares.id, input.shareId));
    if (taken) throw new ContentError('duplicate', 'That share ID is taken');
    await requireNoNesting(tx, input.spaceId, input.rootId);
    requirePermissionVersion(
      await rootPermissionVersion(tx, input.spaceId, input.rootId),
      input.permissionVersion,
    );

    const records = await recordsUnder(tx, input.spaceId, input.rootId);
    await requireCoverage(tx, input.wraps, records, { shareId: input.shareId, keyVersion: 1 });
    await requireMembers(tx, input.spaceId, input.members);
    const viaGroups = await newShareGroupAccess(tx, input.spaceId, input.groups);
    // Direct members, then the groups' members the caller seals to.
    const direct = new Set<string>(input.members.map((m) => m.identityId));
    const sealedTo = new Set<string>(input.envelopes.map((e) => e.recipientId));
    const grouped = await lookupIdentities(
      tx,
      [...viaGroups.keys()].filter((id) => !direct.has(id) && sealedTo.has(id)),
    );
    const people = [
      ...input.members.map((m) => ({
        identityId: m.identityId,
        keyVersion: m.keyVersion,
        access: highest([viaGroups.get(m.identityId) ?? null, m]) ?? m,
        direct: { directRole: m.role, directCanPublish: m.canPublish },
      })),
      ...grouped.flatMap((person) => {
        const access = viaGroups.get(person.id);
        return access
          ? [
              {
                identityId: person.id,
                keyVersion: person.keyVersion,
                access,
                direct: { directRole: null, directCanPublish: null },
              },
            ]
          : [];
      }),
    ];
    const agents = await requireOwnAgents(tx, input.accountId, input.agentGrants);
    const owners = await currentOwners(tx, input.spaceId);
    await checkFolderEnvelopes(tx, input.envelopes, {
      spaceId: input.spaceId,
      shareId: input.shareId,
      sealer: identity,
      expected: [
        ...ownersExpected(owners, 1),
        ...people.map((p) => ({
          recipientId: p.identityId,
          recipientKeyVersion: p.keyVersion,
          keyVersion: 1,
          drafts: p.access.role === 'editor',
        })),
        ...input.agentGrants.map((grant, i) => ({
          recipientId: agents[i]?.id ?? grant.agentId,
          recipientKeyVersion: 1,
          keyVersion: 1,
          drafts: grant.role === 'editor',
        })),
      ],
    });

    await tx.insert(shares).values({
      id: input.shareId,
      spaceId: input.spaceId,
      rootId: input.rootId,
      createdBy: input.accountId,
    });
    if (people.length > 0) {
      await tx.insert(shareMembers).values(
        people.map((p) => ({
          shareId: input.shareId,
          identityId: p.identityId,
          keyVersion: p.keyVersion,
          role: p.access.role,
          canPublish: false,
          ...p.direct,
          addedBy: input.accountId,
        })),
      );
    }
    if (input.groups.length > 0) {
      await tx
        .insert(shareGroups)
        .values(
          input.groups.map((g) => ({ shareId: input.shareId, addedBy: input.accountId, ...g })),
        );
    }
    await recomputeMembers(tx, [input.shareId]);
    const [made] = await tx.select().from(shares).where(eq(shares.id, input.shareId));
    if (!made) throw new Error('the share just made is gone');
    await storeNewShareGrants(tx, made, input.accountId, input.agentGrants);
    await storeFolderEnvelopes(tx, input.envelopes);
    const wrapRows = (kind: 'revision' | 'metadata') =>
      input.wraps
        .filter((w) => w.subjectKind === kind)
        .map((w) => ({ id: w.versionId, keyVersion: w.wrap.keyVersion, wrap: w.wrap }));
    await insertChunked(wrapRows('revision'), (chunk) =>
      tx.insert(revisionWraps).values(
        chunk.map((w) => ({
          revisionId: w.id,
          shareId: input.shareId,
          keyVersion: w.keyVersion,
          wrap: w.wrap,
        })),
      ),
    );
    await insertChunked(wrapRows('metadata'), (chunk) =>
      tx.insert(metadataWraps).values(
        chunk.map((w) => ({
          metadataRevisionId: w.id,
          shareId: input.shareId,
          keyVersion: w.keyVersion,
          wrap: w.wrap,
        })),
      ),
    );
    for (const [kind, ids] of [
      ['revision', records.revision],
      ['metadata', records.metadata],
    ] as const) {
      if (ids.length === 0) continue;
      await tx
        .delete(keyEnvelopes)
        .where(and(eq(keyEnvelopes.subjectKind, kind), inArray(keyEnvelopes.subjectId, ids)));
    }
    await bumpPermissions(tx, input.spaceId, records.nodeIds);
    await audit(tx, {
      actor: input.accountId,
      action: 'share.created',
      target: { kind: 'share', id: input.shareId },
      details: {
        spaceId: input.spaceId,
        rootId: input.rootId,
        members: input.members.map((m) => m.identityId),
        agents: input.agentGrants.map((grant) => grant.agentId),
        groups: input.groups.map((g) => g.groupId),
        records: input.wraps.length,
      },
    });
  });
}

/**
 * The nesting rule (section 6.1): a space share needs a space with no
 * shares; a folder share, a folder with no share root above it or under it,
 * in a space that isn't shared. Refused as `share-nesting`, naming the share
 * in the way.
 */
async function requireNoNesting(tx: Database, spaceId: string, rootId: string | null) {
  const inSpace = await tx.select().from(shares).where(eq(shares.spaceId, spaceId));
  const nested = (share: ShareRow | undefined) => {
    if (share) {
      throw new ContentError('share-nesting', 'Shares never nest', { shareId: share.id });
    }
  };
  if (rootId === null) return nested(inSpace[0]);
  const [folder] = await tx
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, rootId), eq(nodes.spaceId, spaceId), eq(nodes.kind, 'folder')));
  if (!folder) throw new ContentError('not-found');
  nested(inSpace.find((share) => share.rootId === null));
  const above = new Set(
    [
      ...(await tx.execute<{ id: string }>(
        sql`${ancestorsOf(spaceId, rootId)} select id from ancestors`,
      )),
    ].map((row) => row.id),
  );
  const below = new Set(await nodesUnder(tx, spaceId, rootId));
  nested(
    inSpace.find((share) => share.rootId && (above.has(share.rootId) || below.has(share.rootId))),
  );
}

/**
 * The error for key material naming a record outside what it must cover. A
 * revision no longer stored was an old draft checkpoint removed since the
 * app read it (`stale-head`, so the app reloads); anything else is `refused`.
 */
export async function uncovered(
  tx: Database,
  subjectKind: 'revision' | 'metadata',
  id: string,
  refused: ContentError,
) {
  if (subjectKind === 'revision') {
    const [kept] = await tx
      .select({ id: revisions.id })
      .from(revisions)
      .where(eq(revisions.id, id));
    if (!kept) return new ContentError('stale-head', 'The content changed since you loaded it');
  }
  return refused;
}

/**
 * Exactly one wrap for every record in `records`, under `keyVersion` of the
 * share: a missing one means the subtree changed since the owner's app read
 * it (`stale-head`), and one for anything else is `binding-mismatch`, or
 * `stale-head` for a removed draft checkpoint (`uncovered`).
 */
export async function requireCoverage(
  tx: Database,
  wraps: readonly { subjectKind: 'revision' | 'metadata'; versionId: string; wrap: KeyWrap }[],
  records: { revision: readonly string[]; metadata: readonly string[] },
  { shareId, keyVersion }: { shareId: string; keyVersion: number },
) {
  const wanted = new Set([
    ...records.revision.map((id) => `revision:${id}`),
    ...records.metadata.map((id) => `metadata:${id}`),
  ]);
  const given = new Set<string>();
  for (const { subjectKind, versionId, wrap } of wraps) {
    const key = `${subjectKind}:${versionId}`;
    if (given.has(key)) {
      throw new ContentError('binding-mismatch', 'A wrap is for something outside the share');
    }
    if (!wanted.has(key)) {
      throw await uncovered(
        tx,
        subjectKind,
        versionId,
        new ContentError('binding-mismatch', 'A wrap is for something outside the share'),
      );
    }
    if (wrap.shareId !== shareId || wrap.keyVersion !== keyVersion) {
      throw new ContentError('binding-mismatch', 'A wrap is under another key version', {
        shareId,
        keyVersion,
      });
    }
    given.add(key);
  }
  if (given.size !== wanted.size) {
    throw new ContentError('stale-head', 'The folder changed since you loaded it');
  }
}

/** A share by ID, with the caller's identity, or `not-found`. */
export async function requireShare(
  tx: Database,
  shareId: string,
  { lock }: { lock?: 'update' } = {},
) {
  const query = tx.select().from(shares).where(eq(shares.id, shareId));
  const [share] = lock ? await query.for(lock) : await query;
  if (!share) throw new ContentError('not-found');
  return share;
}

/**
 * Hold a share's space as a write would, then the share's row for update:
 * a rotation or member change waits for writes under the share to finish,
 * and writes wait for it. The space is taken first, as every write takes it.
 */
async function lockShareForChange(tx: Database, shareId: string) {
  const share = await requireShare(tx, shareId);
  const [space] = await tx
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.id, share.spaceId))
    .for('key share');
  if (!space) throw new ContentError('not-found');
  return requireShare(tx, shareId, { lock: 'update' });
}

/**
 * Set a member's direct grant (sections 7.3, 7.4 and 7.8): add them, make
 * a reader an editor, share again with one whose key changed, or change
 * publish rights. Where the keys they hold at their key fall short of
 * their effective access, envelopes must give every key version of the
 * share at their key, with the draft key exactly for an editor, in place
 * of any they had; otherwise envelopes are optional and replace theirs the
 * same way. Lowering the grant below the keys they hold is a rotation, so
 * it is refused here; while a group keeps their access it changes no keys.
 */
export async function addMember(
  db: Database,
  input: {
    accountId: string;
    shareId: string;
    member: Member;
    envelopes: readonly FolderKeyEnvelope[];
    permissionVersion: number;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const share = await lockShareForChange(tx, input.shareId);
    await requireOwner(tx, identity, share.spaceId);
    requirePermissionVersion(
      await rootPermissionVersion(tx, share.spaceId, share.rootId),
      input.permissionVersion,
    );
    const { member } = input;
    await requireMembers(tx, share.spaceId, [member]);
    const [existing] = await tx
      .select()
      .from(shareMembers)
      .where(
        and(eq(shareMembers.shareId, share.id), eq(shareMembers.identityId, member.identityId)),
      );
    const viaGroups = (await groupAccess(tx, [share.id])).get(share.id)?.get(member.identityId);
    const access = highest([viaGroups ?? null, member]) ?? member;
    if (existing && keysExceed(existing.role, access)) {
      throw new ContentError('forbidden', 'Making an editor a reader rotates the keys');
    }
    const [live] = await lookupIdentities(tx, [member.identityId]);
    if (!live) throw new ContentError('recipients-mismatch', 'Members must be people');
    const lacks = !(existing?.keyVersion === member.keyVersion && keysCover(existing.role, access));
    await giveKeys(tx, {
      share,
      sealer: identity,
      envelopes: input.envelopes,
      recipients: new Map([[member.identityId, { identity: live, access }]]),
      must: lacks ? [member.identityId] : [],
      addedBy: input.accountId,
    });
    // An app from before groups shares again after a key change with
    // someone there only through groups by repeating their row: that
    // grants nothing directly.
    const repeated =
      existing?.directRole === null &&
      existing.keyVersion !== member.keyVersion &&
      existing.role === member.role &&
      existing.canPublish === member.canPublish;
    if (!repeated) {
      await tx
        .update(shareMembers)
        .set({ directRole: member.role, directCanPublish: member.canPublish })
        .where(
          and(eq(shareMembers.shareId, share.id), eq(shareMembers.identityId, member.identityId)),
        );
    }
    await recomputeMembers(tx, [share.id]);
    // Lower publish rights end the person's public links and copies here.
    await endLapsedWhere(tx, { spaceId: share.spaceId, under: share.rootId }, input.accountId);
    await bumpPermissions(tx, share.spaceId, await nodesUnder(tx, share.spaceId, share.rootId));
    await audit(tx, {
      actor: input.accountId,
      action: 'share.member-added',
      target: { kind: 'share', id: share.id },
      details: { identityId: member.identityId, role: member.role, canPublish: member.canPublish },
    });
  });
}

/**
 * Apply one rotation of a held share (section 7.5, step 4): the current
 * version is still `expectedKeyVersion` (`stale-head` otherwise, naming it),
 * and the new version goes to exactly the listed members less `removed`,
 * at their listed keys, and every owner in `owners` at their live key, with
 * the draft key exactly for those who stay editors after `demoted`. No
 * agent is among them: only an agent's own person seals to it (section
 * 9.4). Then the removed go, with their agents' grants in the share, the
 * demoted become readers, direct grant included, and the share moves to
 * its next version. Someone removed or demoted who keeps more through a
 * group waits for an owner to seal to them (section 7.9).
 */
export async function applyRotation(
  tx: Database,
  {
    share,
    rotation,
    sealer,
    owners,
  }: {
    share: ShareRow;
    rotation: Rotation;
    sealer: PublicIdentity;
    owners: readonly PublicIdentity[];
  },
): Promise<number> {
  if (share.currentKeyVersion !== rotation.expectedKeyVersion) {
    throw new ContentError('stale-head', 'The share has another key version', {
      keyVersion: share.currentKeyVersion,
      shareId: share.id,
    });
  }
  const members = await tx.select().from(shareMembers).where(eq(shareMembers.shareId, share.id));
  const listed = new Map(members.map((m) => [m.identityId, m]));
  const removed = new Set<string>(rotation.removed);
  const demoted = new Set<string>(rotation.demoted);
  const strays = [...removed, ...demoted].some((id) => !listed.has(id));
  if (strays || [...demoted].some((id) => removed.has(id))) {
    throw new ContentError('stale-head', 'The members changed since you loaded them', {
      shareId: share.id,
    });
  }
  const keyVersion = share.currentKeyVersion + 1;
  const staying = members.filter((m) => !removed.has(m.identityId));
  await checkFolderEnvelopes(tx, rotation.envelopes, {
    spaceId: share.spaceId,
    shareId: share.id,
    sealer,
    expected: [
      ...ownersExpected(owners, keyVersion),
      ...staying.map((m) => ({
        recipientId: m.identityId,
        recipientKeyVersion: m.keyVersion,
        keyVersion,
        drafts: m.role === 'editor' && !demoted.has(m.identityId),
      })),
    ],
  });
  if (removed.size > 0) {
    await tx
      .delete(shareMembers)
      .where(
        and(eq(shareMembers.shareId, share.id), inArray(shareMembers.identityId, [...removed])),
      );
    await endAgentGrants(tx, { personIds: [...removed], shareIds: [share.id] });
  }
  if (demoted.size > 0) {
    // A direct grant comes down to reader with the keys.
    await tx
      .update(shareMembers)
      .set({
        role: 'reader',
        canPublish: false,
        directRole: sql`case when ${shareMembers.directRole} is null then null else 'reader' end`,
        directCanPublish: sql`case when ${shareMembers.directRole} is null then null else false end`,
      })
      .where(
        and(eq(shareMembers.shareId, share.id), inArray(shareMembers.identityId, [...demoted])),
      );
  }
  await tx.update(shares).set({ currentKeyVersion: keyVersion }).where(eq(shares.id, share.id));
  await storeFolderEnvelopes(tx, rotation.envelopes);
  await bumpPermissions(tx, share.spaceId, await nodesUnder(tx, share.spaceId, share.rootId));
  return keyVersion;
}

/** Rotate a share's keys, removing or demoting members on the way (sections 7.4 and 7.5). */
export async function rotateShare(
  db: Database,
  input: { accountId: string; shareId: string; permissionVersion: number } & Rotation,
): Promise<number> {
  return db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const share = await lockShareForChange(tx, input.shareId);
    await requireOwner(tx, identity, share.spaceId);
    requirePermissionVersion(
      await rootPermissionVersion(tx, share.spaceId, share.rootId),
      input.permissionVersion,
    );
    const keyVersion = await applyRotation(tx, {
      share,
      rotation: input,
      sealer: identity,
      owners: await currentOwners(tx, share.spaceId),
    });
    // Those removed or demoted lose their public links and copies here.
    await endLapsedWhere(tx, { spaceId: share.spaceId, under: share.rootId }, input.accountId);
    await audit(tx, {
      actor: input.accountId,
      action: 'share.rotated',
      target: { kind: 'share', id: share.id },
      details: { keyVersion, removed: input.removed, demoted: input.demoted },
    });
    return keyVersion;
  });
}

/** A space's shares and their members, for its owners (section 7.5, step 1). */
export async function listShares(db: Database, accountId: string, spaceId: string) {
  const identity = await requireIdentity(db, accountId);
  await requireOwner(db, identity, spaceId);
  const rows = await db.select().from(shares).where(eq(shares.spaceId, spaceId)).orderBy(shares.id);
  const members =
    rows.length === 0
      ? []
      : await db
          .select()
          .from(shareMembers)
          .where(
            inArray(
              shareMembers.shareId,
              rows.map((row) => row.id),
            ),
          )
          .orderBy(shareMembers.identityId);
  const shareIds = rows.map((row) => row.id);
  const agent = {
    agentId: agentProfiles.agentId,
    personId: agentProfiles.ownerIdentityId,
    name: agentProfiles.name,
  };
  const picks =
    rows.length === 0
      ? []
      : await db
          .select({
            ...agent,
            shareId: agentGrants.shareId,
            folderId: agentGrants.folderId,
            role: agentGrants.role,
            canPublish: agentGrants.canPublish,
          })
          .from(agentGrants)
          .innerJoin(agentProfiles, eq(agentProfiles.agentId, agentGrants.agentId))
          .where(inArray(agentGrants.shareId, shareIds))
          .orderBy(agentGrants.agentId);
  // Agents holding a share's current keys with no pick there any more.
  const former =
    rows.length === 0
      ? []
      : await db
          .selectDistinct({ ...agent, shareId: folderKeyEnvelopes.shareId })
          .from(folderKeyEnvelopes)
          .innerJoin(shares, eq(shares.id, folderKeyEnvelopes.shareId))
          .innerJoin(
            agentProfiles,
            eq(agentProfiles.agentId, folderKeyEnvelopes.recipientIdentityId),
          )
          .leftJoin(
            agentGrants,
            and(
              eq(agentGrants.agentId, folderKeyEnvelopes.recipientIdentityId),
              eq(agentGrants.shareId, folderKeyEnvelopes.shareId),
            ),
          )
          .where(
            and(
              inArray(folderKeyEnvelopes.shareId, shareIds),
              eq(folderKeyEnvelopes.keyVersion, shares.currentKeyVersion),
              isNull(agentGrants.agentId),
            ),
          )
          .orderBy(agentProfiles.agentId);
  // Agents a group gives the share to hold its keys rightly (section 9.4).
  const viaGroups = new Set(
    (
      await agentGrantsOf(db, {
        shareIds: [...new Set(former.map((held) => held.shareId))],
        agentIds: [...new Set(former.map((held) => held.agentId))],
      })
    ).map((grant) => `${grant.shareId} ${grant.agentId}`),
  );
  return rows.map((row) => ({
    ...shareOf(row),
    members: members
      .filter((m) => m.shareId === row.id)
      .map((m) => ({
        identityId: m.identityId,
        keyVersion: m.keyVersion,
        role: m.role,
        canPublish: m.canPublish,
      })),
    agents: picks
      .filter((pick) => pick.shareId === row.id)
      .map(({ agentId, personId, name, folderId, role, canPublish }) => ({
        agentId,
        personId,
        name,
        folderId,
        role,
        canPublish,
      })),
    formerAgents: former
      .filter(
        (held) => held.shareId === row.id && !viaGroups.has(`${held.shareId} ${held.agentId}`),
      )
      .map(({ agentId, personId, name }) => ({ agentId, personId, name })),
  }));
}

/**
 * Envelopes of one key version of a share (section 6.4): every one, to
 * people and agents at every key, for an owner of its space; to a member,
 * or an agent with a grant there its person can still use, only their own
 * at their current key. Anyone else gets `not-found`.
 */
export async function versionEnvelopes(
  db: Database,
  actor: Actor,
  { shareId, keyVersion }: { shareId: string; keyVersion: number },
  report: ReportUnreadable,
) {
  const caller = await requireCaller(db, actor);
  const { identity } = caller;
  const share = await requireShare(db, shareId);
  const owner = caller.personId === null && (await isOwner(db, identity.id, share.spaceId));
  const of = and(
    eq(folderKeyEnvelopes.shareId, shareId),
    eq(folderKeyEnvelopes.keyVersion, keyVersion),
  );
  if (caller.personId !== null) {
    if (!(await agentShares(db, caller, share.spaceId)).some((held) => held.share.id === shareId)) {
      throw new ContentError('not-found');
    }
  } else if (!owner) {
    const [member] = await db
      .select()
      .from(shareMembers)
      .where(and(eq(shareMembers.shareId, shareId), eq(shareMembers.identityId, identity.id)));
    if (!member) throw new ContentError('not-found');
  }
  const rows = await db
    .select()
    .from(folderKeyEnvelopes)
    .where(
      owner
        ? of
        : and(
            of,
            eq(folderKeyEnvelopes.recipientIdentityId, identity.id),
            eq(folderKeyEnvelopes.recipientKeyVersion, identity.keyVersion),
          ),
    )
    .orderBy(folderKeyEnvelopes.recipientIdentityId, folderKeyEnvelopes.recipientKeyVersion);
  return readEnvelopes(rows, report);
}

function readEnvelopes(
  rows: readonly (typeof folderKeyEnvelopes.$inferSelect)[],
  report: ReportUnreadable,
) {
  return rows.flatMap((row) => {
    const stored = { table: 'folder_key_envelopes', id: `${row.shareId}@${row.keyVersion}` };
    const envelope = readStored(FolderKeyEnvelope, row.envelope, stored, report);
    return envelope ? [envelope] : [];
  });
}

/**
 * Every folder key envelope addressed to the caller in a space, at their
 * current key (section 6.4): of every share there for an owner, and of the
 * shares they are a member of for anyone else; for an agent, of the shares
 * it has a grant in that its person can still use. Someone with no place
 * in the space, a removed member included, gets `not-found`.
 */
export async function myEnvelopes(
  db: Database,
  actor: Actor,
  spaceId: string,
  report: ReportUnreadable,
) {
  const caller = await requireCaller(db, actor);
  const { identity } = caller;
  const mine = and(
    eq(folderKeyEnvelopes.spaceId, spaceId),
    eq(folderKeyEnvelopes.recipientIdentityId, identity.id),
    eq(folderKeyEnvelopes.recipientKeyVersion, identity.keyVersion),
  );
  const owner = caller.personId === null && (await isOwner(db, identity.id, spaceId));
  const memberOf =
    caller.personId === null
      ? await db
          .select({ id: shareMembers.shareId })
          .from(shareMembers)
          .innerJoin(shares, eq(shares.id, shareMembers.shareId))
          .where(and(eq(shares.spaceId, spaceId), eq(shareMembers.identityId, identity.id)))
      : (await agentShares(db, caller, spaceId)).map((held) => ({ id: held.share.id }));
  // Outsiders aren't told whether the space exists.
  if (!owner && memberOf.length === 0) throw new ContentError('not-found');
  const held = owner
    ? mine
    : and(
        mine,
        inArray(
          folderKeyEnvelopes.shareId,
          memberOf.map((m) => m.id),
        ),
      );
  const rows = await db
    .select()
    .from(folderKeyEnvelopes)
    .where(held)
    .orderBy(folderKeyEnvelopes.shareId, folderKeyEnvelopes.keyVersion);
  return readEnvelopes(rows, report);
}

/**
 * The shares an agent was granted, in one space or all, that its person
 * can still use, with its access there (section 9.5) and its pick.
 */
async function agentShares(db: Database, caller: Caller, spaceId?: string) {
  const grants = await agentGrantsOf(db, {
    agentIds: [caller.identity.id],
    ...(spaceId === undefined ? {} : { spaceId }),
  });
  const rows =
    grants.length === 0
      ? []
      : await db
          .select()
          .from(shares)
          .where(
            inArray(
              shares.id,
              grants.map((grant) => grant.shareId),
            ),
          )
          .orderBy(shares.id);
  const held = [];
  for (const share of rows) {
    const rootId = agentStart(
      share,
      grants.filter((grant) => grant.shareId === share.id),
    );
    const access = await accessTo(db, caller, { spaceId: share.spaceId, nodeId: rootId });
    if (access) held.push({ share, access, rootId });
  }
  return held;
}

/**
 * Shared with me (section 7.7): every share in which the caller is a member
 * and not an owner, with the share root's current name, wrapped in the
 * share: the space's own name for a space share. Never a name above it.
 * For an agent, every share it has a grant in that its person can still
 * use, named by the folder it was granted, or the share root.
 */
export async function sharedWithMe(db: Database, actor: Actor, report: ReportUnreadable) {
  const caller = await requireCaller(db, actor);
  const { identity } = caller;
  const held =
    caller.personId === null
      ? await memberShares(db, identity.id)
      : (await agentShares(db, caller)).map(({ share, access, rootId }) => ({
          share,
          role: access.role === 'reader' ? ('reader' as const) : ('editor' as const),
          canPublish: access.canPublish,
          rootId,
        }));
  const spaceIds = [...new Set(held.map((row) => row.share.spaceId))];
  const spaceHeads = new Map(
    spaceIds.length === 0
      ? []
      : (
          await db
            .select({ id: spaces.id, head: spaces.metadataHead })
            .from(spaces)
            .where(inArray(spaces.id, spaceIds))
        ).map((space) => [space.id, space.head]),
  );
  const rootIds = held.flatMap((row) => (row.rootId === null ? [] : [row.rootId]));
  const rootHeads = new Map(
    rootIds.length === 0
      ? []
      : (
          await db
            .select({ id: nodes.id, spaceId: nodes.spaceId, head: nodes.metadataHead })
            .from(nodes)
            .where(inArray(nodes.id, rootIds))
        ).map((node) => [`${node.spaceId} ${node.id}`, node.head]),
  );
  const named = held.flatMap((row) => {
    const head =
      row.rootId === null
        ? spaceHeads.get(row.share.spaceId)
        : rootHeads.get(`${row.share.spaceId} ${row.rootId}`);
    return head ? [{ ...row, head }] : [];
  });
  const names = await servedMetadata(
    db,
    identity,
    named.map((row) => row.head),
    report,
  );
  return named.flatMap(({ share, role, canPublish, head }) => {
    const root = names.get(head);
    // A root name served without the share's wrap would be in the owner region.
    if (!root?.wrap || root.wrap.shareId !== share.id) return [];
    return [{ share: shareOf(share), role, canPublish, root }];
  });
}

// The shares a person is a member of and not an owner, with their role.
async function memberShares(db: Database, identityId: string) {
  const rows = await db
    .select({ share: shares, member: shareMembers })
    .from(shareMembers)
    .innerJoin(shares, eq(shares.id, shareMembers.shareId))
    .where(eq(shareMembers.identityId, identityId))
    .orderBy(shares.id);
  const spaceIds = [...new Set(rows.map((row) => row.share.spaceId))];
  // The spaces the person owns, whose shares aren't listed.
  const owned = new Set(
    spaceIds.length === 0
      ? []
      : (
          await db
            .select({ spaceId: spaceOwners.spaceId })
            .from(spaceOwners)
            .where(
              and(
                eq(spaceOwners.identityId, identityId),
                isNull(spaceOwners.removedAt),
                inArray(spaceOwners.spaceId, spaceIds),
              ),
            )
        ).map((row) => row.spaceId),
  );
  return rows.flatMap(({ share, member }) =>
    owned.has(share.spaceId)
      ? []
      : [{ share, role: member.role, canPublish: member.canPublish, rootId: share.rootId }],
  );
}

/** How many records a scan sends at most, and how many bytes of Milestone 1 payloads. */
const SCAN_BATCH = 500;
const SCAN_BYTES = 2 * 1024 * 1024;

/**
 * Every retained record in a scope, with the caller's key material for it,
 * for an owner about to make a share over a subtree (`rootId`, or the whole
 * space) or to add a co-owner (the owner region). In parts, ordered by kind
 * and ID; the next part starts after `next`, whether or not that record
 * still exists. A v2 record comes without its payload: its key commitment
 * is enough to check a key against it.
 */
export async function scanRecords(
  db: Database,
  accountId: string,
  input: {
    spaceId: string;
    scope: 'subtree' | 'owner-region';
    rootId: string | null;
    after: string | null;
  },
  report: ReportUnreadable,
) {
  const identity = await requireIdentity(db, accountId);
  await requireOwner(db, identity, input.spaceId);
  let ids: Awaited<ReturnType<typeof recordsUnder>>;
  if (input.scope === 'subtree') {
    ids = await recordsUnder(db, input.spaceId, input.rootId);
    if (input.rootId !== null && ids.nodeIds.length === 0) throw new ContentError('not-found');
  } else {
    const pageVersions = await db
      .select({ id: revisions.id })
      .from(revisions)
      .leftJoin(revisionWraps, eq(revisionWraps.revisionId, revisions.id))
      .where(and(eq(revisions.spaceId, input.spaceId), isNull(revisionWraps.revisionId)));
    const names = await db
      .select({ id: metadataRevisions.id })
      .from(metadataRevisions)
      .leftJoin(metadataWraps, eq(metadataWraps.metadataRevisionId, metadataRevisions.id))
      .where(
        and(eq(metadataRevisions.spaceId, input.spaceId), isNull(metadataWraps.metadataRevisionId)),
      );
    ids = {
      nodeIds: [],
      revision: pageVersions.map((r) => r.id),
      metadata: names.map((r) => r.id),
    };
  }
  const ordered = [
    ...ids.metadata.sort().map((id) => ({ kind: 'metadata' as const, id })),
    ...ids.revision.sort().map((id) => ({ kind: 'revision' as const, id })),
  ];
  // The next part starts after `after` in this order, even if that record
  // was deleted since: `metadata:` sorts before `revision:`, and IDs in the
  // order JavaScript compares strings.
  const after = input.after;
  const found = after === null ? 0 : ordered.findIndex((r) => `${r.kind}:${r.id}` > after);
  const start = found === -1 ? ordered.length : found;
  const candidates = ordered.slice(start, start + SCAN_BATCH);

  // Milestone 1 records come whole: their payload is how an owner checks a key against them.
  const sealedOf = (table: 'revisions' | 'metadata_revisions', wanted: readonly string[]) =>
    wanted.length === 0
      ? Promise.resolve([])
      : db.execute<{ id: string; sealed: unknown; size: number }>(sql`
          select id,
            case when sealed -> 'record' ->> 'protocol' = '2' then sealed - 'payload' else sealed end as sealed,
            case when sealed -> 'record' ->> 'protocol' = '2' then 0
                 else length(sealed -> 'payload' ->> 'ciphertext') end as size
          from ${sql.identifier(table)} where id = any(${sql`array[${sql.join(
            wanted.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[]`})`);
  const pageRows = new Map(
    [
      ...(await sealedOf(
        'revisions',
        candidates.filter((c) => c.kind === 'revision').map((c) => c.id),
      )),
    ].map((row) => [row.id, row]),
  );
  const nameRows = new Map(
    [
      ...(await sealedOf(
        'metadata_revisions',
        candidates.filter((c) => c.kind === 'metadata').map((c) => c.id),
      )),
    ].map((row) => [row.id, row]),
  );
  const sent: typeof candidates = [];
  let bytes = 0;
  for (const candidate of candidates) {
    const row = (candidate.kind === 'revision' ? pageRows : nameRows).get(candidate.id);
    const size = Number(row?.size ?? 0);
    if (sent.length > 0 && bytes + size > SCAN_BYTES) break;
    bytes += size;
    sent.push(candidate);
  }
  const pageKeys = await revisionKeyMaterial(
    db,
    identity,
    sent.filter((c) => c.kind === 'revision').map((c) => c.id),
    report,
  );
  const names = await servedMetadata(
    db,
    identity,
    sent.filter((c) => c.kind === 'metadata').map((c) => c.id),
    report,
  );
  const Scanned = sharingRoutes.records.response.shape.records.element;
  const out = sent.flatMap((candidate) => {
    const stored = {
      table: candidate.kind === 'revision' ? 'revisions' : 'metadata_revisions',
      id: candidate.id,
    };
    if (candidate.kind === 'revision') {
      const keys = pageKeys.get(candidate.id);
      const row = pageRows.get(candidate.id);
      if (!keys || !row) return [];
      const item = readStored(
        Scanned,
        { kind: 'revision', revision: row.sealed, ...keys },
        stored,
        report,
      );
      return item ? [item] : [];
    }
    const served = names.get(candidate.id);
    const row = nameRows.get(candidate.id);
    if (!served || !row) return [];
    const item = readStored(
      Scanned,
      { kind: 'metadata', metadata: row.sealed, wrap: served.wrap, envelopes: served.envelopes },
      stored,
      report,
    );
    return item ? [item] : [];
  });
  const last = sent.at(-1);
  const more = start + sent.length < ordered.length;
  return {
    records: out,
    next: more && last ? `${last.kind}:${last.id}` : null,
    total: ordered.length,
  };
}

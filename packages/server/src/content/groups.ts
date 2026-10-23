// Groups of people in a space, which shares go to as one (protocol sections
// 7.8 and 7.9). Only the space's owners make, rename, fill and delete them.
// A group holds no keys: each change seals to people, or rotates, exactly as
// sharing with or removing them one by one would, in one request under the
// lock on the space, and recomputes the member rows it touches.
import type { FolderKeyEnvelope, PublicIdentity, sharingRoutes } from '@wikistow/contracts';
import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../admin/audit.ts';
import type { Database } from '../db/client.ts';
import {
  agentProfiles,
  groupMembers,
  groups,
  identities,
  keyEnvelopes,
  metadataRevisions,
  shareGroups,
  shareMembers,
  shares,
  spaceOwners,
  spaces,
} from '../db/schema/index.ts';
import { endLapsedWhere } from '../public-links/links.ts';
import { agentGrantsOf, currentOwners, isOwner, type ShareRow } from './access.ts';
import {
  effectiveAccess,
  keysCover,
  recomputeMembers,
  requireRotationsCover,
  type Grant,
} from './effective.ts';
import { ContentError } from './errors.ts';
import { lookupIdentities } from './identities.ts';
import { peopleById } from './people.ts';
import { servedMetadata } from './serving.ts';
import {
  applyRotation,
  bumpPermissions,
  giveKeys,
  lackingKeys,
  lockSpaceForUpdate,
  nodesUnder,
  requireOwner,
  requirePermissionVersion,
  requireShare,
  rootPermissionVersion,
} from './sharing.ts';
import type { ReportUnreadable } from './stored.ts';
import {
  requireIdentity,
  storeMetadata,
  verifyMetadataCommit,
  type MetadataCommit,
} from './structure.ts';

type Rotation = z.output<typeof sharingRoutes.Rotation>;
type ShareRotation = Rotation & { shareId: string };
type Name = Omit<MetadataCommit, 'wrap'>;
type Person = Awaited<ReturnType<typeof peopleById>>[number];

/**
 * For a group action with a large body, before the body is read: the
 * caller owns the group's space, as `checkSpaceOwner` checks. The action
 * checks again under its lock.
 */
export async function checkGroupOwner(db: Database, accountId: string, groupId: string) {
  const identity = await requireIdentity(db, accountId);
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!group) throw new ContentError('not-found');
  await requireOwner(db, identity, group.spaceId);
}

/**
 * The space's groups, each with its name, members and shares, and every
 * direct grant in the space's shares, for its owners.
 */
export async function listGroups(
  db: Database,
  accountId: string,
  spaceId: string,
  report: ReportUnreadable,
) {
  const identity = await requireIdentity(db, accountId);
  await requireOwner(db, identity, spaceId);
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId));
  if (!space) throw new ContentError('not-found');
  const rows = await db.select().from(groups).where(eq(groups.spaceId, spaceId)).orderBy(groups.id);
  const ids = rows.map((row) => row.id);
  const names = await servedMetadata(
    db,
    identity,
    rows.map((row) => row.metadataHead),
    report,
  );
  const members =
    ids.length === 0
      ? []
      : await db
          .select({
            groupId: groupMembers.groupId,
            identityId: groupMembers.identityId,
            agentDrafts: groupMembers.agentDrafts,
          })
          .from(groupMembers)
          .where(inArray(groupMembers.groupId, ids))
          .orderBy(groupMembers.identityId);
  const people = new Map<string, Person>(
    (await peopleById(db, [...new Set(members.map((m) => m.identityId))])).map((p) => [
      p.identity.id,
      p,
    ]),
  );
  const agents = await agentsFor(db, spaceId, members);
  const live = new Set(agents.map((agent) => agent.agentId));
  const held =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(shareGroups)
          .where(inArray(shareGroups.groupId, ids))
          .orderBy(shareGroups.shareId);
  return {
    groups: rows.map((row) => ({
      groupId: row.id,
      name: names.get(row.metadataHead) ?? null,
      members: members.flatMap((m) => {
        const person = m.groupId === row.id ? people.get(m.identityId) : undefined;
        return person ? [person] : [];
      }),
      agents: members.flatMap((m) =>
        m.groupId === row.id && live.has(m.identityId)
          ? [{ agentId: m.identityId, confirmed: m.agentDrafts !== null }]
          : [],
      ),
      shares: held
        .filter((g) => g.groupId === row.id)
        .map(({ shareId, role, canPublish }) => ({ shareId, role, canPublish })),
    })),
    direct: (
      await db
        .select()
        .from(shareMembers)
        .innerJoin(shares, eq(shares.id, shareMembers.shareId))
        .where(and(eq(shares.spaceId, spaceId), isNotNull(shareMembers.directRole)))
        .orderBy(shareMembers.shareId, shareMembers.identityId)
    ).flatMap(({ share_members: m }) =>
      m.directRole === null
        ? []
        : [
            {
              shareId: m.shareId,
              identityId: m.identityId,
              role: m.directRole,
              canPublish: m.directCanPublish === true,
            },
          ],
    ),
    agents,
    permissionVersion: space.permissionVersion,
  };
}

/**
 * The live agents an owner may see in a space's groups, or add to one
 * (section 7.8): those in its groups, and those of its owners and of the
 * people in its groups, each with its person and the name the server has.
 */
async function agentsFor(
  db: Database,
  spaceId: string,
  members: readonly { identityId: string }[],
) {
  const owners = db
    .select({ id: spaceOwners.identityId })
    .from(spaceOwners)
    .where(and(eq(spaceOwners.spaceId, spaceId), isNull(spaceOwners.removedAt)));
  const ids = [...new Set(members.map((m) => m.identityId))];
  return db
    .select({
      agentId: agentProfiles.agentId,
      personId: agentProfiles.ownerIdentityId,
      name: agentProfiles.name,
    })
    .from(agentProfiles)
    .innerJoin(
      identities,
      and(eq(identities.id, agentProfiles.agentId), eq(identities.keyVersion, 1)),
    )
    .where(
      and(
        isNull(identities.revokedAt),
        or(
          inArray(agentProfiles.ownerIdentityId, owners),
          ids.length === 0 ? undefined : inArray(agentProfiles.ownerIdentityId, ids),
          ids.length === 0 ? undefined : inArray(agentProfiles.agentId, ids),
        ),
      ),
    )
    .orderBy(agentProfiles.agentId);
}

/**
 * Make a group with no members or shares. Its name is an owner-region
 * metadata record, sealed to every current owner (section 6.6).
 */
export async function createGroup(
  db: Database,
  input: { accountId: string; spaceId: string; groupId: string; storageBytes: number } & Name,
) {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    await lockSpaceForUpdate(tx, input.spaceId);
    await requireOwner(tx, identity, input.spaceId);
    const commit = { ...input, wrap: null };
    await verifyMetadataCommit(tx, commit, {
      author: identity,
      spaceId: input.spaceId,
      subjectKind: 'group',
      subjectId: input.groupId,
      basedOn: null,
      share: null,
    });
    const made = await tx
      .insert(groups)
      .values({
        id: input.groupId,
        spaceId: input.spaceId,
        metadataHead: input.metadata.record.metadataRevisionId,
        createdBy: input.accountId,
      })
      .onConflictDoNothing()
      .returning({ id: groups.id });
    if (made.length === 0) throw new ContentError('duplicate', 'That group ID is taken');
    await storeMetadata(tx, commit, input);
    await audit(tx, {
      actor: input.accountId,
      action: 'group.created',
      target: { kind: 'group', id: input.groupId },
      details: { spaceId: input.spaceId },
    });
  });
}

/**
 * A group by ID, for an owner of its space, with the space held against
 * every write and every other sharing change until the transaction ends.
 */
async function lockGroup(tx: Database, identity: PublicIdentity, groupId: string) {
  const [found] = await tx.select().from(groups).where(eq(groups.id, groupId));
  if (!found) throw new ContentError('not-found');
  const space = await lockSpaceForUpdate(tx, found.spaceId);
  await requireOwner(tx, identity, found.spaceId);
  const [group] = await tx.select().from(groups).where(eq(groups.id, groupId));
  if (!group) throw new ContentError('not-found');
  return { group, space };
}

/** Rename a group: a new version of its name, based on its current one. */
export async function renameGroup(
  db: Database,
  input: { accountId: string; groupId: string; storageBytes: number } & Name,
) {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const { group } = await lockGroup(tx, identity, input.groupId);
    const commit = { ...input, wrap: null };
    await verifyMetadataCommit(tx, commit, {
      author: identity,
      spaceId: group.spaceId,
      subjectKind: 'group',
      subjectId: group.id,
      basedOn: group.metadataHead,
      share: null,
    });
    await storeMetadata(tx, commit, input);
    await tx
      .update(groups)
      .set({ metadataHead: input.metadata.record.metadataRevisionId })
      .where(eq(groups.id, group.id));
  });
}

/** The space's shares, held for update, as a rotation needs them. */
const lockShares = (tx: Database, spaceId: string) =>
  tx.select().from(shares).where(eq(shares.spaceId, spaceId)).for('update');

/**
 * Finish a change to who has access in `changed` shares of a space: check
 * the rotations cover exactly the shares where someone's keys now exceed
 * their access (section 7.9), apply them, recompute the member rows, and
 * move permission versions on. Each rotation records `share.rotated`,
 * naming the group whose change made it.
 */
async function settle(
  tx: Database,
  {
    spaceId,
    changed,
    rotations,
    sealer,
    accountId,
    groupId,
    reach,
    onlyGives = false,
  }: {
    spaceId: string;
    changed: readonly ShareRow[];
    rotations: readonly ShareRotation[];
    sealer: PublicIdentity;
    accountId: string;
    groupId?: string;
    /** Which agents reached which of `changed` before the change (`agentReach`). */
    reach?: ReadonlySet<string>;
    /** The change only gives access, so no one's publish rights went down. */
    onlyGives?: boolean;
  },
) {
  const shareIds = changed.map((share) => share.id);
  // A confirmed agent leaving rotates the shares it no longer reaches, as a person would.
  const now = reach ? await agentReach(tx, shareIds) : new Set<string>();
  const lost = new Set(
    [...(reach ?? [])].filter((key) => !now.has(key)).map((key) => key.split(' ')[0] ?? ''),
  );
  await requireRotationsCover(tx, shareIds, rotations, lost);
  const owners = await currentOwners(tx, spaceId);
  for (const rotation of rotations) {
    const share = changed.find((s) => s.id === rotation.shareId);
    if (!share) throw new ContentError('stale-head', 'A rotation is for another share');
    const keyVersion = await applyRotation(tx, { share, rotation, sealer, owners });
    await audit(tx, {
      actor: accountId,
      action: 'share.rotated',
      target: { kind: 'share', id: share.id },
      details: {
        keyVersion,
        removed: rotation.removed,
        demoted: rotation.demoted,
        ...(groupId ? { groupId } : {}),
      },
    });
  }
  await recomputeMembers(tx, shareIds);
  // Under the space's lock: public links and copies of people who lost
  // publish rights end here (ADR 0005, decision 8).
  if (!onlyGives) await endLapsedWhere(tx, { spaceId, under: null }, accountId);
  const nodeIds = [];
  for (const share of changed) nodeIds.push(...(await nodesUnder(tx, spaceId, share.rootId)));
  await bumpPermissions(tx, spaceId, nodeIds);
}

/**
 * Which agents reach which of `shareIds`, by a pick or a confirmed group,
 * as `shareId agentId` keys: taken before a change that can take an agent
 * out of a group, so `settle` can tell which shares it stops reaching.
 */
async function agentReach(tx: Database, shareIds: readonly string[]) {
  return new Set(
    (await agentGrantsOf(tx, { shareIds })).map((grant) => `${grant.shareId} ${grant.agentId}`),
  );
}

/** The shares a group has, held for update. */
async function sharesOf(tx: Database, spaceId: string, groupId: string) {
  const held = new Set(
    (
      await tx
        .select({ shareId: shareGroups.shareId })
        .from(shareGroups)
        .where(eq(shareGroups.groupId, groupId))
    ).map((row) => row.shareId),
  );
  return (await lockShares(tx, spaceId)).filter((share) => held.has(share.id));
}

/**
 * Delete a group: take it out of every share it has, rotating exactly the
 * shares where a member's keys exceed what they keep without it, then
 * delete the group and its name. A group with no shares goes without one.
 */
export async function deleteGroup(
  db: Database,
  input: {
    accountId: string;
    groupId: string;
    rotations: readonly ShareRotation[];
    permissionVersion: number;
  },
) {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const { group, space } = await lockGroup(tx, identity, input.groupId);
    requirePermissionVersion(space.permissionVersion, input.permissionVersion);
    const changed = await sharesOf(tx, group.spaceId, group.id);
    const reach = await agentReach(
      tx,
      changed.map((share) => share.id),
    );
    await tx.delete(groups).where(eq(groups.id, group.id));
    await settle(tx, {
      spaceId: group.spaceId,
      changed,
      rotations: input.rotations,
      sealer: identity,
      accountId: input.accountId,
      groupId: group.id,
      reach,
    });
    // Its name versions point at it by ID, not by foreign key.
    const names = tx
      .select({ id: metadataRevisions.id })
      .from(metadataRevisions)
      .where(
        and(eq(metadataRevisions.subjectKind, 'group'), eq(metadataRevisions.subjectId, group.id)),
      );
    await tx
      .delete(keyEnvelopes)
      .where(and(eq(keyEnvelopes.subjectKind, 'metadata'), inArray(keyEnvelopes.subjectId, names)));
    await tx
      .delete(metadataRevisions)
      .where(
        and(eq(metadataRevisions.subjectKind, 'group'), eq(metadataRevisions.subjectId, group.id)),
      );
    await audit(tx, {
      actor: input.accountId,
      action: 'group.deleted',
      target: { kind: 'group', id: group.id },
      details: { spaceId: group.spaceId, shares: changed.length },
    });
  });
}

/**
 * A person someone is giving keys to or putting in a group: a person at
 * their live key, not an owner of the space (owners hold every key).
 */
async function requirePerson(
  tx: Database,
  spaceId: string,
  identityId: string,
  keyVersion: number,
) {
  const [person] = await lookupIdentities(tx, [identityId]);
  if (!person || person.kind !== 'human' || person.keyVersion !== keyVersion) {
    throw new ContentError('recipients-mismatch', 'Members must be people, at their current key');
  }
  if (await isOwner(tx, identityId, spaceId)) {
    throw new ContentError('recipients-mismatch', 'Owners hold every key already');
  }
  return person;
}

/**
 * Give `person` the keys their access needs in each share of `changed`
 * that `envelopes` name: every version, by role, at their live key. With
 * `all`, every share where they lack keys must be among them; otherwise
 * the shares left out wait. Returns the shares given, with the access.
 */
async function giveKeysIn(
  tx: Database,
  {
    changed,
    person,
    envelopes,
    sealer,
    accountId,
    all,
  }: {
    changed: readonly ShareRow[];
    person: PublicIdentity;
    envelopes: readonly FolderKeyEnvelope[];
    sealer: PublicIdentity;
    accountId: string;
    all: boolean;
  },
) {
  const byShare = new Map(changed.map((share) => [share.id, share]));
  if (!envelopes.every((e) => byShare.has(e.shareId))) {
    throw new ContentError('binding-mismatch', 'An envelope is for another share');
  }
  const access = await effectiveAccess(
    tx,
    changed.map((share) => share.id),
  );
  const given: { share: ShareRow; access: Grant }[] = [];
  for (const share of changed) {
    const grant = access.get(share.id)?.get(person.id);
    const recipients = grant
      ? await lackingKeys(tx, share, new Map([[person.id, grant]]))
      : new Map();
    const people = await giveKeys(tx, {
      share,
      sealer,
      envelopes: envelopes.filter((e) => e.shareId === share.id),
      recipients,
      must: all ? [...recipients.keys()] : [],
      addedBy: accountId,
    });
    if (grant && people.length > 0) given.push({ share, access: grant });
  }
  return given;
}

/**
 * Add a person to a group (section 7.8). In the same request, `envelopes`
 * give them every version of each of the group's shares where the keys
 * they hold fall short of their new access, so they see the group's
 * folders at once.
 */
export async function addGroupMember(
  db: Database,
  input: {
    accountId: string;
    groupId: string;
    identityId: string;
    keyVersion: number;
    envelopes: readonly FolderKeyEnvelope[];
    permissionVersion: number;
  },
) {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const { group, space } = await lockGroup(tx, identity, input.groupId);
    requirePermissionVersion(space.permissionVersion, input.permissionVersion);
    const person = await requirePerson(tx, group.spaceId, input.identityId, input.keyVersion);
    const [account] = await tx
      .select({ accountId: identities.accountId })
      .from(identities)
      .where(and(eq(identities.id, person.id), eq(identities.keyVersion, person.keyVersion)));
    if (!account) throw new ContentError('recipients-mismatch', 'Members must be people');
    const added = await tx
      .insert(groupMembers)
      .values({
        groupId: group.id,
        identityId: person.id,
        accountId: account.accountId,
        addedBy: input.accountId,
      })
      .onConflictDoNothing()
      .returning({ id: groupMembers.identityId });
    if (added.length === 0) throw new ContentError('duplicate', 'Already in the group');
    const changed = await sharesOf(tx, group.spaceId, group.id);
    await giveKeysIn(tx, {
      changed,
      person,
      envelopes: input.envelopes,
      sealer: identity,
      accountId: input.accountId,
      all: true,
    });
    await settle(tx, {
      spaceId: group.spaceId,
      changed,
      rotations: [],
      sealer: identity,
      accountId: input.accountId,
      onlyGives: true,
    });
    await audit(tx, {
      actor: input.accountId,
      action: 'group.member-added',
      target: { kind: 'group', id: group.id },
      details: { identityId: person.id },
    });
  });
}

/**
 * Take someone out of a group (section 7.9), with a rotation of exactly
 * the group's shares where their keys exceed what they keep through a
 * direct grant or another group: leaving them out where nothing is left,
 * demoting them where they keep reading. Where only publish rights go,
 * the rows drop them; where nothing changes, nothing happens.
 */
export async function removeGroupMember(
  db: Database,
  input: {
    accountId: string;
    groupId: string;
    identityId: string;
    rotations: readonly ShareRotation[];
    permissionVersion: number;
  },
) {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const { group, space } = await lockGroup(tx, identity, input.groupId);
    requirePermissionVersion(space.permissionVersion, input.permissionVersion);
    const changed = await sharesOf(tx, group.spaceId, group.id);
    const reach = await agentReach(
      tx,
      changed.map((share) => share.id),
    );
    // A person's agents leave the group with them.
    const removed = await tx
      .delete(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, group.id),
          or(
            eq(groupMembers.identityId, input.identityId),
            inArray(groupMembers.identityId, agentsOf(tx, input.identityId)),
          ),
        ),
      )
      .returning({ id: groupMembers.identityId });
    if (!removed.some((m) => m.id === input.identityId)) {
      throw new ContentError('not-found', 'Not in the group');
    }
    await settle(tx, {
      spaceId: group.spaceId,
      changed,
      rotations: input.rotations,
      sealer: identity,
      accountId: input.accountId,
      groupId: group.id,
      reach,
    });
    for (const { id } of removed) {
      await audit(tx, {
        actor: input.accountId,
        action: 'group.member-removed',
        target: { kind: 'group', id: group.id },
        details: { identityId: id },
      });
    }
  });
}

/** The IDs of a person's agents, as a subquery. */
const agentsOf = (tx: Database, personId: string) =>
  tx
    .select({ id: agentProfiles.agentId })
    .from(agentProfiles)
    .where(eq(agentProfiles.ownerIdentityId, personId));

/**
 * Put an agent in a group for its person, who must be in the group or an
 * owner of the space (section 7.8). It gets nothing until its person
 * confirms (`confirmAgentGroup`), since only they seal to it, so nothing
 * changes access here and nothing is sealed.
 */
export async function addGroupAgent(
  db: Database,
  input: { accountId: string; groupId: string; agentId: string; permissionVersion: number },
) {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const { group, space } = await lockGroup(tx, identity, input.groupId);
    requirePermissionVersion(space.permissionVersion, input.permissionVersion);
    const [agent] = await tx
      .select({ accountId: agentProfiles.accountId, personId: agentProfiles.ownerIdentityId })
      .from(agentProfiles)
      .innerJoin(
        identities,
        and(eq(identities.id, agentProfiles.agentId), eq(identities.keyVersion, 1)),
      )
      .where(and(eq(agentProfiles.agentId, input.agentId), isNull(identities.revokedAt)));
    if (!agent) throw new ContentError('not-found', 'No such agent');
    const [withPerson] = await tx
      .select({ id: groupMembers.identityId })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.identityId, agent.personId)));
    if (!withPerson && !(await isOwner(tx, agent.personId, group.spaceId))) {
      throw new ContentError('forbidden', 'An agent joins a group only for someone in it');
    }
    const added = await tx
      .insert(groupMembers)
      .values({
        groupId: group.id,
        identityId: input.agentId,
        accountId: agent.accountId,
        addedBy: input.accountId,
      })
      .onConflictDoNothing()
      .returning({ id: groupMembers.identityId });
    if (added.length === 0) throw new ContentError('duplicate', 'Already in the group');
    await audit(tx, {
      actor: input.accountId,
      action: 'group.member-added',
      target: { kind: 'group', id: group.id },
      details: { identityId: input.agentId },
    });
  });
}

/**
 * A share and one of its space's groups, for an owner, with the space held
 * for update and the share's row with it, at the root's permission version.
 */
async function lockShareAndGroup(
  tx: Database,
  identity: PublicIdentity,
  {
    shareId,
    groupId,
    permissionVersion,
  }: { shareId: string; groupId: string; permissionVersion: number },
) {
  const { spaceId } = await requireShare(tx, shareId);
  await lockSpaceForUpdate(tx, spaceId);
  await requireOwner(tx, identity, spaceId);
  const share = await requireShare(tx, shareId, { lock: 'update' });
  requirePermissionVersion(
    await rootPermissionVersion(tx, spaceId, share.rootId),
    permissionVersion,
  );
  const [group] = await tx
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.spaceId, spaceId)));
  if (!group) throw new ContentError('not-found', 'No such group');
  return { share, group };
}

/** One rotation of `share` as a batch, or none. */
const asRotations = (share: ShareRow, rotation: Rotation | null): ShareRotation[] =>
  rotation ? [{ ...rotation, shareId: share.id }] : [];

/**
 * Share a share with a group, or change the group's access there (section
 * 7.8). Lowering it carries a rotation of the share that leaves out or
 * demotes the members whose keys now exceed their access, and nothing
 * else does. `envelopes` give members whose keys fall short of their new
 * access every version, by role; members left out of them wait.
 */
export async function setShareGroup(
  db: Database,
  input: {
    accountId: string;
    shareId: string;
    groupId: string;
    access: Grant;
    envelopes: readonly FolderKeyEnvelope[];
    rotation: Rotation | null;
    permissionVersion: number;
  },
) {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const { share, group } = await lockShareAndGroup(tx, identity, input);
    const [before] = await tx
      .select()
      .from(shareGroups)
      .where(and(eq(shareGroups.shareId, share.id), eq(shareGroups.groupId, group.id)));
    const row = { role: input.access.role, canPublish: input.access.canPublish };
    await tx
      .insert(shareGroups)
      .values({ shareId: share.id, groupId: group.id, addedBy: input.accountId, ...row })
      .onConflictDoUpdate({ target: [shareGroups.shareId, shareGroups.groupId], set: row });
    await settle(tx, {
      spaceId: share.spaceId,
      changed: [share],
      rotations: asRotations(share, input.rotation),
      sealer: identity,
      accountId: input.accountId,
      groupId: group.id,
    });
    // The group's members whose keys fall short, sealed to now or left waiting.
    const rotated = await requireShare(tx, share.id);
    const inGroup = new Set(
      (
        await tx
          .select({ identityId: groupMembers.identityId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, group.id))
      ).map((m) => m.identityId),
    );
    const everyone = (await effectiveAccess(tx, [share.id])).get(share.id) ?? new Map();
    await giveKeys(tx, {
      share: rotated,
      sealer: identity,
      envelopes: input.envelopes,
      recipients: await lackingKeys(
        tx,
        rotated,
        new Map([...everyone].filter(([id]) => inGroup.has(id))),
      ),
      addedBy: input.accountId,
    });
    await recomputeMembers(tx, [share.id]);
    await audit(tx, {
      actor: input.accountId,
      action: before ? 'share.group-changed' : 'share.group-added',
      target: { kind: 'share', id: share.id },
      details: { groupId: group.id, ...row },
    });
  });
}

/**
 * Take a group out of a share: one rotation when any member's keys exceed
 * what they keep without it, otherwise none.
 */
export async function removeShareGroup(
  db: Database,
  input: {
    accountId: string;
    shareId: string;
    groupId: string;
    rotation: Rotation | null;
    permissionVersion: number;
  },
) {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const { share, group } = await lockShareAndGroup(tx, identity, input);
    const reach = await agentReach(tx, [share.id]);
    const removed = await tx
      .delete(shareGroups)
      .where(and(eq(shareGroups.shareId, share.id), eq(shareGroups.groupId, group.id)))
      .returning({ id: shareGroups.groupId });
    if (removed.length === 0) throw new ContentError('not-found', 'The group has no such share');
    await settle(tx, {
      spaceId: share.spaceId,
      changed: [share],
      rotations: asRotations(share, input.rotation),
      sealer: identity,
      accountId: input.accountId,
      groupId: group.id,
      reach,
    });
    await audit(tx, {
      actor: input.accountId,
      action: 'share.group-removed',
      target: { kind: 'share', id: share.id },
      details: { groupId: group.id },
    });
  });
}

/**
 * Drop someone's direct grant in a share, keeping what their groups give
 * them: a rotation only when their keys exceed that.
 */
export async function removeDirectGrant(
  db: Database,
  input: {
    accountId: string;
    shareId: string;
    identityId: string;
    rotation: Rotation | null;
    permissionVersion: number;
  },
) {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const { spaceId } = await requireShare(tx, input.shareId);
    await lockSpaceForUpdate(tx, spaceId);
    await requireOwner(tx, identity, spaceId);
    const share = await requireShare(tx, input.shareId, { lock: 'update' });
    requirePermissionVersion(
      await rootPermissionVersion(tx, spaceId, share.rootId),
      input.permissionVersion,
    );
    const dropped = await tx
      .update(shareMembers)
      .set({ directRole: null, directCanPublish: null })
      .where(
        and(
          eq(shareMembers.shareId, share.id),
          eq(shareMembers.identityId, input.identityId),
          isNotNull(shareMembers.directRole),
        ),
      )
      .returning({ id: shareMembers.identityId });
    if (dropped.length === 0) throw new ContentError('not-found', 'No direct grant there');
    await settle(tx, {
      spaceId,
      changed: [share],
      rotations: asRotations(share, input.rotation),
      sealer: identity,
      accountId: input.accountId,
    });
  });
}

/**
 * "Remove from every folder in this space" (section 7.5): drop someone's
 * direct grants and group memberships in the space, rotating every share
 * where they hold keys, in one request. Owners are removed as owners.
 */
export async function removeFromSpace(
  db: Database,
  input: {
    accountId: string;
    spaceId: string;
    identityId: string;
    rotations: readonly ShareRotation[];
    permissionVersion: number;
  },
) {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const space = await lockSpaceForUpdate(tx, input.spaceId);
    await requireOwner(tx, identity, input.spaceId);
    requirePermissionVersion(space.permissionVersion, input.permissionVersion);
    if (await isOwner(tx, input.identityId, input.spaceId)) {
      throw new ContentError('forbidden', 'Remove an owner as an owner');
    }
    const changed = await lockShares(tx, input.spaceId);
    const reach = await agentReach(
      tx,
      changed.map((share) => share.id),
    );
    const spaceGroups = tx
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.spaceId, input.spaceId));
    // Their agents leave the space's groups with them.
    const left = await tx
      .delete(groupMembers)
      .where(
        and(
          or(
            eq(groupMembers.identityId, input.identityId),
            inArray(groupMembers.identityId, agentsOf(tx, input.identityId)),
          ),
          inArray(groupMembers.groupId, spaceGroups),
        ),
      )
      .returning({ groupId: groupMembers.groupId, identityId: groupMembers.identityId });
    const held =
      changed.length === 0
        ? []
        : await tx
            .update(shareMembers)
            .set({ directRole: null, directCanPublish: null })
            .where(
              and(
                eq(shareMembers.identityId, input.identityId),
                inArray(
                  shareMembers.shareId,
                  changed.map((share) => share.id),
                ),
              ),
            )
            .returning({ shareId: shareMembers.shareId });
    if (!left.some((m) => m.identityId === input.identityId) && held.length === 0) {
      throw new ContentError('not-found');
    }
    await settle(tx, {
      spaceId: input.spaceId,
      changed,
      rotations: input.rotations,
      sealer: identity,
      accountId: input.accountId,
      reach,
    });
    for (const { groupId, identityId } of left) {
      await audit(tx, {
        actor: input.accountId,
        action: 'group.member-removed',
        target: { kind: 'group', id: groupId },
        details: { identityId },
      });
    }
  });
}

/**
 * Give access to someone waiting in a space (section 7.9): for each share
 * the envelopes name, every version at their live key, by role, where the
 * keys they hold fall short of their access. Shares left out stay waiting.
 * After a key change this replaces the key version of their member rows.
 */
export async function giveAccess(
  db: Database,
  input: {
    accountId: string;
    spaceId: string;
    identityId: string;
    keyVersion: number;
    envelopes: readonly FolderKeyEnvelope[];
    permissionVersion: number;
  },
) {
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    const space = await lockSpaceForUpdate(tx, input.spaceId);
    await requireOwner(tx, identity, input.spaceId);
    requirePermissionVersion(space.permissionVersion, input.permissionVersion);
    const person = await requirePerson(tx, input.spaceId, input.identityId, input.keyVersion);
    if (input.envelopes.length === 0) {
      throw new ContentError('recipients-mismatch', 'Nothing to give');
    }
    const named = new Set<string>(input.envelopes.map((e) => e.shareId));
    const changed = (await lockShares(tx, input.spaceId)).filter((share) => named.has(share.id));
    if (changed.length !== named.size) {
      throw new ContentError('binding-mismatch', 'An envelope is for another share');
    }
    const given = await giveKeysIn(tx, {
      changed,
      person,
      envelopes: input.envelopes,
      sealer: identity,
      accountId: input.accountId,
      all: false,
    });
    await settle(tx, {
      spaceId: input.spaceId,
      changed,
      rotations: [],
      sealer: identity,
      accountId: input.accountId,
      onlyGives: true,
    });
    for (const { share, access } of given) {
      await audit(tx, {
        actor: input.accountId,
        action: 'share.member-added',
        target: { kind: 'share', id: share.id },
        details: { identityId: person.id, ...access },
      });
    }
  });
}

/**
 * Everyone waiting for keys in the spaces the caller owns (section 7.9):
 * each share where someone's access is more than the keys they hold at
 * their live key, with what they hold there now.
 */
export async function listWaiting(db: Database, accountId: string) {
  const identity = await requireIdentity(db, accountId);
  const owned = db
    .select({ id: spaceOwners.spaceId })
    .from(spaceOwners)
    .where(and(eq(spaceOwners.identityId, identity.id), isNull(spaceOwners.removedAt)));
  const held = await db
    .select()
    .from(shares)
    .where(inArray(shares.spaceId, owned))
    .orderBy(shares.spaceId, shares.id);
  const shareIds = held.map((share) => share.id);
  const access = await effectiveAccess(db, shareIds);
  const rows =
    shareIds.length === 0
      ? []
      : await db.select().from(shareMembers).where(inArray(shareMembers.shareId, shareIds));
  const people = new Map<string, Person>(
    (await peopleById(db, [...new Set([...access.values()].flatMap((m) => [...m.keys()]))])).map(
      (p) => [p.identity.id, p],
    ),
  );
  return held.flatMap((share) =>
    [...(access.get(share.id) ?? [])].flatMap(([identityId, grant]) => {
      const person = people.get(identityId);
      if (!person) return [];
      const row = rows.find((r) => r.shareId === share.id && r.identityId === identityId);
      if (row?.keyVersion === person.identity.keyVersion && keysCover(row.role, grant)) return [];
      return [
        {
          spaceId: share.spaceId,
          shareId: share.id,
          person,
          role: grant.role,
          canPublish: grant.canPublish,
          holds: row ? { keyVersion: row.keyVersion, role: row.role } : null,
        },
      ];
    }),
  );
}

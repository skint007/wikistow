// An owner's app driving the group routes, as far as the server tests need:
// the real client operations come later. Each helper seals and rotates with
// the same client functions sharing uses.
import {
  MetadataRevisionId,
  newFolderMetadata,
  newId,
  saveContacts,
  sealMetadataV2,
  sharingOperations as sharing,
  type SpaceId,
} from '@wikistow/client';
import { GroupId, groupRoutes, structureRoutes, type ShareId } from '@wikistow/contracts';
import { find, type Person } from './sharing.ts';

type Role = 'reader' | 'editor';
type Access = { role: Role; canPublish: boolean };
const rank = (a: Access | null) =>
  a === null ? 0 : a.role === 'reader' ? 1 : a.canPublish ? 3 : 2;
const highest = (grants: (Access | null)[]) =>
  grants.reduce<Access | null>((best, g) => (rank(g) > rank(best) ? g : best), null);

/** Make a group named `name`, its name sealed to the space's owners. */
export async function makeGroup(owner: Person, spaceId: SpaceId, name: string) {
  const { ctx } = owner;
  const keys = await sharing.ownerKeys(ctx, spaceId);
  const groupId = newId(GroupId);
  const { metadata, envelopes } = sealMetadataV2({
    author: ctx.identity,
    target: {
      installationId: ctx.installationId,
      spaceId,
      subjectKind: 'group',
      subjectId: groupId,
      metadataRevisionId: newId(MetadataRevisionId),
      basedOn: null,
    },
    metadata: newFolderMetadata(name),
    recipients: keys.owners.sealingOwners(),
  });
  await owner.api.call(groupRoutes.createGroup, {
    params: { spaceId },
    body: { groupId, metadata, envelopes },
  });
  return groupId;
}

/** The space's groups and shares as the owner's app reads them. */
async function state(owner: Person, spaceId: SpaceId) {
  const listed = await owner.api.call(groupRoutes.listGroups, { params: { spaceId } });
  return { ...listed, shares: await sharing.listShares(owner.ctx, spaceId) };
}

type State = Awaited<ReturnType<typeof state>>;

/** Someone's effective access in a share, from the listings, leaving out `without`. */
function accessIn(
  { groups, shares }: State,
  shareId: ShareId,
  identityId: string,
  without?: GroupId,
) {
  const share = shares.find((s) => s.shareId === shareId);
  if (!share) throw new Error(`no share ${shareId}`);
  const direct = share.direct.find((d) => d.identityId === identityId) ?? null;
  const viaGroups = share.groups.filter(
    (g) =>
      g.groupId !== without &&
      groups
        .find((group) => group.groupId === g.groupId)
        ?.members.some((m) => m.identity.id === identityId),
  );
  return { share, access: highest([direct, ...viaGroups]) };
}

/**
 * Seal every version of `shareIds` to `person` at their access there, for
 * each share where the keys they hold fall short of it, given the space as
 * it will be once the change lands (`after`).
 */
async function sealWhereLacking(
  owner: Person,
  spaceId: SpaceId,
  person: Person,
  shareIds: readonly ShareId[],
  after: State,
) {
  const keys = await sharing.ownerKeys(owner.ctx, spaceId);
  const identity = person.vault.identity.public;
  return shareIds.flatMap((shareId) => {
    const { share, access } = accessIn(after, shareId, identity.id);
    if (!access) return [];
    const row = share.members.find((m) => m.identityId === identity.id);
    const holds =
      row?.keyVersion === identity.keyVersion &&
      (row.role === 'editor' || access.role === 'reader');
    if (holds) return [];
    return sharing
      .versionsToGive(owner.ctx, keys, share)
      .flatMap((held) =>
        sharing.sealVersion(owner.ctx, spaceId, shareId, held.keyVersion, held, [
          { identity, role: access.role },
        ]),
      );
  });
}

/** Add `person` to a group, sealing the group's shares to them where they lack keys. */
export async function addToGroup(
  owner: Person,
  spaceId: SpaceId,
  groupId: GroupId,
  person: Person,
) {
  const [identity] = owner.ctx.trust.recipients([await find(owner, person)]);
  if (!identity) throw new Error('nobody to add');
  await saveContacts(owner.ctx, [], { sealTo: [identity] });
  const before = await state(owner, spaceId);
  const group = before.groups.find((g) => g.groupId === groupId);
  if (!group) throw new Error(`no group ${groupId}`);
  // The group as it will be, with them in it.
  const after = {
    ...before,
    groups: before.groups.map((g) =>
      g.groupId === groupId
        ? { ...g, members: [...g.members, { identity, name: person.email, email: person.email }] }
        : g,
    ),
  };
  const envelopes = await sealWhereLacking(
    owner,
    spaceId,
    person,
    group.shares.map((s) => s.shareId),
    after,
  );
  await owner.api.call(groupRoutes.addGroupMember, {
    params: { groupId },
    body: {
      identityId: identity.id,
      keyVersion: identity.keyVersion,
      envelopes,
      permissionVersion: before.permissionVersion,
    },
  });
}

/**
 * Share `shareId` with a group at `access`, sealing to the members in
 * `sealTo` where they lack keys. Anyone left out waits.
 */
export async function shareWithGroup(
  owner: Person,
  {
    spaceId,
    shareId,
    groupId,
    access,
    sealTo,
  }: {
    spaceId: SpaceId;
    shareId: ShareId;
    groupId: GroupId;
    access: Access;
    sealTo: readonly Person[];
  },
) {
  const before = await state(owner, spaceId);
  const group = before.groups.find((g) => g.groupId === groupId);
  if (!group) throw new Error(`no group ${groupId}`);
  const after = {
    ...before,
    shares: before.shares.map((s) =>
      s.shareId === shareId
        ? {
            ...s,
            groups: [...s.groups.filter((g) => g.groupId !== groupId), { groupId, ...access }],
          }
        : s,
    ),
  };
  const envelopes = [];
  for (const person of sealTo) {
    envelopes.push(...(await sealWhereLacking(owner, spaceId, person, [shareId], after)));
  }
  const share = after.shares.find((s) => s.shareId === shareId);
  const { permissionVersion } = await owner.api.call(structureRoutes.target, {
    params: { spaceId },
    query: share?.rootId ? { nodeId: share.rootId } : {},
  });
  await owner.api.call(groupRoutes.setShareGroup, {
    params: { shareId, groupId },
    body: { access, envelopes, rotation: null, permissionVersion },
  });
}

/**
 * Take `person` out of a group, with a rotation of each of its shares
 * where their keys exceed what they keep: leaving them out, or demoting
 * them where they keep reading. `rotate` overrides which shares rotate,
 * for a test of the server's coverage check.
 */
export async function removeFromGroup(
  owner: Person,
  spaceId: SpaceId,
  groupId: GroupId,
  person: Person,
  { rotate }: { rotate?: readonly ShareId[] } = {},
) {
  const before = await state(owner, spaceId);
  const group = before.groups.find((g) => g.groupId === groupId);
  if (!group) throw new Error(`no group ${groupId}`);
  const id = person.vault.identity.public.id;
  const plans = [];
  for (const { shareId } of group.shares) {
    const { share, access } = accessIn(before, shareId, id, groupId);
    const row = share.members.find((m) => m.identityId === id);
    const exceeds = row && (access === null || (row.role === 'editor' && access.role === 'reader'));
    if (rotate ? !rotate.includes(shareId) : !exceeds) continue;
    const planned = await sharing.planShareRotation(owner.ctx, {
      spaceId,
      shareId,
      ...(exceeds && access === null ? { leaveOut: [id] } : exceeds ? { demote: [id] } : {}),
    });
    plans.push({ shareId, ...sharing.sealPlanned(owner.ctx, planned.plan) });
  }
  await owner.api.call(groupRoutes.removeGroupMember, {
    params: { groupId, identityId: id },
    body: { rotations: plans, permissionVersion: before.permissionVersion },
  });
  return plans.map((p) => p.shareId);
}

/** Who waits for keys in the owner's spaces, as person and share IDs. */
export async function waitingIn(owner: Person) {
  const { waiting } = await owner.api.call(groupRoutes.waiting);
  return waiting.map((w) => ({
    identityId: w.person.identity.id,
    shareId: w.shareId,
    role: w.role,
  }));
}

/** Give `person` the keys they wait for in every share of the space. */
export async function giveAccessTo(owner: Person, spaceId: SpaceId, person: Person) {
  const identity = person.vault.identity.public;
  const before = await state(owner, spaceId);
  const envelopes = await sealWhereLacking(
    owner,
    spaceId,
    person,
    before.shares.map((s) => s.shareId),
    before,
  );
  await owner.api.call(groupRoutes.giveAccess, {
    params: { spaceId, identityId: identity.id },
    body: {
      keyVersion: identity.keyVersion,
      envelopes,
      permissionVersion: before.permissionVersion,
    },
  });
}

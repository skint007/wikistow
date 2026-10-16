// An owner's app driving the group routes through the client's group
// operations, with the overrides the server tests need: sealing to only
// some members, or sending rotations the server must refuse.
import { groupOperations as groups, sharingOperations, type SpaceId } from '@wikistow/client';
import { groupRoutes, type GroupId, type ShareId } from '@wikistow/contracts';
import { find, type Person } from './sharing.ts';

type Access = groups.Access;

/** Make a group named `name`, its name sealed to the space's owners. */
export const makeGroup = (owner: Person, spaceId: SpaceId, name: string) =>
  groups.createGroup(owner.ctx, { spaceId, name });

/** Add `person` to a group, sealing the group's shares to them where they lack keys. */
export async function addToGroup(
  owner: Person,
  spaceId: SpaceId,
  groupId: GroupId,
  person: Person,
) {
  const change = await groups.planAddMember(owner.ctx, {
    spaceId,
    groupId,
    person: await find(owner, person),
  });
  await groups.applyGroupChange(owner.ctx, change);
}

/**
 * Share `shareId` with a group at `access`, sealing only to the members in
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
  const change = await groups.planShareGroup(owner.ctx, { spaceId, shareId, groupId, access });
  const ids = new Set<string>(sealTo.map((p) => p.vault.identity.public.id));
  await groups.applyGroupChange(owner.ctx, {
    ...change,
    seals: change.seals.filter((s) => ids.has(s.person.identity.id)),
  });
}

/**
 * Take `person` out of a group, rotating the shares the plan says. `rotate`
 * overrides which of its rotations are sent, for a test of the server's
 * coverage check. Returns the shares rotated.
 */
export async function removeFromGroup(
  owner: Person,
  spaceId: SpaceId,
  groupId: GroupId,
  person: Person,
  { rotate }: { rotate?: readonly ShareId[] } = {},
) {
  const change = await groups.planRemoveMember(owner.ctx, {
    spaceId,
    groupId,
    identityId: person.vault.identity.public.id,
  });
  const extra = rotate
    ? await Promise.all(
        rotate
          .filter((shareId) => !change.rotations.some((r) => r.plan.shareId === shareId))
          .map((shareId) => sharingOperations.planShareRotation(owner.ctx, { spaceId, shareId })),
      )
    : [];
  const rotations = [...change.rotations, ...extra].filter(
    (r) => !rotate || rotate.includes(r.plan.shareId),
  );
  await groups.applyGroupChange(owner.ctx, { ...change, rotations });
  return rotations.map((r) => r.plan.shareId);
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
  const change = await groups.planGiveAccess(owner.ctx, {
    spaceId,
    person: await find(owner, person),
  });
  await groups.applyGroupChange(owner.ctx, change);
}

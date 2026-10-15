import { z } from 'zod';
import { PositiveInt } from '../records/encoding.ts';
import { GroupId, HumanId, IdentityId, ShareId, SpaceId } from '../records/ids.ts';
import { MetadataEnvelopeV2, SealedMetadataV2 } from '../records/metadata.ts';
import { FolderKeyEnvelope } from '../records/share.ts';
import type { RouteDef } from '../route.ts';
import { DirectoryPerson } from './people.ts';
import { Rotation, ShareRole } from './sharing.ts';
import { ServedMetadata } from './structure.ts';

// Groups (wikistow.md, Milestone 5 Groups; protocol sections 7.8 and 7.9).
// Every route here is for the space's owners.

const SpaceParams = z.object({ spaceId: SpaceId });
const GroupParams = z.object({ groupId: GroupId });
const Envelopes = z.array(FolderKeyEnvelope).max(100_000);
const NameEnvelopes = z.array(MetadataEnvelopeV2).max(100);
const Rotations = z.array(Rotation.extend({ shareId: ShareId })).max(1000);

/** A group's access in a share. Readers never publish. */
export const GroupAccess = z
  .strictObject({ role: ShareRole, canPublish: z.boolean() })
  .refine((access) => access.role === 'editor' || !access.canPublish, {
    message: 'Readers never publish',
  });

/**
 * A space's groups, for its owners: each group's name, an owner-region
 * metadata record served with the caller's own envelopes (section 7.8), its
 * members at their current keys, and the shares it has with its access
 * there. `direct` holds every member's direct grant in the space's shares,
 * so an app can say where each person's access comes from. Both are here
 * rather than in `listShares`, whose answer older apps read strictly.
 * `permissionVersion` is the space's, which every group change names.
 */
export const listGroups = {
  method: 'GET',
  path: '/api/spaces/:spaceId/groups',
  params: SpaceParams,
  response: z.strictObject({
    groups: z.array(
      z.strictObject({
        groupId: GroupId,
        /** Null when the caller holds no envelope for it. */
        name: ServedMetadata.nullable(),
        members: z.array(DirectoryPerson),
        shares: z.array(
          z.strictObject({ shareId: ShareId, role: ShareRole, canPublish: z.boolean() }),
        ),
      }),
    ),
    direct: z.array(
      z.strictObject({
        shareId: ShareId,
        identityId: HumanId,
        role: ShareRole,
        canPublish: z.boolean(),
      }),
    ),
    permissionVersion: z.number().int(),
  }),
} as const satisfies RouteDef;

/**
 * Make a group with no members or shares. Its name is the first version of
 * a metadata record with `subjectKind: "group"`, sealed to every owner.
 */
export const createGroup = {
  method: 'POST',
  path: '/api/spaces/:spaceId/groups',
  params: SpaceParams,
  body: z.object({
    groupId: GroupId,
    metadata: SealedMetadataV2,
    envelopes: NameEnvelopes,
  }),
  response: z.strictObject({ groupId: GroupId }),
  status: 201,
} as const satisfies RouteDef;

/** Rename a group: a new version of its name, based on the current one. */
export const renameGroup = {
  method: 'POST',
  path: '/api/groups/:groupId/name',
  params: GroupParams,
  body: z.object({ metadata: SealedMetadataV2, envelopes: NameEnvelopes }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Delete a group, taking it out of every share it has. `rotations` covers
 * exactly the shares where a member's keys exceed what they keep without
 * it (section 7.9), each leaving out or demoting them.
 */
export const deleteGroup = {
  method: 'POST',
  path: '/api/groups/:groupId/delete',
  params: GroupParams,
  body: z.object({ rotations: Rotations, permissionVersion: z.number().int() }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Add a person to a group. `envelopes` give them every version of each of
 * the group's shares where the keys they hold fall short of their new
 * access, at their current key, by role (section 7.8).
 */
export const addGroupMember = {
  method: 'POST',
  path: '/api/groups/:groupId/members',
  params: GroupParams,
  body: z.object({
    identityId: HumanId,
    keyVersion: PositiveInt,
    envelopes: Envelopes,
    permissionVersion: z.number().int(),
  }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Take someone out of a group, with one rotation for each share where
 * their keys exceed what they keep through a direct grant or another
 * group, and none anywhere else (section 7.9).
 */
export const removeGroupMember = {
  method: 'POST',
  path: '/api/groups/:groupId/members/:identityId/remove',
  params: z.object({ groupId: GroupId, identityId: IdentityId }),
  body: z.object({ rotations: Rotations, permissionVersion: z.number().int() }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Share a share with a group, or change the group's access there. Raising
 * it carries `envelopes` for members whose keys fall short of their new
 * access; lowering it carries a `rotation` that leaves out or demotes the
 * members whose keys exceed it. Publish rights alone carry neither.
 */
export const setShareGroup = {
  method: 'PUT',
  path: '/api/shares/:shareId/groups/:groupId',
  params: z.object({ shareId: ShareId, groupId: GroupId }),
  body: z.object({
    access: GroupAccess,
    envelopes: Envelopes,
    rotation: Rotation.nullable(),
    /** The permission version of the share's root. */
    permissionVersion: z.number().int(),
  }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Take a group out of a share: a rotation when any member's keys exceed
 * what they keep without it, otherwise none.
 */
export const removeShareGroup = {
  method: 'POST',
  path: '/api/shares/:shareId/groups/:groupId/remove',
  params: z.object({ shareId: ShareId, groupId: GroupId }),
  body: z.object({ rotation: Rotation.nullable(), permissionVersion: z.number().int() }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Drop a person's direct grant in a share, keeping what their groups give
 * them: a rotation only when their keys exceed that.
 */
export const removeDirectGrant = {
  method: 'POST',
  path: '/api/shares/:shareId/members/:identityId/direct/remove',
  params: z.object({ shareId: ShareId, identityId: IdentityId }),
  body: z.object({ rotation: Rotation.nullable(), permissionVersion: z.number().int() }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * "Remove from every folder in this space": drop someone's direct grants
 * and group memberships in the space, with one rotation for each share
 * where they hold keys.
 */
export const removeFromSpace = {
  method: 'POST',
  path: '/api/spaces/:spaceId/members/:identityId/remove',
  params: z.object({ spaceId: SpaceId, identityId: IdentityId }),
  body: z.object({ rotations: Rotations, permissionVersion: z.number().int() }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * People waiting for keys in the spaces the caller owns (section 7.9):
 * each share where someone's access, directly or through groups, is more
 * than the keys they hold at their current key. `holds` is what they hold
 * there now: null for nothing, or keys at an older identity key version.
 */
export const waiting = {
  method: 'GET',
  path: '/api/me/waiting',
  response: z.strictObject({
    waiting: z.array(
      z.strictObject({
        spaceId: SpaceId,
        shareId: ShareId,
        person: DirectoryPerson,
        role: ShareRole,
        canPublish: z.boolean(),
        holds: z.strictObject({ keyVersion: PositiveInt, role: ShareRole }).nullable(),
      }),
    ),
  }),
} as const satisfies RouteDef;

/**
 * Give access to someone waiting in a space: for each share they wait in
 * that the owner seals, every version at their current key, by role. Any
 * share left out stays waiting. This replaces Share again after a key
 * change: it replaces the key version of their member rows.
 */
export const giveAccess = {
  method: 'POST',
  path: '/api/spaces/:spaceId/members/:identityId/give-access',
  params: z.object({ spaceId: SpaceId, identityId: HumanId }),
  body: z.object({
    keyVersion: PositiveInt,
    envelopes: Envelopes,
    permissionVersion: z.number().int(),
  }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

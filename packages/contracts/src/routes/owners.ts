import { z } from 'zod';
import { HumanId, IdentityId, ShareId, SpaceId } from '../records/ids.ts';
import { KeyEnvelopeV2 } from '../records/revision.ts';
import { MetadataEnvelopeV2, SealedMetadata, SealedMetadataV2 } from '../records/metadata.ts';
import { FolderKeyEnvelope, OwnerStatement } from '../records/share.ts';
import { PositiveInt } from '../records/encoding.ts';
import type { RouteDef } from '../route.ts';
import { DirectoryPerson } from './people.ts';
import { Rotation } from './sharing.ts';

const SpaceParams = z.object({ spaceId: SpaceId });

// A name record's signed parts, without its payload.
const SignedName = z.union([
  SealedMetadata.pick({ record: true, signature: true }),
  SealedMetadataV2.pick({ record: true, signature: true }),
]);

/**
 * The space's current owners at their current keys, as the server lists
 * them, for its owners and members. Owners also get the space's first name
 * record, signed, without its payload: an app accepts itself as an owner if
 * it wrote that record (protocol section 6.5, step 1).
 */
export const owners = {
  method: 'GET',
  path: '/api/spaces/:spaceId/owners',
  params: SpaceParams,
  response: z.strictObject({
    owners: z.array(DirectoryPerson),
    nameRecords: z.array(SignedName),
    /** The space's permission version, which owner changes carry. */
    permissionVersion: z.number().int(),
  }),
} as const satisfies RouteDef;

/** Every owner statement of the space, in the order stored, for its owners and members. */
export const statements = {
  method: 'GET',
  path: '/api/spaces/:spaceId/owner-statements',
  params: SpaceParams,
  response: z.strictObject({ statements: z.array(OwnerStatement) }),
} as const satisfies RouteDef;

/**
 * A new owner's statement naming the owner who added them (section 6.5).
 * Signed by the caller, an owner, at their current key; the named owner is a
 * person who is, or has been, an owner of the space.
 */
export const addStatement = {
  method: 'POST',
  path: '/api/spaces/:spaceId/owner-statements',
  params: SpaceParams,
  body: z.object({ statement: OwnerStatement }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Add a co-owner, or re-add one whose key changed (section 7.6): every key
 * version of every share in the space and every owner-region record's key,
 * sealed to them by the caller, and the caller's statement naming them. The
 * server adds them only if the envelopes cover all of it.
 */
export const addOwner = {
  method: 'POST',
  path: '/api/spaces/:spaceId/owners',
  params: SpaceParams,
  body: z.object({
    identityId: HumanId,
    keyVersion: PositiveInt,
    statement: OwnerStatement,
    folderKeyEnvelopes: z.array(FolderKeyEnvelope).max(100_000),
    keyEnvelopes: z.array(KeyEnvelopeV2).max(500_000),
    metadataEnvelopes: z.array(MetadataEnvelopeV2).max(500_000),
    permissionVersion: z.number().int(),
  }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Remove an owner, the caller included (section 7.6), rotating every share
 * in the space at once, one rotation per share, leaving the removed owner
 * out of each. A space always keeps one owner (`last-owner`).
 */
export const removeOwner = {
  method: 'POST',
  path: '/api/spaces/:spaceId/owners/:identityId/remove',
  params: z.object({ spaceId: SpaceId, identityId: IdentityId }),
  body: z.object({
    rotations: z.array(Rotation.extend({ shareId: ShareId })).max(1000),
    permissionVersion: z.number().int(),
  }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Delete the space for everyone, with everything in it: every page and
 * folder, their history and attachments, its shares and groups. Any owner
 * can, except of a space that is an owner's home space (`home-space`).
 */
export const deleteSpace = {
  method: 'DELETE',
  path: '/api/spaces/:spaceId',
  params: SpaceParams,
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

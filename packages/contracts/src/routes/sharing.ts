import { z } from 'zod';
import { PositiveInt } from '../records/encoding.ts';
import {
  AgentId,
  FolderId,
  GroupId,
  HumanId,
  IdentityId,
  MetadataRevisionId,
  NodeId,
  RevisionId,
  ShareId,
  SpaceId,
} from '../records/ids.ts';
import {
  MetadataEnvelope,
  MetadataEnvelopeV2,
  SealedMetadata,
  SealedMetadataV2,
} from '../records/metadata.ts';
import {
  KeyEnvelope,
  KeyEnvelopeV2,
  SealedRevision,
  SealedRevisionV2,
} from '../records/revision.ts';
import { FolderKeyEnvelope, KeyWrap, Share } from '../records/share.ts';
import type { RouteDef } from '../route.ts';
import { ServedMetadata } from './structure.ts';

/** A member's role in a share. Owners hold every share's keys and aren't members. */
export const ShareRole = z.enum(['reader', 'editor']);
export type ShareRole = z.infer<typeof ShareRole>;

/**
 * A member as the server lists them, at the identity key version their
 * envelopes go to. `role` is the keys they hold there, and `canPublish`
 * their effective publish rights: the highest of their direct grant and
 * their groups' access (section 7.8), capped by those keys.
 */
export const Member = z
  .strictObject({
    identityId: HumanId,
    keyVersion: PositiveInt,
    role: ShareRole,
    /** Editor with publish. Readers never publish. */
    canPublish: z.boolean(),
  })
  .refine((member) => member.role === 'editor' || !member.canPublish, {
    message: 'Readers never publish',
  });
export type Member = z.infer<typeof Member>;

const SpaceParams = z.object({ spaceId: SpaceId });
const ShareParams = z.object({ shareId: ShareId });
const Envelopes = z.array(FolderKeyEnvelope).max(100_000);

/**
 * A new key version, `expectedKeyVersion + 1`, sealed to everyone who keeps
 * the share (protocol section 7.5). `removed` names every listed member left
 * out, `demoted` the members who become readers.
 */
export const Rotation = z.object({
  expectedKeyVersion: PositiveInt,
  removed: z.array(IdentityId).max(1000),
  demoted: z.array(IdentityId).max(1000),
  envelopes: Envelopes,
});

/**
 * An agent as an owner sees it in a share: whose it is, and the name its
 * person gave it, as the server has it. Owners never seal to agents; their
 * people do (protocol section 9.4).
 */
export const ShareAgent = z.strictObject({
  agentId: AgentId,
  personId: HumanId,
  name: z.string(),
});
export type ShareAgent = z.infer<typeof ShareAgent>;

/**
 * A space's shares and their members, for its owners. `agents` are the
 * agents with a pick in the share, which reach it only through their
 * person. `formerAgents` hold an envelope of the share's current key
 * version but no pick any more (revoked, or the pick was removed), so the
 * owners may want to rotate its keys (section 9.7).
 */
export const listShares = {
  method: 'GET',
  path: '/api/spaces/:spaceId/shares',
  params: SpaceParams,
  response: z.strictObject({
    shares: z.array(
      Share.extend({
        members: z.array(Member),
        agents: z.array(
          ShareAgent.extend({
            /** The picked folder, or null for the whole share. */
            folderId: FolderId.nullable(),
            role: ShareRole,
            canPublish: z.boolean(),
          }),
        ),
        formerAgents: z.array(ShareAgent),
        /** Members' direct grants, which `addMember` sets (section 7.8). */
        direct: z.array(
          z.strictObject({ identityId: HumanId, role: ShareRole, canPublish: z.boolean() }),
        ),
        /** The groups the share is shared with, and their access. */
        groups: z.array(
          z.strictObject({ groupId: GroupId, role: ShareRole, canPublish: z.boolean() }),
        ),
      }),
    ),
  }),
} as const satisfies RouteDef;

/** Which record a key wrap is for, when a share is made. */
export const SubjectWrap = z.strictObject({
  subjectKind: z.enum(['revision', 'metadata']),
  versionId: z.union([RevisionId, MetadataRevisionId]),
  wrap: KeyWrap,
});

/**
 * Make a folder, or the whole space (`rootId: null`), a share (section 6.7):
 * a wrap under version 1 for every record in it, version 1 sealed to every
 * owner and every new member, and the members. All or nothing. Shares never
 * nest (`share-nesting`), and share IDs are unique (`duplicate`).
 * `agentGrants` are for a person's own agents picking this folder in the
 * owner region (section 9.4): version 1 is sealed to each by the caller.
 */
export const makeShare = {
  method: 'POST',
  path: '/api/spaces/:spaceId/shares',
  params: SpaceParams,
  body: z.object({
    shareId: ShareId,
    rootId: FolderId.nullable(),
    wraps: z.array(SubjectWrap).max(500_000),
    envelopes: Envelopes,
    members: z.array(Member).max(1000),
    agentGrants: z
      .array(
        z
          .strictObject({
            agentId: AgentId,
            folderId: FolderId.nullable(),
            role: ShareRole,
            canPublish: z.boolean(),
          })
          .refine((grant) => grant.role === 'editor' || !grant.canPublish, {
            message: 'Readers never publish',
          }),
      )
      .max(100)
      .default([]),
    /**
     * Groups the share is made with (section 7.8). Their members get version
     * 1 by role in `envelopes`, or wait for an owner to seal to them.
     */
    groups: z
      .array(
        z
          .strictObject({ groupId: GroupId, role: ShareRole, canPublish: z.boolean() })
          .refine((group) => group.role === 'editor' || !group.canPublish, {
            message: 'Readers never publish',
          }),
      )
      .max(100)
      .default([]),
    /** The permission version of the folder, or the space for a space share. */
    permissionVersion: z.number().int(),
  }),
  response: z.strictObject({ shareId: ShareId }),
  status: 201,
} as const satisfies RouteDef;

/**
 * Move a page or folder, with everything under it, into another folder of
 * the same space or to its top (section 10). Within one region it changes
 * no keys, and an editor may move within their share. Across a region
 * boundary it is for owners, and carries every record of the subtree again:
 * `wraps` under the destination share's current key version, or, into the
 * owner region, `keyEnvelopes` and `metadataEnvelopes` to every owner. A
 * record written meanwhile is missing from them (`stale-head`): scan again,
 * and send the move with it too. Shares never nest (`share-nesting`).
 */
export const move = {
  method: 'POST',
  path: '/api/spaces/:spaceId/nodes/:nodeId/move',
  params: z.object({ spaceId: SpaceId, nodeId: NodeId }),
  body: z.object({
    /** The destination folder, or null for the top of the space. */
    parentId: FolderId.nullable(),
    /** Where the node is now; a move from anywhere else is `stale-head`. */
    expectedParentId: FolderId.nullable(),
    /** The node's permission version. */
    permissionVersion: z.number().int(),
    /** The destination folder's permission version, or the space's. */
    parentPermissionVersion: z.number().int(),
    wraps: z.array(SubjectWrap).max(500_000).default([]),
    keyEnvelopes: z.array(KeyEnvelopeV2).max(500_000).default([]),
    metadataEnvelopes: z.array(MetadataEnvelopeV2).max(500_000).default([]),
  }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Add a member, change a reader to an editor, or share again with one whose
 * key changed (sections 7.3 and 7.4): envelopes for every key version, at
 * the member's key, with the draft key exactly when they are an editor. A
 * member listed at the same role and key with no envelopes changes only
 * their publish rights, which change no keys. With groups, `member` is the
 * direct grant: envelopes are needed only where the keys the member holds
 * fall short of their effective access (section 7.8), and lowering the
 * direct grant is allowed without a rotation while their groups keep it.
 */
export const addMember = {
  method: 'POST',
  path: '/api/shares/:shareId/members',
  params: ShareParams,
  body: z.object({
    member: Member,
    envelopes: Envelopes,
    /** The permission version of the share's root. */
    permissionVersion: z.number().int(),
  }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/** Rotate a share's keys, removing or demoting members on the way (sections 7.4 and 7.5). */
export const rotate = {
  method: 'POST',
  path: '/api/shares/:shareId/rotate',
  params: ShareParams,
  body: Rotation.extend({ permissionVersion: z.number().int() }),
  response: z.strictObject({ keyVersion: PositiveInt }),
} as const satisfies RouteDef;

/**
 * Every envelope of one key version of a share, for an owner of its space;
 * anyone else gets only their own (section 6.4).
 */
export const versionEnvelopes = {
  method: 'GET',
  path: '/api/shares/:shareId/versions/:keyVersion/envelopes',
  params: z.object({ shareId: ShareId, keyVersion: z.coerce.number().int().positive() }),
  response: z.strictObject({ envelopes: z.array(FolderKeyEnvelope) }),
} as const satisfies RouteDef;

/** Every folder key envelope addressed to the caller in the space, at their current key. */
export const myEnvelopes = {
  method: 'GET',
  path: '/api/spaces/:spaceId/my-envelopes',
  params: SpaceParams,
  response: z.strictObject({ envelopes: z.array(FolderKeyEnvelope) }),
} as const satisfies RouteDef;

/**
 * Every share in which the caller is a member and not an owner (section
 * 7.7), with the share root's current name: the space's for a space share.
 */
export const sharedWithMe = {
  method: 'GET',
  path: '/api/shared-with-me',
  response: z.strictObject({
    shares: z.array(
      z.strictObject({
        share: Share,
        role: ShareRole,
        canPublish: z.boolean(),
        root: ServedMetadata,
      }),
    ),
  }),
} as const satisfies RouteDef;

// A Milestone 1 record comes with its payload, which the owner decrypts to
// check the content key: v1 records don't commit to it. A v2 record's key
// commitment is enough.
const ScannedRevision = z.union([SealedRevision, SealedRevisionV2.omit({ payload: true })]);
const ScannedMetadata = z.union([SealedMetadata, SealedMetadataV2.omit({ payload: true })]);

/**
 * Every retained record in a scope, with the caller's key material for it,
 * for an owner about to make a share or move something across a region
 * boundary (`subtree`: the folder or page `rootId` and everything under it,
 * or the whole space) or add a co-owner (`owner-region`). In parts: ask
 * again from `next` until it is null.
 */
export const records = {
  method: 'GET',
  path: '/api/spaces/:spaceId/records',
  params: SpaceParams,
  query: z.object({
    scope: z.enum(['subtree', 'owner-region']),
    rootId: NodeId.optional(),
    after: z.string().max(200).optional(),
  }),
  response: z.strictObject({
    records: z.array(
      z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('revision'),
          revision: ScannedRevision,
          wrap: KeyWrap.nullable(),
          envelopes: z.array(z.union([KeyEnvelope, KeyEnvelopeV2])),
        }),
        z.strictObject({
          kind: z.literal('metadata'),
          metadata: ScannedMetadata,
          wrap: KeyWrap.nullable(),
          envelopes: z.array(z.union([MetadataEnvelope, MetadataEnvelopeV2])),
        }),
      ]),
    ),
    next: z.string().nullable(),
    /** How many records the scope held when this part was read, for showing progress. */
    total: z.number().int(),
  }),
} as const satisfies RouteDef;

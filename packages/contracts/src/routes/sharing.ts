import { z } from 'zod';
import { PositiveInt } from '../records/encoding.ts';
import {
  AgentId,
  CommentId,
  FolderId,
  GroupId,
  HumanId,
  IdentityId,
  MetadataRevisionId,
  NodeId,
  PageId,
  RevisionId,
  ShareId,
  SpaceId,
} from '../records/ids.ts';
import {
  MetadataEnvelope,
  MetadataEnvelopeV2,
  SealedComment,
  SealedMetadata,
  SealedMetadataV2,
} from '../records/metadata.ts';
import {
  Audience,
  KeyEnvelope,
  KeyEnvelopeV2,
  SealedRevision,
  SealedRevisionV2,
} from '../records/revision.ts';
import { Position } from '../records/position.ts';
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
      }),
    ),
  }),
} as const satisfies RouteDef;

/**
 * Which record a key wrap is for, when a share is made or something moves
 * into one: a page version, a name, or a comment's current version
 * (section 5.9), which older apps never send.
 */
export const SubjectWrap = z.strictObject({
  subjectKind: z.enum(['revision', 'metadata', 'comment']),
  versionId: z.union([RevisionId, MetadataRevisionId]),
  wrap: KeyWrap,
});

/**
 * Envelopes to the owners for comments' current versions (section 5.9),
 * beside `metadataEnvelopes`, in the requests that seal a subtree to the
 * owner region. Older apps never send them.
 */
export const CommentEnvelopes = z.array(MetadataEnvelopeV2).max(500_000).default([]);

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
 * owner region, `keyEnvelopes`, `metadataEnvelopes` and `commentEnvelopes`
 * to every owner. A
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
    /**
     * Where it goes among what is there (section 10, Order): a position, or null
     * to list it by name. Left out, it goes at the end of a folder with an
     * order of its own, and by name in one without (#400).
     */
    position: Position.nullable().optional(),
    wraps: z.array(SubjectWrap).max(500_000).default([]),
    keyEnvelopes: z.array(KeyEnvelopeV2).max(500_000).default([]),
    metadataEnvelopes: z.array(MetadataEnvelopeV2).max(500_000).default([]),
    commentEnvelopes: CommentEnvelopes,
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
// commitment is enough. A comment always comes whole: the owner's app opens
// it in full to take its audience from it (section 5.9).
const ScannedRevision = z.union([SealedRevision, SealedRevisionV2.omit({ payload: true })]);
const ScannedMetadata = z.union([SealedMetadata, SealedMetadataV2.omit({ payload: true })]);

/**
 * Every retained record in a scope, with the caller's key material for it,
 * for an owner about to make a share or move something across a region
 * boundary (`subtree`: the folder or page `rootId` and everything under it,
 * or the whole space), add a co-owner (`owner-region`), or end a share
 * (`share`: every record wrapped under share `shareId`, the trash included,
 * but a copy's hidden nodes'). In parts: ask again from `next` until it is
 * null. With `comments=1`, comments' current versions come too (section
 * 5.9), with the page, thread and audience the server records for each;
 * without it, a scope that holds a comment is `invalid-request`, which
 * released apps show as "Update the app".
 */
export const records = {
  method: 'GET',
  path: '/api/spaces/:spaceId/records',
  params: SpaceParams,
  query: z
    .object({
      scope: z.enum(['subtree', 'owner-region', 'share']),
      rootId: NodeId.optional(),
      shareId: ShareId.optional(),
      after: z.string().max(200).optional(),
      comments: z.literal('1').optional(),
    })
    .refine((query) => (query.scope === 'share') === (query.shareId !== undefined), {
      message: 'A share scan names its share, and only it',
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
        z.strictObject({
          kind: z.literal('comment'),
          comment: SealedComment,
          pageId: PageId,
          thread: CommentId.nullable(),
          audience: Audience,
          wrap: KeyWrap.nullable(),
          envelopes: z.array(MetadataEnvelopeV2),
        }),
      ]),
    ),
    next: z.string().nullable(),
    /** How many records the scope held when this part was read, for showing progress. */
    total: z.number().int(),
  }),
} as const satisfies RouteDef;

/**
 * End a share (section 6.9): every record wrapped under it, but a copy's
 * hidden nodes', sealed again to every current owner in v2 envelopes the
 * caller grants, with the permission version of the share's root, or of the
 * space for a space share. The share goes, with its members, groups'
 * access, agents' picks, folder key envelopes and wraps. A record saved
 * since the scan, or one no longer wrapped under the share, is `stale-head`:
 * scan again. A request sent again after its answer was lost finds the
 * share gone (`not-found`).
 */
export const endShare = {
  method: 'POST',
  path: '/api/shares/:shareId/end',
  params: ShareParams,
  body: z.object({
    permissionVersion: z.number().int(),
    keyEnvelopes: z.array(KeyEnvelopeV2).max(500_000),
    metadataEnvelopes: z.array(MetadataEnvelopeV2).max(500_000),
    commentEnvelopes: CommentEnvelopes,
  }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * What ending a share would end and keep, for an owner's preview (section
 * 6.9, step 1), of the pages under its root: each public link, and whether
 * it ends because who turned it on can't publish the page afterwards
 * (ADR 0005, decision 8); the pages with a live publication into another
 * space (`publishedFrom`); and the pages that are one from another space
 * (`publishedInto`). Who loses access comes from `listShares` and the
 * share's envelopes, as for a move.
 */
export const shareEnding = {
  method: 'GET',
  path: '/api/shares/:shareId/ending',
  params: ShareParams,
  response: z.strictObject({
    links: z.array(z.strictObject({ pageId: PageId, ends: z.boolean() })),
    publishedFrom: z.array(PageId),
    publishedInto: z.array(PageId),
  }),
} as const satisfies RouteDef;

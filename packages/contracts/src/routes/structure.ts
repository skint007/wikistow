import { z } from 'zod';
import { AgentId, FolderId, HumanId, NodeId, PageId, RevisionId, SpaceId } from '../records/ids.ts';
import {
  MetadataEnvelope,
  MetadataEnvelopeV2,
  SealedMetadata,
  SealedMetadataV2,
} from '../records/metadata.ts';
import { KeyWrap, Share } from '../records/share.ts';
import type { RouteDef } from '../route.ts';

export const AccessRole = z.enum(['reader', 'editor', 'owner']);

const Envelopes = z.array(MetadataEnvelopeV2).max(100);

/**
 * A metadata version as served: in a share, with its key wrap; otherwise
 * with the caller's own envelopes for it. Exactly one of the two is set
 * (protocol section 16). Milestone 1 versions are served as stored.
 */
export const ServedMetadata = z.strictObject({
  metadata: z.union([SealedMetadata, SealedMetadataV2]),
  wrap: KeyWrap.nullable(),
  envelopes: z.array(z.union([MetadataEnvelope, MetadataEnvelopeV2])),
});
export type ServedMetadata = z.infer<typeof ServedMetadata>;

/**
 * A version an agent wrote, for editors (readers never learn of drafts):
 * which agent, the name its person gave it, that person's identity and
 * account name, all as the server has them, and when.
 */
export const AgentEdit = z.strictObject({
  agentId: AgentId,
  agentName: z.string(),
  personId: HumanId,
  personName: z.string().nullable(),
  at: z.iso.datetime(),
});
export type AgentEdit = z.infer<typeof AgentEdit>;

/** A space the caller can open, with its current encrypted name. */
export const SpaceSummary = z.strictObject({
  id: SpaceId,
  kind: z.enum(['personal', 'shared']),
  role: AccessRole,
  canPublish: z.boolean(),
  permissionVersion: z.number().int(),
  ...ServedMetadata.shape,
});

export const FolderSummary = z.strictObject({
  id: FolderId,
  /** Null at the space root, and at the root of a share the caller holds as a member. */
  parentId: FolderId.nullable(),
  permissionVersion: z.number().int(),
  ...ServedMetadata.shape,
});

/** A page in the tree. Titles live inside revisions, so clients open the head to show one. */
export const PageSummary = z.strictObject({
  id: PageId,
  parentId: FolderId.nullable(),
  permissionVersion: z.number().int(),
  /** Null for readers, who never see drafts. */
  draftHead: RevisionId.nullable(),
  publishedHead: RevisionId.nullable(),
  /** The draft differs from the latest publication (always false for readers). */
  draftChanges: z.boolean(),
});

/** A share the caller can see in the tree, and their role in it. */
export const ShareSummary = z.strictObject({
  ...Share.shape,
  role: AccessRole,
  canPublish: z.boolean(),
});

const SpaceParams = z.object({ spaceId: SpaceId });

/**
 * Spaces the caller owns, or holds as a member of the space's own share. A
 * person's spaces come home space first, then in their saved order
 * (`setSpaceOrder`), then the rest in the order they got them. Its shape
 * stays as released apps read it; `spaceOrder` names the home space.
 */
export const listSpaces = {
  method: 'GET',
  path: '/api/spaces',
  response: z.strictObject({ spaces: z.array(SpaceSummary) }),
} as const satisfies RouteDef;

/**
 * The caller's home space, the personal space they have owned longest, which
 * the space list always puts first (null if they own none), and their saved
 * order. People only.
 */
export const spaceOrder = {
  method: 'GET',
  path: '/api/me/space-order',
  response: z.strictObject({ homeId: SpaceId.nullable(), spaceIds: z.array(SpaceId) }),
} as const satisfies RouteDef;

/**
 * Save the order of the caller's spaces, the whole list. IDs of spaces the
 * caller can't open are dropped; the answer is what was saved. People only.
 */
export const setSpaceOrder = {
  method: 'PUT',
  path: '/api/me/space-order',
  body: z.object({ spaceIds: z.array(SpaceId).max(1000) }),
  response: z.strictObject({ spaceIds: z.array(SpaceId) }),
} as const satisfies RouteDef;

/** A new space owned by the caller; its name is the first metadata version, sealed to them. */
export const createSpace = {
  method: 'POST',
  path: '/api/spaces',
  body: z.object({
    spaceId: SpaceId,
    kind: z.enum(['personal', 'shared']),
    metadata: SealedMetadataV2,
    envelopes: Envelopes,
  }),
  response: z.strictObject({ spaceId: SpaceId }),
  status: 201,
} as const satisfies RouteDef;

/**
 * What the caller can see of a space: everything, for an owner or a member
 * of the space's share; for a member of folder shares, only those folders
 * and what is in them, with no space name and nothing above them (section
 * 7.7).
 */
export const tree = {
  method: 'GET',
  path: '/api/spaces/:spaceId/tree',
  params: SpaceParams,
  response: z.strictObject({
    /** Null for someone who holds only folder shares in the space. */
    space: SpaceSummary.nullable(),
    shares: z.array(ShareSummary),
    folders: z.array(FolderSummary),
    pages: z.array(PageSummary),
    /**
     * The latest version an agent wrote of a page the caller can edit, and
     * whether it is still only a draft (nothing published since), or null.
     */
    agentActivity: AgentEdit.extend({ pageId: PageId, draftOnly: z.boolean() }).nullable(),
  }),
} as const satisfies RouteDef;

/**
 * Where a node is, for a write there (section 6.8): the share whose region
 * holds it, or none for the owner region; the permission version the write
 * carries; and for a folder, or the space when `nodeId` is absent, its
 * current name record, whose region a new node inside takes (section 6.1).
 */
export const target = {
  method: 'GET',
  path: '/api/spaces/:spaceId/target',
  params: SpaceParams,
  query: z.object({ nodeId: NodeId.optional() }),
  response: z.strictObject({
    permissionVersion: z.number().int(),
    share: Share.nullable(),
    name: ServedMetadata.nullable(),
  }),
} as const satisfies RouteDef;

export const createFolder = {
  method: 'POST',
  path: '/api/spaces/:spaceId/folders',
  params: SpaceParams,
  body: z.object({
    folderId: FolderId,
    parentId: FolderId.nullable(),
    permissionVersion: z.number().int(),
    metadata: SealedMetadataV2,
    envelopes: Envelopes,
    wrap: KeyWrap.nullable(),
  }),
  response: z.strictObject({ folderId: FolderId }),
  status: 201,
} as const satisfies RouteDef;

/** A new version of a space's or folder's metadata, based on its current head. */
export const updateMetadata = {
  method: 'POST',
  path: '/api/spaces/:spaceId/metadata',
  params: SpaceParams,
  body: z.object({
    permissionVersion: z.number().int(),
    metadata: SealedMetadataV2,
    envelopes: Envelopes,
    wrap: KeyWrap.nullable(),
  }),
  response: z.strictObject({ metadataRevisionId: z.string() }),
} as const satisfies RouteDef;

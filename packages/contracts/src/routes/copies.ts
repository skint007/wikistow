// Copying a page or folder, with everything under it, as new nodes under
// a folder of any space, and moving one into another space, which is a
// copy that deletes its source (protocol section 10, "Copies, and moves
// between spaces"; ADR 0007).
import { z } from 'zod';
import { FolderId, MetadataRevisionId, NodeId, RevisionId, SpaceId } from '../records/ids.ts';
import { MetadataEnvelopeV2, SealedMetadataV2 } from '../records/metadata.ts';
import { KeyWrap } from '../records/share.ts';
import type { RouteDef } from '../route.ts';
import { Commit } from './pages.ts';

/** A copy's ID, made by the app that opens it. */
export const CopyId = NodeId;

const CopyParams = z.object({ copyId: CopyId });

/** The most nodes one copy takes: as many as an account may make. */
export const MAX_COPY_NODES = 110_000;

/**
 * Bytes of records one `records` request may carry. An app sends as many
 * nodes in one as fit, and always at least one: a page's draft and
 * published version together are at most some 1.5 MB.
 */
export const MAX_RECORDS_BODY = 8 * 1024 * 1024;

/** How much an app puts in one `records` request before starting the next. */
export const RECORDS_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * One node of the source subtree and the new node that copies it: `parentId`
 * is the new node's parent, the new ID of its source's parent, or for the
 * new top node, the destination folder (null for the top of the space).
 */
export const CopiedNode = z.object({
  nodeId: NodeId,
  sourceId: NodeId,
  kind: z.enum(['folder', 'page']),
  parentId: NodeId.nullable(),
});

/**
 * Open a copy of `sourceNodeId` (in `sourceSpaceId`) under `parentId` in
 * `destinationSpaceId`: the new nodes, one for each node of the source
 * subtree the caller's tree lists, under the same parents, are made hidden,
 * so their attachments can be uploaded. `kind: 'move'` deletes the source
 * when the copy finishes, and goes only into another space; only an owner
 * of the source space, with a session, moves. Anyone who can edit every
 * node of the source copies; and both need to make pages under `parentId`,
 * and to publish there when the copy `bringsPublished`.
 * `sourcePermissionVersion` and `permissionVersion` are the source node's
 * and the destination parent's (or space's), as the preview was made at.
 * Refused: a source holding a live publication from another page
 * (`forbidden`, naming those pages in `detail.nodeIds`), and a page with
 * neither a draft nor a published version, so nothing to copy (`forbidden`,
 * named the same way), a destination
 * inside the source (`binding-mismatch`),
 * and nodes that don't mirror the source as it is now (`stale-head`).
 */
export const open = {
  method: 'POST',
  path: '/api/copies',
  body: z.object({
    copyId: CopyId,
    kind: z.enum(['copy', 'move']),
    /** Whether pages' published versions come along: only where the caller can publish. */
    bringsPublished: z.boolean(),
    sourceSpaceId: SpaceId,
    sourceNodeId: NodeId,
    sourcePermissionVersion: z.number().int(),
    destinationSpaceId: SpaceId,
    parentId: FolderId.nullable(),
    permissionVersion: z.number().int(),
    nodes: z.array(CopiedNode).min(1).max(MAX_COPY_NODES),
  }),
  response: z.strictObject({ copyId: CopyId }),
  status: 201,
} as const satisfies RouteDef;

/**
 * One version of a new page and the source version it was sealed from: a
 * new page's first version (`revision.record.basedOn` null; a published
 * version may name the draft in its entry, when the source's was made from
 * its current draft or it had none), with the key material of the new
 * page's region at its current key version.
 */
const CopiedVersion = z.object({ ...Commit, sourceRevisionId: RevisionId }).omit({
  permissionVersion: true,
});

/**
 * Every record of one new node: a page's draft (its published version, for
 * a page with no draft), and its published version
 * when the copy brings published versions and the page is published now; a
 * folder's name and look, with the key material of its region. Each names
 * the source version it was sealed from: the source's heads, which a move's
 * finish compares.
 */
export const CopiedRecords = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('page'),
    nodeId: NodeId,
    draft: CopiedVersion,
    published: CopiedVersion.nullable(),
  }),
  z.object({
    kind: z.literal('folder'),
    nodeId: NodeId,
    metadata: SealedMetadataV2,
    envelopes: z.array(MetadataEnvelopeV2).max(100),
    wrap: KeyWrap.nullable(),
    sourceMetadataRevisionId: MetadataRevisionId,
  }),
]);

/**
 * Records for the copy's new nodes, each node's in one entry, which
 * replaces the records sent for that node before; a node listed twice is
 * `binding-mismatch`. Only the copy's opener sends them. Published versions
 * go only in a copy that brings them (`forbidden`). They are written at the
 * destination parent's permission version sent at the opening (the space's
 * for the top of a space): `permission-version` otherwise, which ends the
 * copy, as at the finish. `key-version` is sealed again and sent again.
 */
export const records = {
  method: 'POST',
  path: '/api/copies/:copyId/records',
  params: CopyParams,
  body: z.object({ nodes: z.array(CopiedRecords).min(1).max(1000) }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Show the copy's new nodes, and for a move, delete the source, as deleting
 * it would. Only the opener finishes, if they still may copy (or move)
 * from the source to the destination. A source head that moved on since its
 * node was sealed, for a move, is `stale-head`, naming the new nodes to seal
 * again (`detail.nodeIds`); send them and finish again. So is
 * `rate-limited`: finish again shortly. Any other refusal deletes the copy:
 * open a new one from a new preview.
 */
export const finish = {
  method: 'POST',
  path: '/api/copies/:copyId/finish',
  params: CopyParams,
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/** Delete an unfinished copy and its hidden nodes, for its opener. */
export const cancel = {
  method: 'DELETE',
  path: '/api/copies/:copyId',
  params: CopyParams,
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

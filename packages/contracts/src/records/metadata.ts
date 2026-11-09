import { z } from 'zod';
import { Base64, Hash32, PositiveInt, Sealed } from './encoding.ts';
import { envelopeParties, recordCommitment } from './envelope.ts';
import {
  CommentId,
  IdentityId,
  InstallationId,
  MetadataRevisionId,
  NodeId,
  SpaceId,
} from './ids.ts';

/**
 * A signed, immutable version of a space's or folder's encrypted metadata
 * (name, emoji, tint). Renaming writes a new version based on the current
 * head, exactly like a page draft. A v1 record names a space or folder
 * only: a group's name and a comment are v2 records (sections 5.7 and 5.9).
 */
export const MetadataRecord = z.strictObject({
  protocol: z.literal(1),
  installationId: InstallationId,
  spaceId: SpaceId,
  subjectKind: z.enum(['space', 'folder']),
  /** The space ID for a space, the folder ID for a folder, and in v2 the group ID for a group. */
  subjectId: NodeId,
  metadataRevisionId: MetadataRevisionId,
  basedOn: MetadataRevisionId.nullable(),
  authorId: IdentityId,
  authorKeyVersion: PositiveInt,
  payloadHash: Hash32,
});
export type MetadataRecord = z.infer<typeof MetadataRecord>;

/**
 * A metadata record from Milestone 2 on, of a name: a space's, a folder's,
 * or a group's, which is always in the space's owner region (protocol
 * section 6.6). Selected by `protocol: 2`. A comment has the same signed
 * layout, but its own schema (`CommentRecord`), so no route that takes a
 * name takes a comment.
 */
export const MetadataRecordV2 = z.strictObject({
  ...MetadataRecord.shape,
  protocol: z.literal(2),
  subjectKind: z.enum(['space', 'folder', 'group']),
  ...recordCommitment,
});
export type MetadataRecordV2 = z.infer<typeof MetadataRecordV2>;

/**
 * One version of a comment on a page (protocol section 5.9): a metadata
 * record v2 with `subjectKind: "comment"`, `subjectId` the comment's ID
 * and `metadataRevisionId` this version's. Its payload names its page,
 * thread and audience, which the record doesn't sign.
 */
export const CommentRecord = z.strictObject({
  ...MetadataRecordV2.shape,
  subjectKind: z.literal('comment'),
  subjectId: CommentId,
});
export type CommentRecord = z.infer<typeof CommentRecord>;

export const SealedMetadata = z.strictObject({
  record: MetadataRecord,
  signature: Base64,
  payload: Sealed,
});
export type SealedMetadata = z.infer<typeof SealedMetadata>;

export const SealedMetadataV2 = z.strictObject({
  record: MetadataRecordV2,
  signature: Base64,
  payload: Sealed,
});
export type SealedMetadataV2 = z.infer<typeof SealedMetadataV2>;

export const SealedComment = z.strictObject({
  record: CommentRecord,
  signature: Base64,
  payload: Sealed,
});
export type SealedComment = z.infer<typeof SealedComment>;

/** A metadata version's key, sealed to one recipient, signed by its granter. */
export const MetadataEnvelope = z.strictObject({
  metadataRevisionId: MetadataRevisionId,
  ...envelopeParties,
});
export type MetadataEnvelope = z.infer<typeof MetadataEnvelope>;

export const MetadataEnvelopeV2 = z.strictObject({
  version: z.literal(2),
  metadataRevisionId: MetadataRevisionId,
  ...envelopeParties,
});
export type MetadataEnvelopeV2 = z.infer<typeof MetadataEnvelopeV2>;

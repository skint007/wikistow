import { z } from 'zod';
import { Base64, Hash32, PositiveInt, Sealed } from './encoding.ts';
import { envelopeParties, recordCommitment } from './envelope.ts';
import { IdentityId, InstallationId, MetadataRevisionId, NodeId, SpaceId } from './ids.ts';

/**
 * A signed, immutable version of a space's or folder's encrypted metadata
 * (name, emoji, tint). Renaming writes a new version based on the current
 * head, exactly like a page draft.
 */
export const MetadataRecord = z.strictObject({
  protocol: z.literal(1),
  installationId: InstallationId,
  spaceId: SpaceId,
  subjectKind: z.enum(['space', 'folder']),
  /** The space ID for a space, the folder ID for a folder. */
  subjectId: NodeId,
  metadataRevisionId: MetadataRevisionId,
  basedOn: MetadataRevisionId.nullable(),
  authorId: IdentityId,
  authorKeyVersion: PositiveInt,
  payloadHash: Hash32,
});
export type MetadataRecord = z.infer<typeof MetadataRecord>;

/** A metadata record from Milestone 2 on. Selected by `protocol: 2`. */
export const MetadataRecordV2 = z.strictObject({
  ...MetadataRecord.shape,
  protocol: z.literal(2),
  ...recordCommitment,
});
export type MetadataRecordV2 = z.infer<typeof MetadataRecordV2>;

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

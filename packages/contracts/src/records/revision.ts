import { z } from 'zod';
import { Base64, Hash32, PositiveInt, Sealed } from './encoding.ts';
import { envelopeParties, recordCommitment } from './envelope.ts';
import { IdentityId, InstallationId, PageId, RevisionId, SpaceId } from './ids.ts';

/** Drafts go to editors; published versions also go to readers. Never mix their keys. */
export const Audience = z.enum(['draft', 'published']);
export type Audience = z.infer<typeof Audience>;

// Signed objects are strict: a property the format doesn't list is malformed,
// never stripped, so one JSON object has exactly one set of signed bytes.

/**
 * The server-visible, signed description of one immutable revision. It holds
 * IDs and a ciphertext hash, never content. `basedOn` is the previous draft for
 * a draft, or the exact draft that was published for a published revision.
 */
export const RevisionRecord = z.strictObject({
  protocol: z.literal(1),
  installationId: InstallationId,
  spaceId: SpaceId,
  pageId: PageId,
  revisionId: RevisionId,
  audience: Audience,
  basedOn: RevisionId.nullable(),
  authorId: IdentityId,
  authorKeyVersion: PositiveInt,
  payloadHash: Hash32,
});
export type RevisionRecord = z.infer<typeof RevisionRecord>;

/** A revision record from Milestone 2 on. Selected by `protocol: 2`. */
export const RevisionRecordV2 = z.strictObject({
  ...RevisionRecord.shape,
  protocol: z.literal(2),
  ...recordCommitment,
});
export type RevisionRecordV2 = z.infer<typeof RevisionRecordV2>;

export const SealedRevision = z.strictObject({
  record: RevisionRecord,
  signature: Base64,
  payload: Sealed,
});
export type SealedRevision = z.infer<typeof SealedRevision>;

export const SealedRevisionV2 = z.strictObject({
  record: RevisionRecordV2,
  signature: Base64,
  payload: Sealed,
});
export type SealedRevisionV2 = z.infer<typeof SealedRevisionV2>;

/**
 * One revision's content key, sealed to one recipient and signed by whoever
 * granted it. Envelopes are separate from the revision so recipients can be
 * added later without touching its signature. A v1 envelope has no `version`.
 */
export const KeyEnvelope = z.strictObject({ revisionId: RevisionId, ...envelopeParties });
export type KeyEnvelope = z.infer<typeof KeyEnvelope>;

/**
 * A key envelope from Milestone 2 on, for content in a space's owner region.
 * Its signed bytes name the space, and its granter may be any accepted owner,
 * not only the author.
 */
export const KeyEnvelopeV2 = z.strictObject({
  version: z.literal(2),
  revisionId: RevisionId,
  ...envelopeParties,
});
export type KeyEnvelopeV2 = z.infer<typeof KeyEnvelopeV2>;

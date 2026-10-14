import { Base64, Hash32, PositiveInt } from './encoding.ts';
import { IdentityId } from './ids.ts';

/**
 * The properties every key envelope shares. Each record type adds the ID of
 * the version it unlocks (`revisionId`, `metadataRevisionId`), and v2 adds
 * `version: 2`.
 */
export const envelopeParties = {
  recipientId: IdentityId,
  recipientKeyVersion: PositiveInt,
  sealedKey: Base64,
  granterId: IdentityId,
  granterKeyVersion: PositiveInt,
  signature: Base64,
};

/**
 * What v2 records add to v1: a hash of the content key, so one ciphertext
 * can't open to different content for different recipients.
 */
export const recordCommitment = { keyCommitment: Hash32 };

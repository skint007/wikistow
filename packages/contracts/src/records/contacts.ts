import { z } from 'zod';
import { Base64, Hash32, PositiveInt, Sealed } from './encoding.ts';
import { HumanId, IdentityId, InstallationId } from './ids.ts';

/**
 * The signed part of one version of a person's contacts record. The shared
 * payload is readable by the owner and their enrolled agents, the private
 * payload by the owner alone. Both key commitments are signed, so a swapped
 * key fails to open rather than decrypting to other content.
 */
export const ContactsRecord = z.strictObject({
  protocol: z.literal(1),
  installationId: InstallationId,
  ownerId: HumanId,
  ownerKeyVersion: PositiveInt,
  version: PositiveInt,
  /** `contactsHash` of the previous version; `null` exactly for version 1. */
  prevHash: Hash32.nullable(),
  payloadHash: Hash32,
  keyCommitment: Hash32,
  privatePayloadHash: Hash32,
  privateKeyCommitment: Hash32,
});
export type ContactsRecord = z.infer<typeof ContactsRecord>;

/** The shared payload's key, sealed to one reader. Not signed: the key commitment covers it. */
export const ContactsKey = z.strictObject({
  recipientId: IdentityId,
  recipientKeyVersion: PositiveInt,
  sealedKey: Base64,
});
export type ContactsKey = z.infer<typeof ContactsKey>;

export const SealedContacts = z.strictObject({
  record: ContactsRecord,
  signature: Base64,
  payload: Sealed,
  keys: z.array(ContactsKey),
  private: Sealed,
  /** The private payload's key, sealed to the owner only. */
  privateKey: Base64,
});
export type SealedContacts = z.infer<typeof SealedContacts>;

/** A record and its signature without payloads: what `?after=n` serves to check a chain. */
export const SignedContactsRecord = SealedContacts.pick({ record: true, signature: true });
export type SignedContactsRecord = z.infer<typeof SignedContactsRecord>;

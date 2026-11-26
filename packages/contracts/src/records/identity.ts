import { z } from 'zod';
import { Hash32, PositiveInt, PublicKey, Signature } from './encoding.ts';
import { HumanId, IdentityId, InstallationId } from './ids.ts';

/**
 * The public half of a human's or agent's keys: X25519 for receiving content
 * keys and Ed25519 for signing. This is what the server's directory serves,
 * so clients never trust it until it is pinned (see `TrustStore`).
 */
export const PublicIdentity = z.object({
  id: IdentityId,
  kind: z.enum(['human', 'agent']),
  keyVersion: PositiveInt,
  boxPublicKey: PublicKey,
  signPublicKey: PublicKey,
});
export type PublicIdentity = z.infer<typeof PublicIdentity>;

/**
 * One exact key of one person, as signed data names it: `keyHash` covers the
 * ID, kind, version and both public keys (see the client's `keyHash`).
 */
export const IdentityRef = z.strictObject({
  id: IdentityId,
  keyVersion: PositiveInt,
  keyHash: Hash32,
});
export type IdentityRef = z.infer<typeof IdentityRef>;

/**
 * A rotation statement (protocol section 4.6): the key at `from` of this
 * person is replaced by the keys at `to`, one version up. Both keys sign the
 * same bytes. `contacts` names the last version of the person's contacts
 * record signed with the old key, and is `null` only for a person with no
 * record, which only happens at key version 1. Strict, with no `version`
 * property: a later format adds one.
 */
export const IdentityRotation = z
  .strictObject({
    installationId: InstallationId,
    id: HumanId,
    from: z.strictObject({ keyVersion: PositiveInt, keyHash: Hash32 }),
    to: z.strictObject({
      keyVersion: PositiveInt,
      boxPublicKey: PublicKey,
      signPublicKey: PublicKey,
    }),
    contacts: z.strictObject({ version: PositiveInt, contactsHash: Hash32 }).nullable(),
    fromSignature: Signature,
    toSignature: Signature,
  })
  .refine((s) => s.to.keyVersion === s.from.keyVersion + 1, {
    message: 'A rotation moves up one key version',
    path: ['to', 'keyVersion'],
  })
  .refine((s) => s.contacts !== null || s.from.keyVersion === 1, {
    message: 'Only a rotation from key version 1 may name no contacts version',
    path: ['contacts'],
  });
export type IdentityRotation = z.infer<typeof IdentityRotation>;

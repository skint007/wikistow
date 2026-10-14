import { z } from 'zod';
import { Base64, PositiveInt, Sealed } from './encoding.ts';
import { IdentityRef } from './identity.ts';
import { FolderId, HumanId, IdentityId, InstallationId, ShareId, SpaceId } from './ids.ts';

/**
 * Which folder key protects a record's content key: drafts take the draft
 * key, and published versions and folder or space names the published key.
 */
export const AudienceClass = z.enum(['draft', 'published', 'metadata']);
export type AudienceClass = z.infer<typeof AudienceClass>;

/**
 * A folder, or a whole space (`rootId: null`), with its own folder keys.
 * Nothing here is signed: who holds the keys is fixed by the signed folder
 * key envelopes, and the rest is the server's to enforce.
 */
export const Share = z.strictObject({
  shareId: ShareId,
  spaceId: SpaceId,
  rootId: FolderId.nullable(),
  currentKeyVersion: PositiveInt,
});
export type Share = z.infer<typeof Share>;

/**
 * A record's content key, wrapped with one folder key of one share's key
 * version. Not signed: only someone holding the folder key can make one that
 * opens, and the record's key commitment catches one that opens to another
 * key. The ciphertext is exactly a 32-byte key and its 16-byte tag.
 */
export const KeyWrap = z.strictObject({
  shareId: ShareId,
  keyVersion: PositiveInt,
  wrappedKey: Sealed.extend({ ciphertext: z.string().regex(/^[A-Za-z0-9_-]{64}$/) }),
});
export type KeyWrap = z.infer<typeof KeyWrap>;

// One folder key sealed to its recipient: 80 bytes, the sealed box of a
// 32-byte key, in 107 characters whose last one carries two unused bits,
// which must be zero. So the signed bytes always decode, and one malformed
// envelope fails to parse rather than throwing while it is verified.
const SealedFolderKey = z.string().regex(/^[A-Za-z0-9_-]{106}[AEIMQUYcgkosw048]$/);

/**
 * One key version of one share, sealed to one person or agent and signed by
 * whoever sealed it: an owner of the space, or for an agent its own person.
 * `draftKey` is always present, and `null` for a reader, so the signature
 * covers the role's class.
 */
export const FolderKeyEnvelope = z.strictObject({
  spaceId: SpaceId,
  shareId: ShareId,
  keyVersion: PositiveInt,
  recipientId: IdentityId,
  recipientKeyVersion: PositiveInt,
  draftKey: SealedFolderKey.nullable(),
  publishedKey: SealedFolderKey,
  sealerId: HumanId,
  sealerKeyVersion: PositiveInt,
  signature: Base64,
});
export type FolderKeyEnvelope = z.infer<typeof FolderKeyEnvelope>;

/**
 * An accepted owner's signed statement that another person owns the space,
 * at one exact key. Signed only when adding a co-owner, by the adder naming
 * the new owner, and by the new owner naming the adder. The named owner is
 * always a person.
 */
export const OwnerStatement = z.strictObject({
  installationId: InstallationId,
  spaceId: SpaceId,
  owner: IdentityRef.extend({ id: HumanId }),
  signerId: HumanId,
  signerKeyVersion: PositiveInt,
  signature: Base64,
});
export type OwnerStatement = z.infer<typeof OwnerStatement>;

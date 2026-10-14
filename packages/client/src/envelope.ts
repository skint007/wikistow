import type { IdentityId } from '@wikistow/contracts';
import { CryptoError } from './errors.ts';
import { canonical, fromBase64, hash, toBase64 } from './encoding.ts';
import { verifySignature, type PrivateIdentity, type PublicIdentity } from './identity.ts';
import type { OpensOwner } from './owner-predicates.ts';
import { sodium } from './sodium.ts';
import type { TrustStore } from './trust.ts';

export type { OpensOwner, WritesOwner } from './owner-predicates.ts';

/**
 * The fields every key envelope shares. Each record type adds the ID of the
 * version it unlocks (`revisionId`, `metadataRevisionId`) and its own signing
 * domain, so an envelope for one kind of record can't stand in for another.
 */
export type EnvelopeParties = {
  recipientId: IdentityId;
  recipientKeyVersion: number;
  sealedKey: string;
  granterId: IdentityId;
  granterKeyVersion: number;
  signature: string;
};

/** Seal a content key so only `recipient` can open it. A key libsodium refuses is `bad-key`. */
export function sealKeyTo(
  contentKey: Uint8Array,
  recipient: Pick<PublicIdentity, 'boxPublicKey'>,
): string {
  try {
    return toBase64(sodium.crypto_box_seal(contentKey, fromBase64(recipient.boxPublicKey)));
  } catch (cause) {
    throw new CryptoError('bad-key', 'Could not seal to this key', { cause });
  }
}

/** Open a key envelope's sealed content key. Throws `decrypt-failed` for anyone but its recipient. */
export function openSealedKey(reader: PrivateIdentity, sealedKey: string): Uint8Array {
  try {
    return sodium.crypto_box_seal_open(
      fromBase64(sealedKey),
      fromBase64(reader.public.boxPublicKey),
      reader.boxSecretKey,
    );
  } catch (cause) {
    throw new CryptoError('decrypt-failed', 'Key envelope does not open with this reader’s key', {
      cause,
    });
  }
}

function requireRecipient(
  reader: PrivateIdentity,
  envelope: Pick<EnvelopeParties, 'recipientId' | 'recipientKeyVersion'>,
  namesThisVersion: boolean,
): void {
  if (
    !namesThisVersion ||
    envelope.recipientId !== reader.public.id ||
    envelope.recipientKeyVersion !== reader.public.keyVersion
  ) {
    throw new CryptoError('wrong-recipient', 'Key envelope is not for this reader and version');
  }
}

/** Throws `untrusted-sealer` unless `owners` accepts `who`, named in the message as `role`. */
export function requireAcceptedOwner(owners: OpensOwner, who: PublicIdentity, role: string) {
  if (!owners(who)) {
    throw new CryptoError(
      'untrusted-sealer',
      `The ${role} ${who.id} is not an owner this app accepts for the space`,
    );
  }
}

/**
 * Check a v1 envelope that arrived with a v1 record, then open its key. It
 * must name that exact record version and this reader at its current key
 * version, be granted by the record's own author (as every Milestone 1
 * envelope was), and carry a valid signature over `signedBytes()`. The
 * caller has already required the author to be an accepted owner.
 */
export function openEnvelope({
  reader,
  trust,
  envelope,
  namesThisVersion,
  author,
  signedBytes,
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  envelope: EnvelopeParties;
  namesThisVersion: boolean;
  author: { id: string; keyVersion: number };
  /** Built only after the recipient checks, so a malformed envelope for someone else is still `wrong-recipient`. */
  signedBytes: () => Uint8Array;
}): Uint8Array {
  requireRecipient(reader, envelope, namesThisVersion);
  if (envelope.granterId !== author.id || envelope.granterKeyVersion !== author.keyVersion) {
    throw new CryptoError('binding-mismatch', 'A v1 key envelope must be granted by its author');
  }
  const granter = trust.require(envelope.granterId, envelope.granterKeyVersion);
  if (!verifySignature(granter, signedBytes(), envelope.signature)) {
    throw new CryptoError('bad-signature', 'Key envelope signature is invalid');
  }
  return openSealedKey(reader, envelope.sealedKey);
}

/**
 * The key from the first of a record's envelopes for this reader that
 * opens, by `open`. A person can hold more than one for a record: a
 * Milestone 1 envelope and a v2 one from being added as an owner again, or
 * envelopes at an old and a new key version (sections 7.6 and 16). When none
 * opens, throws the first failure, preferring any other to `wrong-recipient`
 * so a forged envelope is still reported; with none at all, `missing-key`.
 */
export function openAnyEnvelope(
  envelopes: readonly unknown[],
  open: (raw: unknown) => Uint8Array,
): Uint8Array {
  let failure: CryptoError | undefined;
  for (const raw of envelopes) {
    try {
      return open(raw);
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      if (!failure || failure.code === 'wrong-recipient') failure = error;
    }
  }
  throw failure ?? new CryptoError('missing-key', 'A record came with no envelope for this reader');
}

/**
 * A hash of a content key, signed into v2 records and contacts records. The
 * AEADs don't commit to their key, so without this an author could seal one
 * key to some readers and another to others, opening one ciphertext to two
 * different plaintexts.
 */
export const keyCommitment = (contentKey: Uint8Array): string =>
  hash(canonical('content-key-commit/v1', [contentKey]));

/** Throws `key-commitment`, after wiping the key, unless it is the committed one. */
export function requireCommittedKey(contentKey: Uint8Array, commitment: string): Uint8Array {
  if (keyCommitment(contentKey) !== commitment) {
    sodium.memzero(contentKey);
    throw new CryptoError('key-commitment', 'The content key is not the one the record commits to');
  }
  return contentKey;
}

/**
 * The checks of a v2 envelope before its key is unsealed (section 5.8): it
 * names this record and reader, and an accepted owner of the space signed
 * the v2 bytes at a key this app has pinned.
 */
export function checkEnvelopeV2({
  reader,
  trust,
  owners,
  envelope,
  namesThisVersion,
  signedBytes,
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: OpensOwner;
  envelope: EnvelopeParties;
  namesThisVersion: boolean;
  signedBytes: () => Uint8Array;
}): void {
  requireRecipient(reader, envelope, namesThisVersion);
  const granter = trust.require(envelope.granterId, envelope.granterKeyVersion);
  requireAcceptedOwner(owners, granter, 'granter');
  if (!verifySignature(granter, signedBytes(), envelope.signature)) {
    throw new CryptoError('bad-signature', 'Key envelope signature is invalid');
  }
}

/** Open a checked v2 envelope's key and require the record's key commitment. */
export const unsealCommitted = (
  reader: PrivateIdentity,
  sealedKey: string,
  commitment: string,
): Uint8Array => requireCommittedKey(openSealedKey(reader, sealedKey), commitment);

/**
 * Pick a record's version by its `protocol`: 1 or 2. Any other value is a
 * version this client doesn't know, which fails closed as
 * `unsupported-format` and is never read as an older one.
 */
export function recordProtocol(raw: unknown, what: string): 1 | 2 {
  const protocol = ownProperty(ownProperty(raw, 'record'), 'protocol');
  if (protocol === 1 || protocol === 2) return protocol;
  if (protocol === undefined) throw new CryptoError('malformed', `${what} has no protocol`);
  throw new CryptoError(
    'unsupported-format',
    `${what} uses an unknown protocol; update to open it`,
  );
}

/**
 * Pick an envelope's version: no `version` property is v1, and `version: 2`
 * is v2. Any other value, `1` included, fails closed as `unsupported-format`.
 */
export function envelopeVersion(raw: unknown): 1 | 2 {
  if (typeof raw !== 'object' || raw === null) {
    throw new CryptoError('malformed', 'Key envelope is not an object');
  }
  if (!Object.hasOwn(raw, 'version')) return 1;
  if (ownProperty(raw, 'version') === 2) return 2;
  throw new CryptoError(
    'unsupported-format',
    'Key envelope uses an unknown version; update to open it',
  );
}

const ownProperty = (raw: unknown, key: string): unknown =>
  typeof raw === 'object' && raw !== null && Object.hasOwn(raw, key)
    ? (raw as Record<string, unknown>)[key]
    : undefined;

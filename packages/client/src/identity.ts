import { AGENT_ID, type IdentityRef, type PublicIdentity } from '@wikistow/contracts';
import { canonical, fromBase64, hash, toBase64 } from './encoding.ts';
import { CryptoError } from './errors.ts';
import { IdentityId, InstallationId } from './ids.ts';
import { sodium } from './sodium.ts';

export { IdentityRef, PublicIdentity } from '@wikistow/contracts';

/** A full identity. Lives only in an unlocked vault or an agent's key file. */
export type PrivateIdentity = {
  public: PublicIdentity;
  boxSecretKey: Uint8Array;
  signSecretKey: Uint8Array;
};

export type IdentitySpec =
  | { kind: 'human'; id: IdentityId; keyVersion?: number }
  /** An agent's ID is derived (see `agentIdentityId`), so it is not chosen here. */
  | { kind: 'agent'; installationId: InstallationId; ownerId: IdentityId };

/** Keys are generated on the client; the server only ever sees `public`. */
export function generateIdentity(spec: IdentitySpec): PrivateIdentity {
  const box = sodium.crypto_box_keypair();
  const sign = sodium.crypto_sign_keypair();
  const keys = { boxPublicKey: toBase64(box.publicKey), signPublicKey: toBase64(sign.publicKey) };
  const identity =
    spec.kind === 'human'
      ? { id: spec.id, kind: spec.kind, keyVersion: spec.keyVersion ?? 1 }
      : { id: agentIdentityId({ ...spec, ...keys }), kind: spec.kind, keyVersion: 1 };
  return {
    public: { ...identity, ...keys },
    boxSecretKey: box.privateKey,
    signSecretKey: sign.privateKey,
  };
}

const AGENT_ID_PREFIX = 'agent-';

/**
 * An agent's ID is `agent-` plus a hash of its installation, owner, and public
 * keys. An enrollment is only valid for the ID its own fields produce, so
 * nobody can enroll keys under another agent's ID, even before it is pinned,
 * and the prefix keeps agent and human IDs from ever colliding (see
 * `TrustStore.use`, which never pins an agent on first sight). Rotating an
 * agent's keys means enrolling a new agent.
 */
export function agentIdentityId({
  installationId,
  ownerId,
  boxPublicKey,
  signPublicKey,
}: {
  installationId: InstallationId;
  ownerId: IdentityId;
  boxPublicKey: string;
  signPublicKey: string;
}): IdentityId {
  const digest = sodium.crypto_generichash(
    32,
    canonical('agent-identity-id/v1', [
      installationId,
      ownerId,
      fromBase64(boxPublicKey),
      fromBase64(signPublicKey),
    ]),
    null,
  );
  return IdentityId.parse(`${AGENT_ID_PREFIX}${toBase64(digest)}`);
}

/** The raw 20 bytes behind `fingerprint`. */
export const fingerprintBytes = (identity: PublicIdentity): Uint8Array =>
  sodium.crypto_generichash(
    20,
    canonical('identity-fingerprint/v1', [
      identity.id,
      identity.kind,
      identity.keyVersion,
      fromBase64(identity.boxPublicKey),
      fromBase64(identity.signPublicKey),
    ]),
    null,
  );

// 20 bytes as lowercase hex in ten groups of four, as people compare them.
const grouped = (bytes: Uint8Array): string => sodium.to_hex(bytes).replace(/(.{4})(?!$)/g, '$1 ');

/**
 * A short digest of a public identity, for example "3f9a 0c1e …", shown in
 * contact details and in the key-change warning.
 */
export const fingerprint = (identity: PublicIdentity): string =>
  grouped(fingerprintBytes(identity));

/**
 * What a person and their new agent's CLI compare at enrollment (section
 * 9.2). It covers both parties' keys, and the agent ID derived from them, so
 * each side's copy differs if the server swapped either side's keys.
 */
export function enrollmentFingerprint({
  installationId,
  owner,
  agent,
}: {
  installationId: InstallationId;
  owner: PublicIdentity;
  agent: Pick<PublicIdentity, 'boxPublicKey' | 'signPublicKey'>;
}): string {
  const agentId = agentIdentityId({ installationId, ownerId: owner.id, ...agent });
  return grouped(
    sodium.crypto_generichash(
      20,
      canonical('agent-enrollment-check/v1', [
        installationId,
        owner.id,
        owner.keyVersion,
        fromBase64(owner.boxPublicKey),
        fromBase64(owner.signPublicKey),
        agentId,
        fromBase64(agent.boxPublicKey),
        fromBase64(agent.signPublicKey),
      ]),
      null,
    ),
  );
}

/** A full agent ID: `agent-` and a canonical 32-byte hash, not just the prefix. */
export const isAgentId = (id: string): boolean => AGENT_ID.test(id);

/**
 * The hash that binds one exact key of one identity into signed data, such as
 * an owner statement. Always computed at the reference's own key version.
 */
export const keyHash = (identity: PublicIdentity): string =>
  hash(
    canonical('identity-key-hash/v1', [
      identity.id,
      identity.kind,
      identity.keyVersion,
      fromBase64(identity.boxPublicKey),
      fromBase64(identity.signPublicKey),
    ]),
  );

export const identityRef = (identity: PublicIdentity): IdentityRef => ({
  id: identity.id,
  keyVersion: identity.keyVersion,
  keyHash: keyHash(identity),
});

// 32 bytes of 0x01, clamped. Any fixed clamped scalar shows a low-order key:
// multiplying one gives all zeros, which libsodium refuses.
const PROBE_SCALAR = new Uint8Array(32).fill(1);
PROBE_SCALAR[0] = 0;
PROBE_SCALAR[31] = 0x41;

/**
 * X25519 keys must be canonical: top bit clear, and below 2^255 - 19 as a
 * little-endian integer. Otherwise one key has several encodings, and so
 * several key hashes, fingerprints and agent IDs.
 */
function isCanonicalX25519(key: Uint8Array): boolean {
  if (key.length !== 32 || (key[31] ?? 0) & 0x80) return false;
  // p = 2^255 - 19 is 0xed, then thirty 0xff, then 0x7f, little-endian.
  if (key[31] !== 0x7f || key.subarray(1, 31).some((byte) => byte !== 0xff)) return true;
  return (key[0] ?? 0) < 0xed;
}

function isUsableX25519(key: Uint8Array): boolean {
  if (!isCanonicalX25519(key)) return false;
  try {
    return sodium.crypto_scalarmult(PROBE_SCALAR, key).some((byte) => byte !== 0);
  } catch {
    return false;
  }
}

/**
 * Refuse public keys that libraries disagree about: a non-canonical or
 * low-order X25519 key, or an Ed25519 key that isn't a canonical point of
 * prime order. libsodium's verify accepts some signatures under a mixed-order
 * Ed25519 key, so this check is what keeps such a key out. Throws `bad-key`.
 */
export function requireUsableKeys(
  keys: Pick<PublicIdentity, 'boxPublicKey' | 'signPublicKey'>,
): void {
  if (!isUsableX25519(fromBase64(keys.boxPublicKey))) {
    throw new CryptoError('bad-key', 'The X25519 key is non-canonical or of low order');
  }
  if (!sodium.crypto_core_ed25519_is_valid_point(fromBase64(keys.signPublicKey))) {
    throw new CryptoError('bad-key', 'The Ed25519 key is not a valid prime-order point');
  }
}

/** Whether the secret keys really belong to the public identity they came with. */
export function hasMatchingKeys(identity: PrivateIdentity): boolean {
  // Derive from the seed: the secret key's trailing bytes are just a copy of
  // the public key, so reading them back would prove nothing.
  const seed = sodium.crypto_sign_ed25519_sk_to_seed(identity.signSecretKey);
  const signPublic = sodium.crypto_sign_seed_keypair(seed).publicKey;
  const boxPublic = sodium.crypto_scalarmult_base(identity.boxSecretKey);
  return (
    toBase64(signPublic) === identity.public.signPublicKey &&
    toBase64(boxPublic) === identity.public.boxPublicKey
  );
}

export function sameKeys(a: PublicIdentity, b: PublicIdentity): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.keyVersion === b.keyVersion &&
    a.boxPublicKey === b.boxPublicKey &&
    a.signPublicKey === b.signPublicKey
  );
}

export function sign(signer: PrivateIdentity, message: Uint8Array): string {
  return toBase64(sodium.crypto_sign_detached(message, signer.signSecretKey));
}

export function verifySignature(
  signer: PublicIdentity,
  message: Uint8Array,
  signature: string,
): boolean {
  try {
    return sodium.crypto_sign_verify_detached(
      fromBase64(signature),
      message,
      fromBase64(signer.signPublicKey),
    );
  } catch {
    return false;
  }
}

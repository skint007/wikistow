// Identity key rotation's part of the cross-platform vectors (protocol
// section 4.6, see generate-vectors.ts): one person's keys at versions 1 to
// 3, the two rotation statements between them with their signed bytes, and
// the person's format 2 vault, holding key version 3 with 1 and 2 retired.
import {
  AccountId,
  canonical,
  createRotatedVault,
  generateIdentity,
  hash,
  IdentityId,
  identityRotationBytes,
  InstallationId,
  keyHash,
  signIdentityRotation,
  toBase64,
  utf8,
  type PrivateIdentity,
} from '../src/index.ts';
import { sodium } from '../src/sodium.ts';

const exportIdentity = (identity: PrivateIdentity) => ({
  public: identity.public,
  boxSecretKey: toBase64(identity.boxSecretKey),
  signSecretKey: toBase64(identity.signSecretKey),
});

const hex = (bytes: Uint8Array) => sodium.to_hex(bytes);

/** The section's keys from the current file, kept so a regeneration moves only what changed. */
export type RotationPrevious = { keys: PrivateIdentity[] };

export function rotationVectors(previous?: RotationPrevious) {
  const installationId = InstallationId.parse('vector-installation');
  const id = IdentityId.parse('vector-rotating');
  const keys =
    previous?.keys ??
    [1, 2, 3].map((keyVersion) => generateIdentity({ kind: 'human', id, keyVersion }));
  const [k1, k2, k3] = keys as [PrivateIdentity, PrivateIdentity, PrivateIdentity];
  // A person with no contacts record yet rotates from key version 1; their
  // second rotation names the version their record had reached.
  const first = signIdentityRotation({ installationId, from: k1, to: k2, contacts: null });
  // Stands in for that version's `contactsHash`, which is any Hash32 here.
  const contacts = { version: 3, contactsHash: hash(utf8('vector contacts version 3')) };
  const second = signIdentityRotation({ installationId, from: k2, to: k3, contacts });
  const accountId = AccountId.parse('vector-account');
  const passphrase = 'vector rotated passphrase';
  const vault = createRotatedVault({
    accountId,
    identity: k3,
    retired: [k1, k2],
    passphrase,
    kdf: {
      opsLimit: sodium.crypto_pwhash_OPSLIMIT_MIN,
      memLimit: sodium.crypto_pwhash_MEMLIMIT_MIN,
    },
  });
  return {
    keys: keys.map(exportIdentity),
    keyHashes: keys.map((key) => keyHash(key.public)),
    statements: [first, second].map((statement) => ({
      statement,
      signedBytes: hex(identityRotationBytes(statement)),
    })),
    vault: {
      wrapper: vault.wrapper,
      passphrase,
      recoveryKey: vault.recoveryKey,
      keyringAd: hex(canonical('vault-keyring/v2', [accountId])),
    },
  };
}

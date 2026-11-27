import {
  VaultWrapper,
  VaultWrapperV1,
  VaultWrapperV2,
  ServedVaultWrapper,
} from '@wikistow/contracts';
import { z } from 'zod';
import {
  aeadDecrypt,
  aeadEncrypt,
  Base64,
  canonical,
  fromBase64,
  parseJson,
  parseWith,
  toBase64,
  utf8,
} from './encoding.ts';
import { CryptoError } from './errors.ts';
import { hasMatchingKeys, PublicIdentity, type PrivateIdentity } from './identity.ts';
import { AccountId } from './ids.ts';
import { sodium } from './sodium.ts';

/**
 * Argon2id cost, stored with the passphrase wrapper so it can be raised later.
 * Bounded by libsodium's documented range and checked whenever the passphrase
 * wrapper is written or used, so a vault can't be written that won't open and
 * a server can't make an unlock hang for hours. A lower cost can't be slipped
 * in either: the parameters are bound into the wrapper's associated data.
 */
export const KdfParams = z.object({
  opsLimit: z
    .number()
    .int()
    .min(sodium.crypto_pwhash_OPSLIMIT_MIN)
    .max(sodium.crypto_pwhash_OPSLIMIT_SENSITIVE),
  memLimit: z
    .number()
    .int()
    .min(sodium.crypto_pwhash_MEMLIMIT_MIN)
    .max(sodium.crypto_pwhash_MEMLIMIT_SENSITIVE),
});
export type KdfParams = z.infer<typeof KdfParams>;

/**
 * Placeholder until per-client calibration exists. Derivation should run off
 * the interface thread, and a memory failure must surface as `kdf-failed`
 * rather than retrying with weaker settings.
 */
export const DEFAULT_KDF: KdfParams = {
  opsLimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
  memLimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
};

/**
 * The shortest passphrase accepted for anything Argon2id protects at
 * `DEFAULT_KDF`: the vault, and the CLI's key file.
 */
export const MIN_PASSPHRASE = 12;

export { VaultWrapper, VaultWrapperV1, VaultWrapperV2, ServedVaultWrapper };

const Keyring = z.object({ public: PublicIdentity, boxSecretKey: Base64, signSecretKey: Base64 });

// Format 2's keyring (section 4.6) parses strictly, its keys included.
const KeyringKey = z.strictObject({
  public: z.strictObject(PublicIdentity.shape),
  boxSecretKey: Base64,
  signSecretKey: Base64,
});
const KeyringV2 = z.strictObject({
  format: z.literal(2),
  ...KeyringKey.shape,
  retired: z.array(KeyringKey),
});
const KEYRING_V2_INTEGERS = [
  ['format'],
  ['public', 'keyVersion'],
  ['retired', '*', 'public', 'keyVersion'],
] as const;

/**
 * The wrapper formats this version unlocks. Format 2 is built (section
 * 4.6), but this version can't yet open what a person's earlier keys hold or
 * check the chain to their new key, so it asks to update, as for any newer
 * format, until it can (#327).
 */
export const UNLOCKED_FORMATS: readonly number[] = [1];

/** Whether this version unlocks `wrapper`, and so whether a device should keep it to unlock offline. */
export const unlocks = (wrapper: { format: number }): boolean =>
  UNLOCKED_FORMATS.includes(wrapper.format);

/**
 * What unlocks a vault: the passphrase, the recovery key, or the vault key
 * itself, which the desktop app keeps in the system's secret store when the
 * person asks it to remember the unlock, and a browser tab keeps sealed for
 * its next load. A passphrase change leaves the vault
 * key as it was, so a remembered one keeps working until it is forgotten.
 */
export type VaultSecret =
  | { kind: 'passphrase'; passphrase: string }
  | { kind: 'recovery-key'; recoveryKey: string }
  | { kind: 'vault-key'; vaultKey: Uint8Array };

/**
 * An unlocked vault, held in memory. Never persist `vaultKey`, except behind
 * the operating system's secret store or, for a browser tab's refresh, sealed
 * under a non-extractable key (`VaultSecret`, `vault-key`).
 */
export type UnlockedVault = {
  accountId: AccountId;
  identity: PrivateIdentity;
  /**
   * The person's earlier keys, after they replaced their keys, in ascending
   * key version: for opening what was sealed to them, never for sealing or
   * signing (section 4.6). Empty for a format 1 vault.
   */
  retired: readonly PrivateIdentity[];
  vaultKey: Uint8Array;
};

const keyringAd = (accountId: AccountId) => canonical('vault-keyring/v1', [accountId]);
const keyringV2Ad = (accountId: AccountId) => canonical('vault-keyring/v2', [accountId]);
const passphraseAd = (accountId: AccountId, salt: string, kdf: KdfParams) =>
  canonical('vault-passphrase-wrap/v1', [accountId, salt, kdf.opsLimit, kdf.memLimit]);
const recoveryAd = (accountId: AccountId) => canonical('vault-recovery-wrap/v1', [accountId]);

/**
 * Create a vault for a freshly generated identity. Show `recoveryKey` once
 * and have the person confirm they saved it; it is not stored anywhere.
 */
export function createVault({
  accountId,
  identity,
  passphrase,
  kdf = DEFAULT_KDF,
}: {
  accountId: AccountId;
  identity: PrivateIdentity;
  passphrase: string;
  kdf?: KdfParams;
}): { wrapper: VaultWrapperV1; recoveryKey: string; vault: UnlockedVault } {
  const keyring = utf8(
    JSON.stringify({
      public: identity.public,
      boxSecretKey: toBase64(identity.boxSecretKey),
      signSecretKey: toBase64(identity.signSecretKey),
    } satisfies z.input<typeof Keyring>),
  );
  const made = sealVault({ accountId, keyring, ad: keyringAd(accountId), passphrase, kdf });
  return {
    wrapper: { format: 1, ...made.wrapper },
    recoveryKey: made.recoveryKey,
    vault: { accountId, identity, retired: [], vaultKey: made.vaultKey },
  };
}

/**
 * Create the format 2 vault of a person who replaces their keys (section
 * 4.6): a new vault key, passphrase and recovery key, and a keyring holding
 * `identity`, their new keys, and `retired`, every earlier key, in ascending
 * key version. Show `recoveryKey` once, as at setup.
 */
export function createRotatedVault({
  accountId,
  identity,
  retired,
  passphrase,
  kdf = DEFAULT_KDF,
}: {
  accountId: AccountId;
  identity: PrivateIdentity;
  retired: readonly PrivateIdentity[];
  passphrase: string;
  kdf?: KdfParams;
}): { wrapper: VaultWrapperV2; recoveryKey: string; vault: UnlockedVault } {
  const exported = (key: PrivateIdentity) => ({
    public: key.public,
    boxSecretKey: toBase64(key.boxSecretKey),
    signSecretKey: toBase64(key.signSecretKey),
  });
  const plain = {
    format: 2,
    ...exported(identity),
    retired: retired.map(exported),
  } satisfies z.input<typeof KeyringV2>;
  // What `unlockVault` would refuse is never sealed.
  const opened = readKeyringV2(parseWith(KeyringV2, plain, 'Keyring'));
  const keyring = utf8(JSON.stringify(plain));
  const made = sealVault({ accountId, keyring, ad: keyringV2Ad(accountId), passphrase, kdf });
  return {
    wrapper: { format: 2, ...made.wrapper },
    recoveryKey: made.recoveryKey,
    vault: { accountId, ...opened, vaultKey: made.vaultKey },
  };
}

// A new vault key sealing `keyring`, and its passphrase and recovery wraps.
function sealVault({
  accountId,
  keyring,
  ad,
  passphrase,
  kdf,
}: {
  accountId: AccountId;
  keyring: Uint8Array;
  ad: Uint8Array;
  passphrase: string;
  kdf: KdfParams;
}) {
  const vaultKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const recoveryBytes = sodium.randombytes_buf(32);
  return {
    vaultKey,
    recoveryKey: formatRecoveryKey(recoveryBytes),
    wrapper: {
      accountId,
      keyring: aeadEncrypt({ key: vaultKey, plaintext: keyring, ad }),
      passphrase: wrapWithPassphrase({ accountId, vaultKey, passphrase, kdf }),
      recovery: aeadEncrypt({
        key: recoveryKek(recoveryBytes),
        plaintext: vaultKey,
        ad: recoveryAd(accountId),
      }),
    },
  };
}

const privateKey = (key: z.infer<typeof KeyringKey>): PrivateIdentity => ({
  public: key.public,
  boxSecretKey: fromBase64(key.boxSecretKey),
  signSecretKey: fromBase64(key.signSecretKey),
});

// Whether the secret keys are the public keys', without throwing for a
// secret key of the wrong length. libsodium signs with the copy of the
// public key the signing secret key ends with, so that copy must match too,
// or the key would make signatures that don't verify.
function matches(key: PrivateIdentity): boolean {
  const { boxSecretKey, signSecretKey } = key;
  if (boxSecretKey.length !== 32 || signSecretKey.length !== 64) return false;
  if (toBase64(signSecretKey.subarray(32)) !== key.public.signPublicKey) return false;
  try {
    return hasMatchingKeys(key);
  } catch {
    return false;
  }
}

/**
 * A format 2 keyring's keys, once its rules hold (section 4.6): a person's
 * keys, `retired` holding exactly one earlier key for each key version
 * below the current one, in ascending order, each of the same ID, and every
 * secret key matching its public key. Anything else is `malformed`.
 */
function readKeyringV2(keyring: z.infer<typeof KeyringV2>): {
  identity: PrivateIdentity;
  retired: PrivateIdentity[];
} {
  const identity = privateKey(keyring);
  const retired = keyring.retired.map(privateKey);
  const { id, keyVersion } = identity.public;
  const keys = [...retired, identity];
  if (retired.length !== keyVersion - 1) {
    throw new CryptoError('malformed', 'The keyring holds one earlier key for each key version');
  }
  for (const [index, key] of keys.entries()) {
    if (
      key.public.id !== id ||
      key.public.kind !== 'human' ||
      key.public.keyVersion !== index + 1
    ) {
      throw new CryptoError(
        'malformed',
        'The keyring’s earlier keys are not this person’s, in order',
      );
    }
    if (!matches(key)) {
      throw new CryptoError('malformed', 'A secret key in the keyring is not its public key’s');
    }
  }
  return { identity, retired };
}

/**
 * Unlock with either secret. `wrapper` comes from the server, so it is
 * parsed here. A wrapper of a format not in `formats` (by default, those this
 * version unlocks) is refused as `unsupported-format`, before any secret is
 * used: the app asks to update.
 */
export function unlockVault({
  wrapper: raw,
  secret,
  formats = UNLOCKED_FORMATS,
}: {
  wrapper: unknown;
  secret: VaultSecret;
  formats?: readonly number[];
}): UnlockedVault {
  const format = typeof raw === 'object' && raw !== null && 'format' in raw ? raw.format : null;
  if (typeof format === 'number' && Number.isInteger(format) && !formats.includes(format)) {
    throw new CryptoError('unsupported-format', 'This vault is in a newer format. Update the app');
  }
  const parsed = VaultWrapper.safeParse(raw);
  if (!parsed.success)
    throw new CryptoError('malformed', 'Vault wrapper has an invalid shape', {
      cause: parsed.error,
    });
  const wrapper = parsed.data;
  const { accountId } = wrapper;

  const vaultKey =
    secret.kind === 'vault-key'
      ? new Uint8Array(secret.vaultKey)
      : secret.kind === 'passphrase'
        ? aeadDecrypt({
            key: passphraseKek(
              secret.passphrase,
              fromBase64(wrapper.passphrase.salt),
              requireKdf(wrapper.passphrase.kdf),
            ),
            sealed: wrapper.passphrase,
            ad: passphraseAd(accountId, wrapper.passphrase.salt, wrapper.passphrase.kdf),
          })
        : aeadDecrypt({
            key: recoveryKek(parseRecoveryKey(secret.recoveryKey)),
            sealed: wrapper.recovery,
            ad: recoveryAd(accountId),
          });

  if (wrapper.format === 2) {
    const keyring = parseJson(
      KeyringV2,
      aeadDecrypt({ key: vaultKey, sealed: wrapper.keyring, ad: keyringV2Ad(accountId) }),
      'Keyring',
      { integers: KEYRING_V2_INTEGERS },
    );
    return { accountId, vaultKey, ...readKeyringV2(keyring) };
  }
  const keyring = parseJson(
    Keyring,
    aeadDecrypt({ key: vaultKey, sealed: wrapper.keyring, ad: keyringAd(accountId) }),
    'Keyring',
    { integers: [['public', 'keyVersion']] },
  );
  return {
    accountId,
    vaultKey,
    identity: {
      public: keyring.public,
      boxSecretKey: fromBase64(keyring.boxSecretKey),
      signSecretKey: fromBase64(keyring.signSecretKey),
    },
    retired: [],
  };
}

/**
 * Replace only the passphrase wrapper, from any unlocked session (including
 * one unlocked by the recovery key), keeping the wrapper's format. Documents
 * are not re-encrypted. A format this version doesn't know is
 * `unsupported-format`.
 */
export function changePassphrase({
  vault,
  wrapper,
  passphrase,
  kdf = DEFAULT_KDF,
}: {
  vault: UnlockedVault;
  wrapper: ServedVaultWrapper;
  passphrase: string;
  kdf?: KdfParams;
}): VaultWrapper {
  const known = VaultWrapper.safeParse(wrapper);
  if (!known.success) {
    throw new CryptoError('unsupported-format', 'This vault is in a newer format. Update the app');
  }
  return {
    ...known.data,
    passphrase: wrapWithPassphrase({
      accountId: vault.accountId,
      vaultKey: vault.vaultKey,
      passphrase,
      kdf,
    }),
  };
}

function wrapWithPassphrase({
  accountId,
  vaultKey,
  passphrase,
  kdf,
}: {
  accountId: AccountId;
  vaultKey: Uint8Array;
  passphrase: string;
  kdf: KdfParams;
}): VaultWrapper['passphrase'] {
  // TextEncoder would turn a lone surrogate into U+FFFD, so two passphrases
  // would derive one key. Only new ones are refused: unlocking is unchanged,
  // so a wrapper made before this check still opens.
  if (!passphrase.isWellFormed()) {
    throw new CryptoError('malformed', 'The passphrase is not well-formed Unicode');
  }
  requireKdf(kdf);
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const saltText = toBase64(salt);
  const sealed = aeadEncrypt({
    key: passphraseKek(passphrase, salt, kdf),
    plaintext: vaultKey,
    ad: passphraseAd(accountId, saltText, kdf),
  });
  return { ...sealed, salt: saltText, kdf };
}

function requireKdf(kdf: unknown): KdfParams {
  const parsed = KdfParams.safeParse(kdf);
  if (!parsed.success) {
    throw new CryptoError('malformed', 'Unsupported passphrase KDF settings', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * A 32-byte key from a passphrase, with Argon2id at `kdf`, which is checked
 * first: the vault's own derivation, for other local files that a passphrase
 * protects, such as the CLI's key file. Give each use its own associated
 * data, binding the salt and `kdf`, as the vault's passphrase wrapper does.
 */
export function passphraseKey({
  passphrase,
  salt,
  kdf,
}: {
  passphrase: string;
  salt: Uint8Array;
  kdf: unknown;
}): Uint8Array {
  if (salt.length !== sodium.crypto_pwhash_SALTBYTES) {
    throw new CryptoError('malformed', 'A passphrase salt is 16 bytes');
  }
  return passphraseKek(passphrase, salt, requireKdf(kdf));
}

function passphraseKek(passphrase: string, salt: Uint8Array, kdf: KdfParams): Uint8Array {
  try {
    return sodium.crypto_pwhash(
      32,
      passphrase,
      salt,
      kdf.opsLimit,
      kdf.memLimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
  } catch (cause) {
    throw new CryptoError(
      'kdf-failed',
      'Passphrase key derivation failed, possibly out of memory',
      { cause },
    );
  }
}

// The recovery key is already 256 random bits, so a fast KDF with its own
// context is enough; Argon2 would add cost without adding strength.
const recoveryKek = (recoveryKey: Uint8Array) =>
  sodium.crypto_kdf_derive_from_key(32, 1, 'wsrecov1', recoveryKey);

/** 64 hex digits in groups of four, for writing down or printing. */
const formatRecoveryKey = (bytes: Uint8Array) =>
  sodium.to_hex(bytes).match(/.{4}/g)?.join('-') ?? '';

function parseRecoveryKey(text: string): Uint8Array {
  const hex = text.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 64) throw new CryptoError('malformed', 'A recovery key has 64 hex digits');
  return sodium.from_hex(hex);
}

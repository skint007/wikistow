import { VaultWrapper } from '@wikistow/contracts';
import { z } from 'zod';
import {
  aeadDecrypt,
  aeadEncrypt,
  Base64,
  canonical,
  fromBase64,
  parseJson,
  toBase64,
  utf8,
} from './encoding.ts';
import { CryptoError } from './errors.ts';
import { PublicIdentity, type PrivateIdentity } from './identity.ts';
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

export { VaultWrapper };

const Keyring = z.object({ public: PublicIdentity, boxSecretKey: Base64, signSecretKey: Base64 });

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
  vaultKey: Uint8Array;
};

const keyringAd = (accountId: AccountId) => canonical('vault-keyring/v1', [accountId]);
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
}): { wrapper: VaultWrapper; recoveryKey: string; vault: UnlockedVault } {
  const vaultKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const recoveryBytes = sodium.randombytes_buf(32);
  const keyring = utf8(
    JSON.stringify({
      public: identity.public,
      boxSecretKey: toBase64(identity.boxSecretKey),
      signSecretKey: toBase64(identity.signSecretKey),
    } satisfies z.input<typeof Keyring>),
  );
  const wrapper: VaultWrapper = {
    format: 1,
    accountId,
    keyring: aeadEncrypt({ key: vaultKey, plaintext: keyring, ad: keyringAd(accountId) }),
    passphrase: wrapWithPassphrase({ accountId, vaultKey, passphrase, kdf }),
    recovery: aeadEncrypt({
      key: recoveryKek(recoveryBytes),
      plaintext: vaultKey,
      ad: recoveryAd(accountId),
    }),
  };
  return {
    wrapper,
    recoveryKey: formatRecoveryKey(recoveryBytes),
    vault: { accountId, identity, vaultKey },
  };
}

/** Unlock with either secret. `wrapper` comes from the server, so it is parsed here. */
export function unlockVault({
  wrapper: raw,
  secret,
}: {
  wrapper: unknown;
  secret: VaultSecret;
}): UnlockedVault {
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
  };
}

/**
 * Replace only the passphrase wrapper, from any unlocked session (including
 * one unlocked by the recovery key). Documents are not re-encrypted.
 */
export function changePassphrase({
  vault,
  wrapper,
  passphrase,
  kdf = DEFAULT_KDF,
}: {
  vault: UnlockedVault;
  wrapper: VaultWrapper;
  passphrase: string;
  kdf?: KdfParams;
}): VaultWrapper {
  return {
    ...wrapper,
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

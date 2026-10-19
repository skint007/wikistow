// The agent's key file (wikistow.md, Desktop and CLI): its own keys, its
// bearer token, the person it pinned at enrollment and the key to its local
// state, encrypted under one data key. The data key is wrapped by the
// passphrase with Argon2id, the vault's own derivation, and also by a
// random secret kept in an OS secret store, when one is configured.
import {
  aeadDecrypt,
  aeadEncrypt,
  Base64,
  canonical,
  CryptoError,
  DEFAULT_KDF,
  fromBase64,
  hashBytes,
  hasMatchingKeys,
  KdfParams,
  MIN_PASSPHRASE,
  parseJson,
  passphraseKey,
  PublicIdentity,
  Sealed,
  toBase64,
  utf8,
  type PrivateIdentity,
} from '@wikistow/client';
import { AgentId, HumanId, InstallationId } from '@wikistow/contracts';
import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import { z } from 'zod';
import { CliError } from './exit.ts';

export const KEY_FILE_FORMAT = 1;

/** Where an OS secret store keeps this key file's unlock secret. */
const StoreWrap = Sealed.extend({
  /** The program that reads it, as configured: secret-tool, macOS's security or Windows PowerShell. */
  tool: z.string().refine((tool) => win32.isAbsolute(tool)),
  service: z.literal('wikistow'),
  account: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});
export type StoreWrap = z.infer<typeof StoreWrap>;

/** The file on disk. Everything outside `secrets` is bound into its associated data. */
export const KeyFile = z.strictObject({
  format: z.literal(KEY_FILE_FORMAT),
  server: z.string().regex(/^https?:\/\/[^\s/?#]+$/),
  agentId: AgentId,
  passphrase: Sealed.extend({ salt: Base64, kdf: KdfParams }),
  secretStore: StoreWrap.nullable(),
  secrets: Sealed,
});
export type KeyFile = z.infer<typeof KeyFile>;

const KEY_FILE_INTEGERS = [
  ['format'],
  ['passphrase', 'kdf', 'opsLimit'],
  ['passphrase', 'kdf', 'memLimit'],
];

const SecretsJson = z.strictObject({
  installationId: InstallationId,
  identity: z.strictObject({ public: PublicIdentity, boxSecretKey: Base64, signSecretKey: Base64 }),
  person: PublicIdentity.refine((person) => HumanId.safeParse(person.id).success),
  token: z.string().regex(/^wsa_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/),
  stateKey: Base64,
});

/** What the key file holds once it is open. */
export type Secrets = {
  installationId: InstallationId;
  identity: PrivateIdentity;
  /** The person this agent acts for, at the key it pinned at enrollment. */
  person: PublicIdentity;
  token: string;
  /** Encrypts and authenticates the local state (`state.ts`). */
  stateKey: Uint8Array;
};

/** How the key file is being opened. */
export type Unlock =
  | { kind: 'passphrase'; passphrase: string }
  | { kind: 'secret-store'; secret: Uint8Array };

const secretsAd = (file: Pick<KeyFile, 'server' | 'agentId'>) =>
  canonical('cli-key-file/v1', [KEY_FILE_FORMAT, file.server, file.agentId]);
const passphraseAd = (file: Pick<KeyFile, 'server' | 'agentId'>, salt: string, kdf: KdfParams) =>
  canonical('cli-key-passphrase-wrap/v1', [
    file.server,
    file.agentId,
    salt,
    kdf.opsLimit,
    kdf.memLimit,
  ]);
const storeAd = (file: Pick<KeyFile, 'server' | 'agentId'>, store: Omit<StoreWrap, keyof Sealed>) =>
  canonical('cli-key-store-wrap/v1', [
    file.server,
    file.agentId,
    store.tool,
    store.service,
    store.account,
  ]);
// The store's secret is 32 random bytes already: a hash with its own
// domain is key enough, as with the vault's recovery key.
const storeKek = (secret: Uint8Array) => hashBytes(canonical('cli-key-store-kek/v1', [secret]));

/**
 * Refuse a passphrase too short to protect the key file. It holds keys that
 * open everything ever sealed to the agent, and a copy of it can be guessed
 * at offline, so it takes as long a one as the vault.
 */
export function checkNewPassphrase(passphrase: string): void {
  if (!passphrase.isWellFormed() || passphrase.length < MIN_PASSPHRASE) {
    throw new CliError('usage', `Use a passphrase of at least ${MIN_PASSPHRASE} characters`);
  }
}

function wrapWithPassphrase(
  header: Pick<KeyFile, 'server' | 'agentId'>,
  dataKey: Uint8Array,
  passphrase: string,
  kdf: KdfParams,
): KeyFile['passphrase'] {
  checkNewPassphrase(passphrase);
  const salt = randomBytes(16);
  const saltText = toBase64(salt);
  const sealed = aeadEncrypt({
    key: passphraseKey({ passphrase, salt, kdf }),
    plaintext: dataKey,
    ad: passphraseAd(header, saltText, kdf),
  });
  return { ...sealed, salt: saltText, kdf };
}

/** A new key file for `secrets`, opened by `passphrase`. */
export function createKeyFile({
  server,
  secrets,
  passphrase,
  kdf = DEFAULT_KDF,
}: {
  server: string;
  secrets: Secrets;
  passphrase: string;
  kdf?: KdfParams;
}): KeyFile {
  const header = { server, agentId: AgentId.parse(secrets.identity.public.id) };
  const dataKey = randomBytes(32);
  const json = {
    installationId: secrets.installationId,
    identity: {
      public: secrets.identity.public,
      boxSecretKey: toBase64(secrets.identity.boxSecretKey),
      signSecretKey: toBase64(secrets.identity.signSecretKey),
    },
    person: secrets.person,
    token: secrets.token,
    stateKey: toBase64(secrets.stateKey),
  } satisfies z.input<typeof SecretsJson>;
  const file = KeyFile.parse({
    format: KEY_FILE_FORMAT,
    ...header,
    passphrase: wrapWithPassphrase(header, dataKey, passphrase, kdf),
    secretStore: null,
    secrets: aeadEncrypt({
      key: dataKey,
      plaintext: utf8(JSON.stringify(json)),
      ad: secretsAd(header),
    }),
  });
  dataKey.fill(0);
  return file;
}

/** The file's bytes as written: JSON from a serializer, never joined strings. */
export const keyFileBytes = (file: KeyFile): Uint8Array =>
  utf8(`${JSON.stringify(file, null, 2)}\n`);

/** Parse a key file read from disk. Anything else is a key file this CLI can't use. */
export function parseKeyFile(bytes: Uint8Array): KeyFile {
  try {
    return parseJson(KeyFile, bytes, 'Key file', { integers: KEY_FILE_INTEGERS });
  } catch (cause) {
    throw new CliError('locked', 'The key file is damaged or from a newer CLI', { cause });
  }
}

/** The data key, from whichever secret `unlock` holds. */
function openDataKey(file: KeyFile, unlock: Unlock): Uint8Array {
  try {
    if (unlock.kind === 'passphrase') {
      const { salt, kdf } = file.passphrase;
      return aeadDecrypt({
        key: passphraseKey({ passphrase: unlock.passphrase, salt: fromBase64(salt), kdf }),
        sealed: file.passphrase,
        ad: passphraseAd(file, salt, kdf),
      });
    }
    if (!file.secretStore) throw new CliError('locked', 'No secret store is configured');
    return aeadDecrypt({
      key: storeKek(unlock.secret),
      sealed: file.secretStore,
      ad: storeAd(file, file.secretStore),
    });
  } catch (error) {
    if (error instanceof CryptoError && error.code === 'decrypt-failed') {
      throw new CliError(
        'wrong-passphrase',
        unlock.kind === 'passphrase'
          ? 'Wrong passphrase'
          : 'The secret store’s unlock secret does not open the key file',
      );
    }
    throw error;
  }
}

/** Open the key file. A wrong secret is `wrong-passphrase`; a changed file can't open either. */
export function openKeyFile(
  file: KeyFile,
  unlock: Unlock,
): { secrets: Secrets; dataKey: Uint8Array } {
  const dataKey = openDataKey(file, unlock);
  let json: z.infer<typeof SecretsJson>;
  try {
    json = parseJson(
      SecretsJson,
      aeadDecrypt({ key: dataKey, sealed: file.secrets, ad: secretsAd(file) }),
      'Key file secrets',
      {
        integers: [
          ['identity', 'public', 'keyVersion'],
          ['person', 'keyVersion'],
        ],
      },
    );
  } catch (cause) {
    throw new CliError('locked', 'The key file is damaged', { cause });
  }
  const identity: PrivateIdentity = {
    public: json.identity.public,
    boxSecretKey: fromBase64(json.identity.boxSecretKey),
    signSecretKey: fromBase64(json.identity.signSecretKey),
  };
  if (identity.public.id !== file.agentId || !hasMatchingKeys(identity)) {
    throw new CliError('locked', 'The key file’s keys do not match it');
  }
  return {
    dataKey,
    secrets: {
      installationId: json.installationId,
      identity,
      person: json.person,
      token: json.token,
      stateKey: fromBase64(json.stateKey),
    },
  };
}

/** The key file, also opened by `secret` from an OS secret store at `store`. */
export function withSecretStore(
  file: KeyFile,
  dataKey: Uint8Array,
  store: Omit<StoreWrap, keyof Sealed>,
  secret: Uint8Array,
): KeyFile {
  const sealed = aeadEncrypt({
    key: storeKek(secret),
    plaintext: dataKey,
    ad: storeAd(file, store),
  });
  return KeyFile.parse({ ...file, secretStore: { ...sealed, ...store } });
}

/** The key file, opened by its passphrase alone. */
export const withoutSecretStore = (file: KeyFile): KeyFile => ({ ...file, secretStore: null });

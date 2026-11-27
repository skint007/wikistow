import { describe, expect, it } from 'vite-plus/test';
import {
  AccountId,
  aeadEncrypt,
  canonical,
  changePassphrase,
  createApiClient,
  createRotatedVault,
  createVault,
  generateIdentity,
  IdentityId,
  inlineVaultCrypto,
  keepWrapper,
  keptUnlock,
  memoryKeptStore,
  openVault,
  ServedVaultWrapper,
  toBase64,
  UNLOCKED_FORMATS,
  unlockVault,
  utf8,
  type PrivateIdentity,
} from '../src/index.ts';
import { buildWorld, FAST_KDF, MARKERS } from './fixture/world.ts';

describe('vault unlocking', () => {
  const world = buildWorld();
  const { server, owner, ownerAccount, ownerVault } = world;
  const wrapper = () => server.vaults.get(ownerAccount);

  it('recovers the same keyring from the passphrase and from the recovery key, independently', () => {
    const viaPassphrase = unlockVault({
      wrapper: wrapper(),
      secret: { kind: 'passphrase', passphrase: MARKERS.ownerPassphrase },
    });
    const viaRecovery = unlockVault({
      wrapper: wrapper(),
      secret: { kind: 'recovery-key', recoveryKey: ownerVault.recoveryKey },
    });
    for (const unlocked of [viaPassphrase, viaRecovery]) {
      expect(unlocked.identity.public).toEqual(owner.identity.public);
      expect(unlocked.identity.boxSecretKey).toEqual(owner.identity.boxSecretKey);
      expect(unlocked.identity.signSecretKey).toEqual(owner.identity.signSecretKey);
    }
  });

  it('sets a new passphrase after recovery without changing the keyring', () => {
    const recovered = unlockVault({
      wrapper: ownerVault.wrapper,
      secret: { kind: 'recovery-key', recoveryKey: ownerVault.recoveryKey },
    });
    const next = changePassphrase({
      vault: recovered,
      wrapper: ownerVault.wrapper,
      passphrase: 'fresh passphrase',
      kdf: FAST_KDF,
    });

    expect(next.keyring).toEqual(ownerVault.wrapper.keyring);
    expect(
      unlockVault({ wrapper: next, secret: { kind: 'passphrase', passphrase: 'fresh passphrase' } })
        .identity.public,
    ).toEqual(owner.identity.public);
    expect(() =>
      unlockVault({
        wrapper: next,
        secret: { kind: 'passphrase', passphrase: MARKERS.ownerPassphrase },
      }),
    ).toThrow(expect.objectContaining({ code: 'decrypt-failed' }));
    expect(() =>
      unlockVault({
        wrapper: next,
        secret: { kind: 'recovery-key', recoveryKey: ownerVault.recoveryKey },
      }),
    ).not.toThrow();
  });

  // What the desktop app remembers: the vault key, which outlives passphrase changes.
  it('unlocks with the vault key alone, after a passphrase change too', () => {
    const remembered = unlockVault({
      wrapper: ownerVault.wrapper,
      secret: { kind: 'passphrase', passphrase: MARKERS.ownerPassphrase },
    }).vaultKey;
    const next = changePassphrase({
      vault: ownerVault.vault,
      wrapper: ownerVault.wrapper,
      passphrase: 'another fresh passphrase',
      kdf: FAST_KDF,
    });
    for (const wrapper of [ownerVault.wrapper, next]) {
      const unlocked = unlockVault({
        wrapper,
        secret: { kind: 'vault-key', vaultKey: remembered },
      });
      expect(unlocked.identity.signSecretKey).toEqual(owner.identity.signSecretKey);
    }
  });

  it('still unlocks with a passphrase that is not well-formed', () => {
    const lone = 'cut off \ud83d';
    const identity = generateIdentity({ id: IdentityId.parse('fresh'), kind: 'human' });
    const accountId = AccountId.parse('fresh-account');
    // Encoded, the lone surrogate becomes U+FFFD, as it did for wrappers made before.
    const { wrapper } = createVault({
      accountId,
      identity,
      passphrase: 'cut off \ufffd',
      kdf: FAST_KDF,
    });
    expect(
      unlockVault({ wrapper, secret: { kind: 'passphrase', passphrase: lone } }).identity.public,
    ).toEqual(identity.public);
  });
});

describe('format 2 vaults (section 4.6)', () => {
  const accountId = AccountId.parse('rotated-account');
  const id = IdentityId.parse('rotated-person');
  const keys = [1, 2, 3].map((keyVersion) => generateIdentity({ kind: 'human', id, keyVersion }));
  const [first, second, third] = keys as [PrivateIdentity, PrivateIdentity, PrivateIdentity];
  const passphrase = 'rotated passphrase';
  const made = createRotatedVault({
    accountId,
    identity: third,
    retired: [first, second],
    passphrase,
    kdf: FAST_KDF,
  });
  const both = [1, 2] as const;
  const code = (code: string) => expect.objectContaining({ code });

  it('opens with the passphrase and the recovery key, earlier keys included, where asked', () => {
    for (const secret of [
      { kind: 'passphrase', passphrase },
      { kind: 'recovery-key', recoveryKey: made.recoveryKey },
    ] as const) {
      const vault = unlockVault({ wrapper: made.wrapper, secret, formats: both });
      expect(vault.identity.public).toEqual(third.public);
      expect(vault.identity.signSecretKey).toEqual(third.signSecretKey);
      expect(vault.retired.map((key) => key.public)).toEqual([first.public, second.public]);
      expect(vault.retired[0]?.boxSecretKey).toEqual(first.boxSecretKey);
    }
    expect(made.wrapper.format).toBe(2);
    expect(made.vault.retired).toHaveLength(2);
  });

  // This version can't open what earlier keys hold yet, so it asks to update.
  it('asks to update by default, before any secret is tried', () => {
    expect(UNLOCKED_FORMATS).toEqual([1]);
    expect(() =>
      unlockVault({ wrapper: made.wrapper, secret: { kind: 'passphrase', passphrase: 'wrong' } }),
    ).toThrow(code('unsupported-format'));
    expect(() =>
      unlockVault({
        wrapper: { format: 3, accountId, anything: true },
        secret: { kind: 'passphrase', passphrase },
        formats: both,
      }),
    ).toThrow(code('unsupported-format'));
    expect(() =>
      changePassphrase({
        vault: made.vault,
        wrapper: { format: 3, accountId },
        passphrase: 'new passphrase',
        kdf: FAST_KDF,
      }),
    ).toThrow(code('unsupported-format'));
    expect(ServedVaultWrapper.parse({ format: 3, accountId })).toEqual({ format: 3, accountId });
  });

  it('keeps format 2 through a passphrase change', () => {
    const changed = changePassphrase({
      vault: made.vault,
      wrapper: made.wrapper,
      passphrase: 'a new passphrase for it',
      kdf: FAST_KDF,
    });
    expect(changed).toMatchObject({ format: 2, keyring: made.wrapper.keyring });
    const opened = unlockVault({
      wrapper: changed,
      secret: { kind: 'passphrase', passphrase: 'a new passphrase for it' },
      formats: both,
    });
    expect(opened.retired.map((key) => key.public)).toEqual(
      made.vault.retired.map((key) => key.public),
    );
  });

  it('never opens as the other format', () => {
    const vaultKey = made.vault.vaultKey;
    const secret = { kind: 'vault-key', vaultKey } as const;
    expect(() =>
      unlockVault({ wrapper: { ...made.wrapper, format: 1 }, secret, formats: both }),
    ).toThrow(code('decrypt-failed'));
    const v1 = createVault({ accountId, identity: first, passphrase, kdf: FAST_KDF });
    expect(() =>
      unlockVault({
        wrapper: { ...v1.wrapper, format: 2 },
        secret: { kind: 'vault-key', vaultKey: v1.vault.vaultKey },
        formats: both,
      }),
    ).toThrow(code('decrypt-failed'));
    expect(v1.vault.retired).toEqual([]);
  });

  // A keyring sealed under the vault key as given, to test its rules.
  const sealedKeyring = (plaintext: string) => ({
    ...made.wrapper,
    keyring: aeadEncrypt({
      key: made.vault.vaultKey,
      plaintext: utf8(plaintext),
      ad: canonical('vault-keyring/v2', [accountId]),
    }),
  });
  const open = (plaintext: string) =>
    unlockVault({
      wrapper: sealedKeyring(plaintext),
      secret: { kind: 'vault-key', vaultKey: made.vault.vaultKey },
      formats: both,
    });
  const exported = (key: PrivateIdentity) => ({
    public: key.public,
    boxSecretKey: toBase64(key.boxSecretKey),
    signSecretKey: toBase64(key.signSecretKey),
  });
  const keyring = (changes: Record<string, unknown> = {}) =>
    JSON.stringify({
      format: 2,
      ...exported(third),
      retired: [exported(first), exported(second)],
      ...changes,
    });

  it('keeps the rules of the keyring', () => {
    expect(open(keyring()).retired).toHaveLength(2);
    const refused = {
      missing: { retired: [exported(second)] },
      'out of order': { retired: [exported(second), exported(first)] },
      'another person': {
        retired: [
          exported(
            generateIdentity({ kind: 'human', id: IdentityId.parse('else'), keyVersion: 1 }),
          ),
          exported(second),
        ],
      },
      'an agent': {
        retired: [
          { ...exported(first), public: { ...first.public, kind: 'agent' } },
          exported(second),
        ],
      },
      'secret keys of another key': {
        retired: [
          { ...exported(first), boxSecretKey: toBase64(second.boxSecretKey) },
          exported(second),
        ],
      },
      'a short secret key': {
        retired: [
          { ...exported(first), signSecretKey: toBase64(new Uint8Array(3)) },
          exported(second),
        ],
      },
      // libsodium would sign with the public key this one ends with.
      'a signing key ending in another public key': {
        retired: [
          {
            ...exported(first),
            signSecretKey: toBase64(
              Uint8Array.of(
                ...first.signSecretKey.subarray(0, 32),
                ...second.signSecretKey.subarray(32),
              ),
            ),
          },
          exported(second),
        ],
      },
      'another format': { format: 1 },
      'an unknown property': { reason: 'leak' },
      'an unknown property in a key': {
        retired: [{ ...exported(first), note: 1 }, exported(second)],
      },
    };
    for (const [why, changes] of Object.entries(refused)) {
      expect(() => open(keyring(changes)), why).toThrow(code('malformed'));
    }
    // Section 3.3, rules 6 and 7.
    expect(() => open(keyring().replace('"format":2', '"format":2.0'))).toThrow(code('malformed'));
    expect(() => open(keyring().replace('"keyVersion":1,', '"keyVersion":1e0,'))).toThrow(
      code('malformed'),
    );
    expect(() => open(keyring().replace('{"format":2,', '{"format":2,"format":2,'))).toThrow(
      code('malformed'),
    );
  });

  // Before, the server's answer failed to parse, and the app said to try again.
  it('is read from the server, and asks to update rather than to try again', async () => {
    const answers = [made.wrapper, { format: 3, accountId, later: {} }];
    for (const wrapper of answers) {
      const api = createApiClient({
        fetch: async () =>
          new Response(JSON.stringify({ wrapper, version: 2 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      });
      await expect(
        openVault({ api, crypto: inlineVaultCrypto, secret: { kind: 'passphrase', passphrase } }),
      ).rejects.toThrow(code('unsupported-format'));
    }
  });

  // Kept, it would only ask to update offline, in place of the wrapper that opens.
  it('isn’t kept to unlock offline by a version that doesn’t unlock it', async () => {
    const store = memoryKeptStore();
    const v1 = createVault({ accountId, identity: first, passphrase, kdf: FAST_KDF });
    await keepWrapper(store, { wrapper: v1.wrapper, version: 1 });
    await keepWrapper(store, { wrapper: made.wrapper, version: 2 });
    expect(await keptUnlock(store).vault()).toMatchObject({ wrapper: v1.wrapper, version: 1 });
  });

  it('is never made with keys that break those rules', () => {
    for (const retired of [[second], [second, first], [first, second, second]]) {
      expect(() =>
        createRotatedVault({ accountId, identity: third, retired, passphrase, kdf: FAST_KDF }),
      ).toThrow(code('malformed'));
    }
  });
});

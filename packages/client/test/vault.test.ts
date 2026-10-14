import { describe, expect, it } from 'vite-plus/test';
import {
  AccountId,
  changePassphrase,
  createVault,
  generateIdentity,
  IdentityId,
  unlockVault,
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

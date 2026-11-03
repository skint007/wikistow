import { vaultRoutes, type AccountId, type VaultWrapper } from '@wikistow/contracts';
import { noAnswer, type ApiClient } from '../api/client.ts';
import type { KeptStore } from '../kept-store.ts';
import { keptUnlock } from '../kept-unlock.ts';
import { generateIdentity, type PrivateIdentity } from '../identity.ts';
import { IdentityId, newId } from '../ids.ts';
import {
  changePassphrase,
  createVault,
  unlockVault,
  type KdfParams,
  type UnlockedVault,
  type VaultSecret,
} from '../vault.ts';

/**
 * The slow, memory-hungry vault steps (Argon2id). Node calls them inline;
 * the browser supplies a Web Worker so the page never freezes.
 */
export type VaultCrypto = {
  create(input: { accountId: AccountId; passphrase: string; kdf?: KdfParams }): Promise<{
    identity: PrivateIdentity;
    wrapper: VaultWrapper;
    recoveryKey: string;
    vault: UnlockedVault;
  }>;
  unlock(input: { wrapper: VaultWrapper; secret: VaultSecret }): Promise<UnlockedVault>;
  changePassphrase(input: {
    vault: UnlockedVault;
    wrapper: VaultWrapper;
    passphrase: string;
    kdf?: KdfParams;
  }): Promise<VaultWrapper>;
};

export const inlineVaultCrypto: VaultCrypto = {
  async create({ accountId, passphrase, kdf }) {
    const identity = generateIdentity({ kind: 'human', id: newId(IdentityId) });
    return {
      identity,
      ...createVault({ accountId, identity, passphrase, ...(kdf ? { kdf } : {}) }),
    };
  },
  async unlock(input) {
    return unlockVault(input);
  },
  async changePassphrase({ vault, wrapper, passphrase, kdf }) {
    return changePassphrase({ vault, wrapper, passphrase, ...(kdf ? { kdf } : {}) });
  },
};

/** A new identity and vault, made on this device but not yet registered. */
export type PreparedVault = Awaited<ReturnType<VaultCrypto['create']>>;

/**
 * Make the person's identity and vault. Show `recoveryKey` and have them
 * confirm they saved it, then `registerVault`. Keep the prepared vault until
 * registration succeeds: retrying with the same one is safe, and a fresh one
 * would come with a recovery key nobody saw.
 */
export function prepareVault({
  crypto,
  accountId,
  passphrase,
  kdf,
}: {
  crypto: VaultCrypto;
  accountId: AccountId;
  passphrase: string;
  kdf?: KdfParams;
}): Promise<PreparedVault> {
  return crypto.create({ accountId, passphrase, ...(kdf ? { kdf } : {}) });
}

/**
 * Store a prepared vault and its identity on the server. Safe to repeat.
 * Returns the wrapper stored and its version, which a device keeps to
 * unlock offline.
 */
export async function registerVault(
  api: ApiClient,
  prepared: PreparedVault,
): Promise<{ wrapper: VaultWrapper; version: number }> {
  const { version } = await api.call(vaultRoutes.createVault, {
    body: { identity: prepared.identity.public, wrapper: prepared.wrapper },
  });
  return { wrapper: prepared.wrapper, version };
}

/** Unlock with the passphrase or the recovery key. */
export async function openVault({
  api,
  crypto,
  secret,
}: {
  api: ApiClient;
  crypto: VaultCrypto;
  secret: VaultSecret;
}): Promise<UnlockedVault> {
  const { wrapper } = await api.call(vaultRoutes.getVault);
  return crypto.unlock({ wrapper, secret });
}

/**
 * The wrapper to unlock with (ADR 0009, decision 5): the server's, which is
 * kept in `kept` for unlocking offline, or, when the server doesn't answer,
 * the one kept, with when it was kept (`keptAt`). With none kept, the
 * server's failure stands.
 */
export async function vaultWrapper(
  api: ApiClient,
  kept: KeptStore | null,
): Promise<{ wrapper: VaultWrapper; version: number; keptAt: string | null }> {
  try {
    const served = await api.call(vaultRoutes.getVault);
    if (kept) await keepWrapper(kept, served);
    return { ...served, keptAt: null };
  } catch (error) {
    const found = kept && noAnswer(error) ? await keptUnlock(kept).vault() : null;
    if (!found) throw error;
    return found;
  }
}

/** Keep the wrapper the server serves now, for unlocking offline. Failing only means an older one stays. */
export function keepWrapper(
  kept: KeptStore,
  { wrapper, version }: { wrapper: VaultWrapper; version: number },
): Promise<void> {
  return keptUnlock(kept)
    .keepVault({ wrapper, version, keptAt: new Date().toISOString() })
    .catch(() => {});
}

/**
 * Set a new passphrase, for example right after unlocking with the recovery
 * key. Only the passphrase wrapper changes; pages are not re-encrypted.
 * Returns the new wrapper and its version, which a device keeps to unlock
 * offline.
 */
export async function changeVaultPassphrase({
  api,
  crypto,
  vault,
  passphrase,
  kdf,
}: {
  api: ApiClient;
  crypto: VaultCrypto;
  vault: UnlockedVault;
  passphrase: string;
  kdf?: KdfParams;
}): Promise<{ wrapper: VaultWrapper; version: number }> {
  const { wrapper, version } = await api.call(vaultRoutes.getVault);
  const next = await crypto.changePassphrase({
    vault,
    wrapper,
    passphrase,
    ...(kdf ? { kdf } : {}),
  });
  const replaced = await api.call(vaultRoutes.replaceVault, {
    body: { wrapper: next, expectedVersion: version },
  });
  return { wrapper: next, version: replaced.version };
}

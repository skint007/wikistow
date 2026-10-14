import {
  closeSession,
  CryptoError,
  inlineVaultCrypto,
  openSession,
  openVault,
  type VaultSecret,
} from '@wikistow/client';
import { api } from '../api';
import { forgetKeptUnlock, vaultStore } from './store';
import { rememberedInTab } from './tab-unlock';
import { workerVaultCrypto } from './worker-crypto';

/**
 * Open the vault with `secret` and start the session. Staged until the
 * session opens, so a failure there doesn't leave the keys about. A vault key
 * needs no Argon2id, so it unlocks right here rather than in a worker.
 */
export async function unlockWith(secret: VaultSecret, started: number) {
  const crypto = secret.kind === 'vault-key' ? inlineVaultCrypto : workerVaultCrypto;
  // Locked since `started` (say, signed out while this ran): nothing opens,
  // and the keys it opened are overwritten with the staged ones.
  const lockedSince = () => vaultStore.epoch() !== started;
  const refused = () => {
    vaultStore.dropStaged();
    return new Error('The vault was locked while it opened');
  };
  const vault = vaultStore.stage(await openVault({ api, crypto, secret }));
  if (lockedSince()) throw refused();
  const ctx = await openSession(api, vault);
  if (lockedSince()) {
    closeSession(ctx);
    throw refused();
  }
  vaultStore.unlock(ctx, vault);
  return vault;
}

let restoring: Promise<void> | null = null;

/**
 * Open the vault this browser tab kept through a refresh, if it kept one for
 * `accountId`. Otherwise the vault stays locked, and opening a page asks.
 * Navigations while one runs share it: a second would stage over its keys.
 */
export function restoreInTab(accountId: string): Promise<void> {
  restoring ??= restore(accountId).finally(() => {
    restoring = null;
  });
  return restoring;
}

async function restore(accountId: string) {
  const started = vaultStore.epoch();
  const vaultKey = await rememberedInTab(accountId).catch(() => null);
  if (!vaultKey) return;
  try {
    await unlockWith({ kind: 'vault-key', vaultKey }, started);
  } catch (caught) {
    // A key that no longer opens this vault is no use to keep. Anything
    // else, such as the server being away, leaves it for the next load.
    if (caught instanceof CryptoError) await forgetKeptUnlock();
  } finally {
    vaultKey.fill(0);
  }
}

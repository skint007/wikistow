import { confirmSession, CryptoError, type ClientContext } from '@wikistow/client';
import { useEffect, useSyncExternalStore } from 'react';
import { useConnection } from '../data/connection';
import { useVault, vaultStore } from './store';

// Sessions being confirmed, so each runs once at a time.
const confirming = new WeakSet<ClientContext>();
const listeners = new Set<() => void>();
let confirmed = 0;

/**
 * Once the server answers, run what an offline unlock skipped
 * (`confirmSession`; ADR 0009, decision 5). Another installation, or a
 * passphrase changed elsewhere, ends the session: the vault locks as Lock
 * vault does, saving what can be saved first and forgetting a remembered
 * unlock, so the new passphrase is asked for. So does a contacts record
 * that fails its checks, which the next online unlock then reports. With
 * no answer again, it waits for the next one.
 */
export function useConfirmSession() {
  const vault = useVault();
  const { online } = useConnection();
  const ctx = vault.status === 'unlocked' ? vault.ctx : null;
  useEffect(() => {
    if (!ctx?.unconfirmed || !online || confirming.has(ctx)) return;
    confirming.add(ctx);
    void confirmSession(ctx)
      .then(async (outcome) => {
        // As an idle lock: nobody is asked, and an edit that can't be saved keeps it open.
        if (outcome !== 'confirmed') await vaultStore.requestLock(() => false);
      })
      .catch((error: unknown) => {
        if (error instanceof CryptoError) vaultStore.lock();
      })
      .finally(() => {
        confirming.delete(ctx);
        confirmed += 1;
        for (const listener of listeners) listener();
      });
  }, [ctx, online]);
}

/**
 * Whether `ctx` is confirmed: opened online, or confirmed since. Until it
 * is, the app doesn't list the spaces from the server (`useTreeChanges`),
 * which comes after confirming (decision 4).
 */
export function useSessionConfirmed(ctx: ClientContext | null): boolean {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => confirmed,
  );
  return !ctx?.unconfirmed;
}

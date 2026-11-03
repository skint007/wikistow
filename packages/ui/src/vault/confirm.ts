import { confirmSession, CryptoError, type ClientContext } from '@wikistow/client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { PROBE_MS, useConnection } from '../data/connection';
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
 * that fails against the mark, which the next online unlock then reports.
 * With no answer again, it waits for the next one; any other failure, or
 * a lock an edit that can't be saved keeps off, is tried again shortly.
 */
export function useConfirmSession() {
  const vault = useVault();
  const { online } = useConnection();
  const ctx = vault.status === 'unlocked' ? vault.ctx : null;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ctx?.unconfirmed || !online || confirming.has(ctx)) return;
    confirming.add(ctx);
    let retry: ReturnType<typeof setTimeout> | undefined;
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
        if (ctx.unconfirmed && vaultStore.get().status === 'unlocked') {
          retry = setTimeout(() => setAttempt((count) => count + 1), PROBE_MS);
        }
      });
    return () => clearTimeout(retry);
  }, [ctx, online, attempt]);
}

/**
 * Whether `ctx` is confirmed: opened online, or confirmed since. Until it
 * is, the app neither follows changes from the server nor keeps every
 * space current (`useTreeChanges`), and owner work waits, as those come
 * after confirming (decision 4). What's on screen loads again meanwhile.
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

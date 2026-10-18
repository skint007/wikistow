import { closeSession, type ClientContext, type UnlockedVault } from '@wikistow/client';
import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { desktop } from '../desktop';
import { forgetInTab, rememberInTab } from './tab-unlock';

/**
 * Query keys for anything decrypted start with this, so locking can drop
 * every plaintext the cache holds in one call.
 */
export const PLAIN = 'plain';

export type VaultState =
  | { status: 'locked' }
  | { status: 'unlocked'; ctx: ClientContext; vault: UnlockedVault };

let state: VaultState = { status: 'locked' };
// Keys opened or made on this device but not (yet) the open vault: setup
// before the recovery key is confirmed, recovery before the new passphrase.
let staged: UnlockedVault | null = null;
const listeners = new Set<() => void>();
const blobUrls = new Set<string>();
const lockGuards = new Set<LockGuard>();
let queryClient: QueryClient | null = null;
// Counts locks, so work started before one can tell it happened.
let epoch = 0;

/**
 * Runs before a requested lock, while the keys still work: save what can be
 * saved, then resolve false to keep the vault open. `ask` puts a yes-or-no
 * question to the person, and answers no when nobody is there (an idle lock).
 */
export type LockGuard = (ask: Ask) => Promise<boolean>;
export type Ask = (question: string) => boolean;

/** Overwrite a vault's secret keys, so they can't be read from memory later. */
export function zeroVault(vault: UnlockedVault) {
  vault.vaultKey.fill(0);
  vault.identity.boxSecretKey.fill(0);
  vault.identity.signSecretKey.fill(0);
}

const emit = () => {
  for (const listener of listeners) listener();
};

/**
 * Forget the unlock kept between loads: the desktop app's remembered one, or
 * the browser's copies, its tabs' and any it remembers (`tab-unlock.ts`).
 */
export function forgetKeptUnlock(): Promise<void> {
  return (desktop ? desktop.forgetVault() : forgetInTab()).catch(() => {});
}

/**
 * The unlocked vault lives in this module's memory, never in cookies or the
 * URL. Storage gets only a sealed copy of the vault key: a browser tab's,
 * for its next load, the browser's, when asked to remember (`tab-unlock.ts`),
 * or the desktop app's, when asked to remember. Locking zeroes the keys, wipes the folder keys the
 * session opened (`closeSession`), drops decrypted queries, and
 * revokes the object URLs of decrypted attachments. Keys that stop being
 * used any other way (replaced, or made on a page that was left) are zeroed
 * too.
 */
export const vaultStore = {
  /** Called once by the app, so locking can clear decrypted queries. */
  attach(client: QueryClient) {
    queryClient = client;
  },
  /** Open `vault`. Keys it replaces, open or staged, are zeroed. */
  unlock(ctx: ClientContext, vault: UnlockedVault) {
    if (state.status === 'unlocked' && state.ctx !== ctx) closeSession(state.ctx);
    if (state.status === 'unlocked' && state.vault !== vault) zeroVault(state.vault);
    if (staged === vault) staged = null;
    vaultStore.dropStaged();
    state = { status: 'unlocked', ctx, vault };
    // A browser tab keeps it through a refresh. Keeping it for later visits,
    // and the desktop app keeping it at all, is only when asked to (the
    // unlock page, or Settings in the browser).
    if (!desktop) void rememberInTab(vault.accountId, vault.vaultKey).catch(() => {});
    emit();
  },
  /**
   * Hold keys that aren't the open vault yet, so leaving before they are
   * (`dropStaged`) or staging others zeroes them. Returns `vault`.
   */
  stage(vault: UnlockedVault): UnlockedVault {
    if (staged && staged !== vault) zeroVault(staged);
    staged = vault;
    return vault;
  },
  /** Zero staged keys that were never opened: the page that made them was left. */
  dropStaged() {
    if (staged) zeroVault(staged);
    staged = null;
  },
  /**
   * Lock the vault the way a person asks to: every guard runs first, and any
   * of them can keep it open. Guards ask with `ask`, by default a confirm
   * dialog. Resolves whether it locked.
   */
  async requestLock(ask: Ask = (question) => window.confirm(question)): Promise<boolean> {
    for (const guard of [...lockGuards]) {
      if (!(await guard(ask))) return false;
    }
    vaultStore.lock();
    return true;
  },
  /** Run `guard` before each requested lock until the returned function is called. */
  guardLock(guard: LockGuard): () => void {
    lockGuards.add(guard);
    return () => {
      lockGuards.delete(guard);
    };
  },
  /**
   * Lock now, without asking anyone: for a session that has already ended.
   * The kept unlock goes too, so the next launch or load asks for the
   * passphrase again.
   */
  lock() {
    epoch += 1;
    void forgetKeptUnlock();
    if (state.status === 'unlocked') {
      closeSession(state.ctx);
      zeroVault(state.vault);
    }
    vaultStore.dropStaged();
    state = { status: 'locked' };
    queryClient?.removeQueries({ queryKey: [PLAIN] });
    for (const url of blobUrls) URL.revokeObjectURL(url);
    blobUrls.clear();
    emit();
  },
  /**
   * A `blob:` URL for decrypted bytes, revoked when the vault locks. Pass
   * the epoch from before decrypting: if the vault locked since, there is
   * no URL, so nothing decrypted outlives the lock.
   */
  objectUrl(bytes: Uint8Array, mediaType: string, decryptedIn: number): string {
    if (decryptedIn !== epoch) throw new Error('The vault locked while this was decrypted');
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }));
    blobUrls.add(url);
    return url;
  },
  get: () => state,
  /** Changes on every lock: compare a value taken earlier to know the keys are gone. */
  epoch: () => epoch,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useVault(): VaultState {
  return useSyncExternalStore(vaultStore.subscribe, vaultStore.get);
}

/** The open session's context. Only for components under the unlocked-vault layout. */
export function useClient(): ClientContext {
  const current = useVault();
  if (current.status !== 'unlocked') throw new Error('The vault is locked');
  return current.ctx;
}

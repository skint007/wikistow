import type { KeptAccount, KeptItem } from '@wikistow/contracts';
import { openOnDevice, sealOnDevice, deviceTag } from './device-seal.ts';
import { canonical } from './encoding.ts';
import type { PrivateIdentity } from './identity.ts';
import type { InstallationId } from './ids.ts';

export type { KeptAccount, KeptItem };

/**
 * Named items a device keeps for offline use (ADR 0009), each sealed by the
 * pages (`keptSealer`), so whatever holds them only ever holds bytes it
 * can't read. Names are base64url.
 */
export interface KeptItems {
  read(name: string): Promise<Uint8Array | null>;
  /** Kept as `name`, in place of any item kept so. */
  write(name: string, sealed: Uint8Array): Promise<void>;
  remove(names: readonly string[]): Promise<void>;
  list(): Promise<KeptItem[]>;
}

/**
 * Unsealed items, by fixed names, which a device keeps for unlocking offline
 * (`keptUnlock`): they are read before any vault opens, and hold no content.
 */
export interface KeptBytes {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * Everything a device keeps for offline use (ADR 0009, decision 2): the
 * kept pages, trees and images (`items`), the changes made offline
 * (`queue`), and, unsealed beside them, the account they belong to and
 * what unlocking offline reads (`unlock`). The desktop app keeps them in
 * its `kept`, `queue` and `unlock` folders and `kept-account` file, the
 * browser in the `wikistow-kept` IndexedDB database, tests and a desktop
 * app without a keyring (all but the queue) in memory (`memoryKeptStore`).
 */
export interface KeptStore {
  readonly items: KeptItems;
  readonly queue: KeptItems;
  readonly unlock: KeptBytes;
  /** The account the kept items belong to, or null if none was kept. */
  account(): Promise<KeptAccount | null>;
  keepAccount(account: KeptAccount): Promise<void>;
  /** Delete everything kept: items, queue, account and what unlocking reads. */
  clear(): Promise<void>;
  /**
   * Run `work` with nothing else in this store's other users (tabs, say)
   * changing what it keeps meanwhile. Not reentrant.
   */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Run `work` with no other user changing the queue meanwhile. Apart from
   * `exclusive`, which the keeper holds for as long as it runs, so a change
   * saved offline never waits for it. Not reentrant.
   */
  queueExclusive<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Run `work`, the queue's sending, unless another user is sending it
   * already: then false, at once. One sender at a time (ADR 0009, decision 7).
   */
  sending(work: () => Promise<void>): Promise<boolean>;
}

function memoryItems(): KeptItems & { clear(): void } {
  const items = new Map<string, Uint8Array>();
  return {
    read: async (name) => items.get(name)?.slice() ?? null,
    write: async (name, sealed) => {
      items.set(name, sealed.slice());
    },
    remove: async (names) => {
      for (const name of names) items.delete(name);
    },
    list: async () => [...items].map(([name, sealed]) => ({ name, size: sealed.length })),
    clear: () => items.clear(),
  };
}

/** One piece of work at a time, in order, as `KeptStore.exclusive` does within one page. */
export function inTurn() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const done = queue.then(work);
    queue = done.catch(() => {});
    return done;
  };
}

/** `work` unless it is running already, as `KeptStore.sending` does within one page. */
export function onlyOnce() {
  let running = false;
  return async (work: () => Promise<void>): Promise<boolean> => {
    if (running) return false;
    running = true;
    try {
      await work();
      return true;
    } finally {
      running = false;
    }
  };
}

/**
 * A store in memory, for tests, and for what a desktop app without a
 * trusted keyring keeps of the pages it opened until it quits.
 */
export function memoryKeptStore(): KeptStore {
  const kept = memoryItems();
  const queue = memoryItems();
  const unlock = memoryItems();
  let account: KeptAccount | null = null;
  return {
    items: kept,
    queue,
    unlock: {
      read: (name) => unlock.read(name),
      write: (name, bytes) => unlock.write(name, bytes),
      remove: (name) => unlock.remove([name]),
    },
    account: async () => account,
    keepAccount: async (next) => {
      account = { ...next };
    },
    clear: async () => {
      kept.clear();
      queue.clear();
      unlock.clear();
      account = null;
    },
    exclusive: inTurn(),
    queueExclusive: inTurn(),
    sending: onlyOnce(),
  };
}

const KEY = 'kept-key/v1';
const NAMES = 'kept-names/v1';

/**
 * How items are sealed for one person on one server (ADR 0009, decision 2):
 * under `kept-key/v1`, from their identity key, so only their unlocked vault
 * opens them, and bound to the installation, the person, and the item's
 * name, so an item can't stand in for another. Names are tags of what the
 * item is (`deviceTag`), so a listing shows no IDs. Unlike the search index,
 * nothing is bound to the app's build: kept items hold payloads, which a
 * newer app reads as they are. A change to their format changes `kept/v1`.
 */
export function keptSealer({
  identity,
  installationId,
}: {
  identity: PrivateIdentity;
  installationId: InstallationId;
}) {
  const ad = (name: string) => canonical('kept/v1', [installationId, identity.public.id, name]);
  return {
    /** The item name for `what`, such as `version <id>`. */
    name: (what: string) => deviceTag(identity, NAMES, what),
    seal: (name: string, plaintext: Uint8Array) => sealOnDevice(identity, KEY, ad(name), plaintext),
    /** What `seal` sealed as `name`, or null if it was sealed for something else, or is damaged. */
    open: (name: string, sealed: Uint8Array) => openOnDevice(identity, KEY, ad(name), sealed),
  };
}

export type KeptSealer = ReturnType<typeof keptSealer>;

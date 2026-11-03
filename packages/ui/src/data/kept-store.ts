import {
  inTurn,
  memoryKeptStore,
  type KeptAccount,
  type KeptItem,
  type KeptItems,
  type KeptStore,
} from '@wikistow/client';
import type { DesktopBridge, KeptFolder } from '@wikistow/contracts';
import { desktop } from '../desktop';

// Where this device keeps pages for offline use (ADR 0009, decision 2).

const DATABASE = 'wikistow-kept';
const ACCOUNT = 'account';

let opening: Promise<IDBDatabase> | null = null;

/**
 * The browser's database, opened once per page. Another tab deleting it
 * (signing out) closes it here, so the deletion never waits on this tab,
 * and the next use opens it afresh.
 */
function database(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Items are `{ sealed, size }`, by name; the size index lists them
      // with their sizes without reading what they hold.
      for (const store of ['items', 'queue']) {
        db.createObjectStore(store).createIndex('size', 'size');
      }
      db.createObjectStore('meta');
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  }).catch((error: unknown) => {
    opening = null;
    throw error;
  });
  return opening;
}

/** What `request` answers, once its transaction is done. */
async function transact<T>(
  store: string,
  mode: IDBTransactionMode,
  request: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const asked = request(tx.objectStore(store));
    tx.oncomplete = () => resolve(asked ? asked.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const storedBytes = (value: unknown) =>
  value && typeof value === 'object' && 'sealed' in value && value.sealed instanceof Uint8Array
    ? value.sealed
    : null;

function browserItems(store: 'items' | 'queue'): KeptItems {
  return {
    read: async (name) => storedBytes(await transact(store, 'readonly', (s) => s.get(name))),
    write: async (name, sealed) => {
      await transact(store, 'readwrite', (s) => void s.put({ sealed, size: sealed.length }, name));
    },
    remove: async (names) => {
      await transact(store, 'readwrite', (s) => {
        for (const name of names) s.delete(name);
      });
    },
    list: async () => {
      const db = await database();
      return new Promise<KeptItem[]>((resolve, reject) => {
        const items: KeptItem[] = [];
        const cursor = db.transaction(store).objectStore(store).index('size').openKeyCursor();
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) return resolve(items);
          if (typeof at.primaryKey === 'string' && typeof at.key === 'number') {
            items.push({ name: at.primaryKey, size: at.key });
          }
          at.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
    },
  };
}

/** The browser's store: the `wikistow-kept` database, which its tabs share. */
function browserKeptStore(): KeptStore {
  const turn = inTurn();
  return {
    items: browserItems('items'),
    queue: browserItems('queue'),
    account: async () => {
      const kept = await transact('meta', 'readonly', (s) => s.get(ACCOUNT));
      return kept && typeof kept === 'object' && 'id' in kept && 'name' in kept
        ? { id: String(kept.id), name: String(kept.name) }
        : null;
    },
    keepAccount: async (account: KeptAccount) => {
      await transact('meta', 'readwrite', (s) => void s.put({ ...account }, ACCOUNT));
    },
    // Every tab closes its connection when asked (`database`), so this
    // never waits on one, and none writes into the deleted database.
    clear: async () => {
      const db = await opening?.catch(() => null);
      db?.close();
      opening = null;
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DATABASE);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },
    // Tabs take turns through a Web Lock where there is one.
    exclusive: (work) =>
      typeof navigator !== 'undefined' && navigator.locks
        ? navigator.locks.request(DATABASE, work)
        : turn(work),
  };
}

function bridgeItems(bridge: DesktopBridge, folder: KeptFolder): KeptItems {
  return {
    read: (name) => bridge.keptItem(folder, name),
    write: (name, sealed) => bridge.keepItem(folder, name, sealed),
    remove: (names) => bridge.dropKeptItems(folder, [...names]),
    list: () => bridge.keptItems(folder),
  };
}

/**
 * The desktop app's store: its `kept` and `queue` folders. Without a
 * trusted keyring, pages are kept only in memory, until the app quits; the
 * queue is kept on disk either way.
 */
function desktopKeptStore(bridge: DesktopBridge, secure: boolean): KeptStore {
  const memory = memoryKeptStore();
  return {
    items: secure ? bridgeItems(bridge, 'kept') : memory.items,
    queue: bridgeItems(bridge, 'queue'),
    account: () => bridge.keptAccount(),
    keepAccount: (account) => bridge.keepKeptAccount(account),
    clear: async () => {
      await memory.clear();
      await bridge.clearKept();
    },
    exclusive: (work) => memory.exclusive(work),
  };
}

const SEARCH_INDEX = 'search-index';

/**
 * The browser's search index, kept in the same database (ADR 0009,
 * decision 9), sealed by the pages (`sealKept`). Deleted with it at sign-out.
 */
export const browserSearchIndex = {
  read: async () => {
    const kept = await transact('meta', 'readonly', (s) => s.get(SEARCH_INDEX));
    return kept instanceof Uint8Array ? kept : null;
  },
  write: async (sealed: Uint8Array) => {
    await transact('meta', 'readwrite', (s) => void s.put(sealed, SEARCH_INDEX));
  },
  drop: async () => {
    await transact('meta', 'readwrite', (s) => void s.delete(SEARCH_INDEX));
  },
};

let kept: Promise<{ store: KeptStore; onDisk: boolean }> | null = null;

/**
 * This device's store, and whether it keeps pages between launches: always
 * in a browser, only with a trusted keyring in the desktop app.
 */
export function keptStore(): Promise<{ store: KeptStore; onDisk: boolean }> {
  kept ??= (async () => {
    if (!desktop) return { store: browserKeptStore(), onDisk: true };
    const secure = await desktop.secureStorage().catch(() => false);
    return { store: desktopKeptStore(desktop, secure), onDisk: secure };
  })();
  return kept;
}

let checked: string | null = null;

/**
 * Before a session for `account` opens: if what's kept is another
 * account's, delete it all (ADR 0009, decision 10), then note whose it is.
 * What's kept for the same account stays. Failing only means checking
 * again next time.
 */
export async function keptFor(account: KeptAccount): Promise<void> {
  if (checked === account.id) return;
  try {
    const { store } = await keptStore();
    const before = await store.account();
    if (before && before.id !== account.id) await store.clear();
    if (before?.id !== account.id || before.name !== account.name) {
      await store.keepAccount({ id: account.id, name: account.name });
    }
    checked = account.id;
  } catch {
    // Checked again at the next navigation.
  }
}

const SIGNED_OUT = 'signed-out';

/**
 * At sign-out (ADR 0009, decision 10): tell the browser's other tabs, which
 * lock and stop keeping, then delete everything kept. The desktop app's main
 * process deletes its folders as it signs out; this clears what it held in
 * memory.
 */
export async function forgetKept(): Promise<void> {
  checked = null;
  if (!desktop && typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(DATABASE);
    channel.postMessage(SIGNED_OUT);
    channel.close();
  }
  const { store } = await keptStore();
  await store.clear().catch(() => {});
}

/** Run `signedOut` when another tab signs out, until the returned function is called. */
export function onSignedOutElsewhere(signedOut: () => void): () => void {
  if (desktop || typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(DATABASE);
  channel.onmessage = (event) => {
    if (event.data === SIGNED_OUT) {
      checked = null;
      signedOut();
    }
  };
  return () => channel.close();
}

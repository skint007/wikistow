import {
  inTurn,
  keptUnlock,
  onlyOnce,
  queueOperations,
  memoryKeptStore,
  type KeptAccount,
  type KeptBytes,
  type KeptFile,
  type KeptItem,
  type KeptItems,
  type KeptStore,
  type MeAnswer,
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

// What unlocking offline reads, unsealed, beside the account in `meta`.
const browserUnlock: KeptBytes = {
  read: async (name) => {
    const kept = await transact('meta', 'readonly', (s) => s.get(`unlock ${name}`));
    return kept instanceof Uint8Array ? kept : null;
  },
  write: async (name, bytes) => {
    await transact('meta', 'readwrite', (s) => void s.put(bytes, `unlock ${name}`));
  },
  remove: async (name) => {
    await transact('meta', 'readwrite', (s) => void s.delete(`unlock ${name}`));
  },
};

const hasLocks = () => typeof navigator !== 'undefined' && navigator.locks !== undefined;

/** The browser's store: the `wikistow-kept` database, which its tabs share. */
function browserKeptStore(): KeptStore {
  const turn = inTurn();
  const queueTurn = inTurn();
  const sendingHere = onlyOnce();
  return {
    items: browserItems('items'),
    queue: browserItems('queue'),
    unlock: browserUnlock,
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
    exclusive: (work) => (hasLocks() ? navigator.locks.request(DATABASE, work) : turn(work)),
    queueExclusive: (work) =>
      hasLocks() ? navigator.locks.request(`${DATABASE}-queue`, work) : queueTurn(work),
    // One tab sends; the others find the lock taken and leave it.
    sending: (work) =>
      hasLocks()
        ? navigator.locks.request(`${DATABASE}-sending`, { ifAvailable: true }, async (lock) => {
            if (!lock) return false;
            await work();
            return true;
          })
        : sendingHere(work),
  };
}

function bridgeBytes(bridge: DesktopBridge, folder: KeptFolder): KeptBytes {
  return {
    read: (name) => bridge.keptItem(folder, name),
    write: (name, bytes) => bridge.keepItem(folder, name, bytes),
    remove: (name) => bridge.dropKeptItems(folder, [name]),
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
 * The desktop app's store: its `kept`, `queue` and `unlock` folders.
 * Without a trusted keyring, pages and what unlocking reads are kept only
 * in memory, until the app quits; the queue is kept on disk either way.
 */
function desktopKeptStore(bridge: DesktopBridge, secure: boolean): KeptStore {
  const memory = memoryKeptStore();
  return {
    items: secure ? bridgeItems(bridge, 'kept') : memory.items,
    queue: bridgeItems(bridge, 'queue'),
    unlock: secure ? bridgeBytes(bridge, 'unlock') : memory.unlock,
    account: () => bridge.keptAccount(),
    keepAccount: (account) => bridge.keepKeptAccount(account),
    clear: async () => {
      await memory.clear();
      await bridge.clearKept();
    },
    exclusive: (work) => memory.exclusive(work),
    queueExclusive: (work) => memory.queueExclusive(work),
    sending: (work) => memory.sending(work),
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

const TRUST_MARKS = 'trust-marks';

/**
 * The browser's trust marks and contacts record (`KeptMarks`), kept in the
 * same database (ADR 0009, decision 2), sealed by the pages. Tabs write
 * them in turn under a Web Lock, each taking in what the others kept.
 * Deleted with the database at sign-out.
 */
export const browserTrustMarks: KeptFile = {
  read: async () => {
    const kept = await transact('meta', 'readonly', (s) => s.get(TRUST_MARKS));
    return kept instanceof Uint8Array ? kept : null;
  },
  write: async (sealed) => {
    await transact('meta', 'readwrite', (s) => void s.put(sealed, TRUST_MARKS));
  },
  exclusive: (work) =>
    typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request(`${DATABASE}-${TRUST_MARKS}`, work)
      : work(),
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

/**
 * Whether this device may keep anything already: the desktop app's bridge
 * always, a browser only once its database exists. Opening it to ask would
 * make it, as on the sign-in page after signing out.
 */
async function keptHere(): Promise<boolean> {
  if (desktop) return true;
  const databases = await indexedDB.databases?.().catch(() => null);
  return databases?.some((db) => db.name === DATABASE) ?? false;
}

/**
 * The last `/api/me` answer this device kept, for going on offline (ADR
 * 0009, decision 5), if it is for the account everything kept belongs to.
 */
export async function keptMe(): Promise<MeAnswer | null> {
  try {
    if (!(await keptHere())) return null;
    const { store } = await keptStore();
    const [me, account] = await Promise.all([keptUnlock(store).me(), store.account()]);
    return me && me.account.id === account?.id ? me : null;
  } catch {
    return null;
  }
}

let keptAnswer: string | null = null;

/**
 * Keep `me`, the server's answer, for going on offline, once what's kept
 * is this account's (`keptFor`). Failing only means an older answer stays.
 */
export async function keepMe(me: MeAnswer): Promise<void> {
  const json = JSON.stringify(me);
  if (json === keptAnswer) return;
  try {
    await keptFor(me.account);
    const { store } = await keptStore();
    await keptUnlock(store).keepMe(me);
    keptAnswer = json;
  } catch {
    // Kept at the next answer.
  }
}

/**
 * The server says there is no session: a start with no answer goes no
 * further than sign-in, rather than on offline. Everything else kept
 * stays, sealed, for the same account's next sign-in (decision 10).
 */
export async function forgetKeptMe(): Promise<void> {
  keptAnswer = null;
  try {
    if (!(await keptHere())) return;
    const { store } = await keptStore();
    await keptUnlock(store).forgetMe();
  } catch {
    // Nothing kept to forget.
  }
}

/**
 * How many changes made offline this device holds that haven't been sent,
 * and whose they are, read before any vault opens, for the warnings before
 * signing out, or in as someone else (ADR 0009, decision 10). Null for none.
 */
export async function changesNotSent(): Promise<{ count: number; name: string } | null> {
  try {
    if (!(await keptHere())) return null;
    const { store } = await keptStore();
    const [count, account] = await Promise.all([
      queueOperations.queuedChanges(store),
      store.account(),
    ]);
    return count > 0 && account ? { count, name: account.name } : null;
  } catch {
    return null;
  }
}

/** What signing out warns of first, when changes made offline would go with it. */
export const signOutWarning = (count: number) =>
  count === 1
    ? '1 change you made offline hasn’t been saved yet. Signing out deletes it.'
    : `${count} changes you made offline haven’t been saved yet. Signing out deletes them.`;

const SIGNED_OUT = 'signed-out';

/**
 * At sign-out (ADR 0009, decision 10): tell the browser's other tabs, which
 * lock and stop keeping, then delete everything kept. The desktop app's main
 * process deletes its folders as it signs out; this clears what it held in
 * memory.
 */
export async function forgetKept(): Promise<void> {
  checked = null;
  keptAnswer = null;
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

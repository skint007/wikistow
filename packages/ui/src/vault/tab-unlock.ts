import { fromBase64, toBase64 } from '@wikistow/client';
import { z } from 'zod';

/**
 * Keeps a browser tab's unlock across a refresh. The vault key goes into
 * this tab's sessionStorage sealed with AES-GCM under a non-extractable
 * CryptoKey held in IndexedDB, so neither store holds anything usable on
 * its own and no page script can read the wrapping key out. sessionStorage
 * belongs to the tab, so a new tab asks for the passphrase (a duplicated
 * one starts with a copy of it). Forgetting deletes the wrapping key too,
 * which makes every tab's copy useless: a lock or sign-out in one tab means
 * the next load anywhere asks again.
 */
const ITEM = 'wikistow.vault';
const DATABASE = 'wikistow-vault';
const STORE = 'keys';
const WRAPPING_KEY = 'tab-unlock';

const Stored = z.object({ accountId: z.string(), iv: z.string(), sealed: z.string() });

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run `use` on the key store, closing the database after, so deleting it is never blocked. */
async function withStore<T>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const open = indexedDB.open(DATABASE, 1);
  open.onupgradeneeded = () => open.result.createObjectStore(STORE);
  const db = await request(open);
  try {
    return await request(use(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

// Web Crypto takes bytes backed by a plain ArrayBuffer, so these copy into one.
const accountAd = (accountId: string) => new TextEncoder().encode(accountId);
const bytes = (base64: string) => new Uint8Array(fromBase64(base64));

const isKey = (value: unknown): value is CryptoKey => value instanceof CryptoKey;

/** The wrapping key the tabs share, made on first use. */
async function wrappingKey(): Promise<CryptoKey> {
  const kept = await withStore('readonly', (store) => store.get(WRAPPING_KEY));
  if (isKey(kept)) return kept;
  const made = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  // Another tab may have made one meanwhile: keep theirs, so its copy still opens.
  await withStore('readwrite', (store) => store.add(made, WRAPPING_KEY)).catch(() => {});
  const shared = await withStore('readonly', (store) => store.get(WRAPPING_KEY));
  return isKey(shared) ? shared : made;
}

// Each step runs alone, in the order asked: a lock right after an unlock
// forgets what that unlock was still sealing, and the unlock page shown after
// it finds nothing.
let queue: Promise<unknown> = Promise.resolve();
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const turn = queue.then(work);
  queue = turn.catch(() => {});
  return turn;
}

/** Keep `vaultKey` for this tab's next load. It is copied now, so zeroing it after is fine. */
export function rememberInTab(accountId: string, vaultKey: Uint8Array): Promise<void> {
  const copy = new Uint8Array(vaultKey);
  return inTurn(async () => {
    try {
      const key = await wrappingKey();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: accountAd(accountId) },
        key,
        copy,
      );
      const stored = { accountId, iv: toBase64(iv), sealed: toBase64(new Uint8Array(sealed)) };
      sessionStorage.setItem(ITEM, JSON.stringify(stored satisfies z.input<typeof Stored>));
    } finally {
      copy.fill(0);
    }
  });
}

/**
 * The vault key this tab kept for `accountId`, or null. A copy kept for
 * someone else, or one that no longer opens, is dropped.
 */
export function rememberedInTab(accountId: string): Promise<Uint8Array | null> {
  return inTurn(() => openKept(accountId));
}

async function openKept(accountId: string): Promise<Uint8Array | null> {
  const item = sessionStorage.getItem(ITEM);
  if (!item) return null;
  try {
    const stored = Stored.parse(JSON.parse(item));
    if (stored.accountId !== accountId) throw new Error('Kept for another account');
    const key = await withStore('readonly', (store) => store.get(WRAPPING_KEY));
    if (!isKey(key)) throw new Error('The wrapping key is gone');
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(stored.iv), additionalData: accountAd(accountId) },
      key,
      bytes(stored.sealed),
    );
    return new Uint8Array(opened);
  } catch {
    sessionStorage.removeItem(ITEM);
    return null;
  }
}

/** Forget this tab's copy, and the wrapping key that would open any tab's. */
export function forgetInTab(): Promise<void> {
  return inTurn(async () => {
    sessionStorage.removeItem(ITEM);
    await request(indexedDB.deleteDatabase(DATABASE));
  });
}

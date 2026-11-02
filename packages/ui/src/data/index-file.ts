import { desktop } from '../desktop';
import { keepEveryPage } from './keeper';
import { browserSearchIndex, keptStore } from './kept-store';

/** Where the search index is kept between sessions, sealed for this person and build (`sealKept`). */
export type IndexFile = {
  read(): Promise<Uint8Array | null>;
  write(sealed: Uint8Array): Promise<void>;
};

/**
 * Where this device keeps the search index (ADR 0009, decision 9), or null:
 * only with **Every page**, as the index covers every page this person can
 * read, and only where pages are kept between launches, a browser
 * (IndexedDB) or the desktop app with a trusted keyring (its
 * `search-index` file). With **Pages I open** the index stays in memory,
 * and one kept before is deleted.
 */
export async function searchIndexFile(): Promise<IndexFile | null> {
  const { onDisk } = await keptStore();
  if (!onDisk) return null;
  const bridge = desktop;
  const file = bridge
    ? {
        read: () => bridge.searchIndex(),
        write: (sealed: Uint8Array) => bridge.keepSearchIndex(sealed),
        drop: () => bridge.dropSearchIndex(),
      }
    : browserSearchIndex;
  if (keepEveryPage().get()) return file;
  await file.drop().catch(() => {});
  return null;
}

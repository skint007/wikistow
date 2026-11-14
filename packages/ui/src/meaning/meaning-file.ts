import { desktop } from '../desktop';
import { keepEveryPage } from '../data/keeper';
import { browserMeaningIndex, keptStore } from '../data/kept-store';
import type { MeaningFile } from './meaning-index';

/** The desktop app's `meaning-index` file, or the browser's entry beside the search index. */
const place = () => {
  const bridge = desktop;
  return bridge
    ? {
        read: () => bridge.meaningIndex(),
        write: (sealed: Uint8Array) => bridge.keepMeaningIndex(sealed),
        drop: () => bridge.dropMeaningIndex(),
      }
    : browserMeaningIndex;
};

/**
 * Where this device keeps search by meaning's vectors (ADR 0016, decision
 * 4), or null: exactly where it keeps the search index (`searchIndexFile`),
 * with **Keep for offline** on Every page, in a browser or the desktop app
 * with a trusted keyring.
 */
export async function meaningIndexFile(): Promise<MeaningFile | null> {
  const { onDisk } = await keptStore();
  if (!onDisk || !keepEveryPage().get()) return null;
  return place();
}

/** Delete the vectors kept, as when search by meaning is turned off or not offered. */
export async function dropMeaningIndex(): Promise<void> {
  await place()
    .drop()
    .catch(() => {});
}

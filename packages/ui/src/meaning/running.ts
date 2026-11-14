import type { MeaningIndexer } from './meaning-index';
import type { MeaningReader } from './search';

// What search by meaning runs for the open session in this tab (ADR 0016):
// the queue, in the one tab holding it (`oneTabAtATime`), and in every tab
// where it is on, a reader of the vectors kept, for a tab without the queue.

let running: MeaningIndexer | null = null;
let reader: MeaningReader | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/** The queue running for the open session, in this tab. */
export function setRunning(indexer: MeaningIndexer | null) {
  running = indexer;
  changed();
}

/** The kept vectors' reader for the open session, in this tab. */
export function setReader(next: MeaningReader | null) {
  reader = next;
  changed();
}

/** Call `listener` each time the queue or the reader changes, until the returned function is called. */
export function subscribeRunning(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The queue running for the open session, for the search dialog, if search by meaning is on here. */
export const meaningIndexer = (): MeaningIndexer | null => running;

/** The reader of the kept vectors, while search by meaning is on here. */
export const meaningReader = (): MeaningReader | null => reader;

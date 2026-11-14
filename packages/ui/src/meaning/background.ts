import { QueryObserver, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { openMeaningIndex, sealMeaningIndex, type ClientContext } from '@wikistow/client';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { desktop } from '../desktop';
import { builtFromKept, onDraftSaved, searchIndexKey, searchIndexQuery } from '../data/queries';
import { useDeviceSwitch } from '../shell/device-switch';
import { PLAIN, vaultStore } from '../vault/store';
import { Embedder, forgetModel } from './embedder';
import { dropMeaningIndex, meaningIndexFile } from './meaning-file';
import { MeaningIndexer, type MeaningStatus } from './meaning-index';
import { MEANING_MODEL } from './model';
import { oneTabAtATime } from './one-tab';
import { meaningIndexer, meaningReader, setReader, setRunning, subscribeRunning } from './running';
import { MeaningReader } from './search';
import { dropsKeptVectors, searchByMeaning, useMeaningPlace } from './setting';

// Search by meaning in the app (ADR 0016, step 4): the background queue
// (`MeaningIndexer`) for the open session, following the word index and
// this person's saves, with the model in its worker (`Embedder`).

/** The model the vectors are made with, which the kept file is bound to. */
const MODEL_HASH = MEANING_MODEL.files.model.sha256;

/** A moment the page has free, or a second at most; a turn where there is no `requestIdleCallback`. */
const idle = () =>
  new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(() => resolve(), { timeout: 1_000 });
    else setTimeout(resolve, 0);
  });

/** Pages opening, or the word index updating: the queue waits for them. */
const OPENING = [[PLAIN, 'revision'], [PLAIN, 'page'], searchIndexKey] as const;

/**
 * Start the queue for `ctx`: it opens the vectors kept, follows the word
 * index (building it if nothing has, as a query table does while shown)
 * and this person's draft saves, until stopped, as at a lock.
 */
export function startMeaningIndex(queryClient: QueryClient, ctx: ClientContext) {
  const embedder = new Embedder({ keep: !desktop });
  // Locking zeroes the keys before anything here hears of it: nothing is
  // sealed or opened with them after (a seal under zeros wouldn't throw).
  const epoch = vaultStore.epoch();
  const unlocked = () => {
    if (vaultStore.epoch() !== epoch) throw new Error('The vault locked');
  };
  const indexer = new MeaningIndexer({
    embedder,
    file: () => meaningIndexFile().catch(() => null),
    seal: (kept) => {
      unlocked();
      return sealMeaningIndex(ctx, kept, MODEL_HASH);
    },
    open: (sealed) => {
      unlocked();
      return openMeaningIndex(ctx, sealed, MODEL_HASH);
    },
    busy: () => OPENING.some((queryKey) => queryClient.isFetching({ queryKey }) > 0),
    idle,
  });
  const unsaved = onDraftSaved(queryClient, (save) => indexer.saved(save));
  const observer = new QueryObserver(queryClient, searchIndexQuery(ctx, queryClient));
  // Reset as access changed (`refreshAccess`), it has no index until rebuilt.
  const unfollow = observer.subscribe(({ data }) => {
    if (data) indexer.indexChanged(data, { partial: builtFromKept(data) });
    else indexer.indexGone();
  });
  const shown = observer.getCurrentResult().data;
  if (shown) indexer.indexChanged(shown, { partial: builtFromKept(shown) });
  return {
    indexer,
    stop() {
      unfollow();
      unsaved();
      indexer.stop();
    },
  };
}

export { meaningIndexer } from './running';

/**
 * A reader of the vectors kept for `ctx`, for the search dialog of a tab
 * without the queue, which another tab holds (`oneTabAtATime`): it reads
 * them when search opens, and embeds queries in a worker of its own.
 */
export function startMeaningReader(ctx: ClientContext): MeaningReader {
  const epoch = vaultStore.epoch();
  return new MeaningReader({
    embedder: new Embedder({ keep: !desktop }),
    file: () => meaningIndexFile().catch(() => null),
    open: (sealed) => {
      if (vaultStore.epoch() !== epoch) throw new Error('The vault locked');
      return openMeaningIndex(ctx, sealed, MODEL_HASH);
    },
    idle,
  });
}

/**
 * How far the vectors have got ("By meaning: 340 of 1,200 pages so far",
 * `meaningProgress`), or null while search by meaning isn't running.
 */
export function useMeaningStatus(): MeaningStatus | null {
  // Subscribed again when the queue changes, so its own changes reach here.
  const indexer = useSyncExternalStore(subscribeRunning, meaningIndexer);
  const follow = useCallback(
    (listener: () => void) => indexer?.subscribe(listener) ?? (() => {}),
    [indexer],
  );
  return useSyncExternalStore(follow, () => indexer?.status() ?? null);
}

/**
 * Run the queue while `ctx` is open and search by meaning is on here; stop
 * it, dropping the vectors and the worker, when the vault locks or it goes
 * off. Where it is off or not offered, but for a phone's layout, the
 * vectors kept go too, and where it is off, the model's files a browser
 * kept.
 */
export function useMeaningIndex(ctx: ClientContext | null) {
  const queryClient = useQueryClient();
  const place = useMeaningPlace();
  const switchOn = useDeviceSwitch(searchByMeaning());
  const on = switchOn && place?.offer === 'offered';
  useEffect(() => {
    if (!ctx || !on) return;
    // Its turn may come after the vault locked and before this effect is
    // cleaned up: nothing starts with keys that are gone.
    const epoch = vaultStore.epoch();
    return oneTabAtATime(() => {
      if (vaultStore.epoch() !== epoch) return { flush: async () => {}, stop: () => {} };
      const started = startMeaningIndex(queryClient, ctx);
      setRunning(started.indexer);
      return {
        flush: () => started.indexer.flush(),
        stop() {
          started.stop();
          if (meaningIndexer() === started.indexer) setRunning(null);
        },
      };
    });
  }, [ctx, on, queryClient]);
  // In every tab, for its search dialog while another tab holds the queue.
  useEffect(() => {
    if (!ctx || !on) return;
    const reader = startMeaningReader(ctx);
    setReader(reader);
    return () => {
      reader.stop();
      if (meaningReader() === reader) setReader(null);
    };
  }, [ctx, on]);
  // A phone's layout may be a narrow window, which widens again: kept.
  // In every tab, after its own queue stopped above, so none puts back
  // what goes: the vectors, and when it is off, the model's files.
  const unkept = dropsKeptVectors(place);
  useEffect(() => {
    if (unkept) void dropMeaningIndex();
  }, [unkept]);
  useEffect(() => {
    if (!switchOn) void forgetModel().catch(() => {});
  }, [switchOn]);
}

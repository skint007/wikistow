import {
  matchesFilter,
  nearestPages,
  parseSearch,
  type KeptMeaning,
  type MeaningPassage,
  type SearchFilter,
  type searchOperations,
} from '@wikistow/client';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  meaningProgress,
  type IndexedPage,
  type MeaningFile,
  type MeaningHit,
  type MeaningIndexer,
  type MeaningStatus,
} from './meaning-index';
import { meaningIndexer, meaningReader, subscribeRunning } from './running';

// Search by meaning in the search dialog (ADR 0016, decision 6): the query
// embedded as typing pauses, the pages nearest it by their best passage,
// and what decides which are close enough to show.

/** At most this many pages are listed by meaning. */
export const MEANING_LIMIT = 5;

/**
 * A page is listed by meaning only if its best passage scores at least
 * this, and no further than `MEANING_GAP` below the best page listed.
 * Tuned on the spike's 33 notes and 36 queries (ADR 0016, step 5): the
 * page meant is listed for 33 of them, with about three pages a query.
 */
export const MEANING_FLOOR = 0.5;
export const MEANING_GAP = 0.1;

/** How long typing pauses before the query is embedded. */
export const MEANING_PAUSE_MS = 150;

/** A snippet's length at most, as word matches' are. */
const SNIPPET = 160;

/**
 * What of `query` is embedded: its words, without its filters and quotes,
 * or null when they hold fewer than three letters, as for filters alone.
 */
export function meaningText(query: string): string | null {
  const text = parseSearch(query)
    .words.replace(/["“”„]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (text.match(/\p{L}/gu)?.length ?? 0) >= 3 ? text : null;
}

/** Of `hits`, best first, those close enough to list (`MEANING_FLOOR`, `MEANING_GAP`). */
export function closeEnough<H extends { score: number }>(hits: readonly H[]): H[] {
  const best = hits[0]?.score ?? 0;
  return hits
    .filter(({ score }) => score >= MEANING_FLOOR && score >= best - MEANING_GAP)
    .slice(0, MEANING_LIMIT);
}

/** The start of the passage at `start` in a page's text, on one line, cut at a word. */
export function passageSnippet(text: string, start: number): string {
  const rest = text
    .slice(start, start + SNIPPET * 4)
    .replace(/\s+/g, ' ')
    .trim();
  if (rest.length <= SNIPPET) return rest;
  const space = rest.lastIndexOf(' ', SNIPPET);
  let end = space > SNIPPET / 2 ? space : SNIPPET;
  // Never between the halves of a character outside the BMP.
  if (/[\uD800-\uDBFF]/.test(rest.charAt(end - 1))) end--;
  return `${rest.slice(0, end).trimEnd()}…`;
}

/** Which pages a search by meaning keeps: its filters, and not those listed already. */
export type Include = (entry: searchOperations.IndexedEntry) => boolean;

/** What the search dialog finds pages by meaning with: the queue, or the vectors kept. */
export type MeaningSource = {
  /** A search's words as a vector, from the model in its worker. */
  query(text: string): Promise<Float32Array>;
  /** The `limit` pages of `index` nearest `query`, best first, of those `include` keeps. */
  nearest(
    index: searchOperations.PageIndex,
    query: ArrayLike<number>,
    limit: number,
    include?: Include,
  ): MeaningHit[];
  /** How far the vectors have got, of the pages `index` holds, or null if not known yet. */
  status(index: searchOperations.PageIndex): MeaningStatus | null;
  /** Call `listener` each time what `nearest` or `status` gives may change. */
  subscribe(listener: () => void): () => void;
  /** A value that changes whenever `subscribe` calls. */
  snapshot(): unknown;
  /** Start the worker and its model, and read what is kept, as search opens. */
  prepare(): void;
};

const sources = new WeakMap<MeaningIndexer, MeaningSource>();

/** The queue in this tab, as the search dialog's source: its own word index and vectors. */
export function queueSource(indexer: MeaningIndexer): MeaningSource {
  let source = sources.get(indexer);
  if (!source) {
    source = {
      query: (text) => indexer.query(text),
      nearest: (_index, query, limit, include) => indexer.nearest(query, limit, include),
      status: () => indexer.status(),
      subscribe: (listener) => indexer.subscribe(listener),
      snapshot: () => indexer.status(),
      prepare: () => indexer.prepare(),
    };
    sources.set(indexer, source);
  }
  return source;
}

/** What a reader needs from the app. */
export type ReaderWork = {
  /** The model, in a worker of the reader's own (`Embedder`). */
  embedder: {
    embed(kind: 'query', texts: string[]): Promise<{ vectors: Float32Array[] }>;
    load(): Promise<unknown>;
    stop(): void;
  };
  /** Where the vectors are kept, or null if they aren't here. */
  file(): Promise<MeaningFile | null>;
  /** What the queue sealed, or null if it isn't this person's for this model. */
  open(sealed: Uint8Array): KeptMeaning | null;
  /** Resolves once the page has a moment free. */
  idle(): Promise<void>;
};

/**
 * The vectors the queue kept, read for a tab whose search has no queue, as
 * one tab of a browser runs it (`oneTabAtATime`): a tab without it has no
 * vectors of its own. It reads the kept file each time search opens
 * (`prepare`), as the queue keeps it at least once a minute while it
 * embeds, and embeds queries with a worker of its own, which stops a
 * minute after the last. A page counts by the vectors of the version the
 * word index shows: until the queue keeps them, a page changed since is
 * found by its words alone. Stopped, as at a lock, the vectors and the
 * worker go.
 */
export class MeaningReader implements MeaningSource {
  readonly #work: ReaderWork;
  #kept: KeptMeaning | null = null;
  #reading: Promise<void> | null = null;
  #stopped = false;
  readonly #listeners = new Set<() => void>();

  constructor(work: ReaderWork) {
    this.#work = work;
  }

  /** Read the kept file again; one read under way serves. */
  refresh(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#reading ??= this.#read().finally(() => {
      this.#reading = null;
    });
    return this.#reading;
  }

  async #read() {
    try {
      const file = await this.#work.file();
      const sealed = file && (await file.read());
      if (this.#stopped) return;
      if (!sealed) return this.#set(new Map());
      // Opening takes some milliseconds a thousand pages: in a moment free.
      await this.#work.idle();
      if (this.#stopped) return;
      const kept = this.#work.open(sealed);
      if (!this.#stopped) this.#set(kept ?? new Map());
    } catch {
      // Unread, or locked meanwhile: what was read before stands.
    }
  }

  #set(kept: KeptMeaning) {
    this.#kept = kept;
    for (const listener of this.#listeners) listener();
  }

  prepare() {
    if (this.#stopped) return;
    void this.refresh();
    void this.#work.embedder.load().catch(() => {});
  }

  async query(text: string): Promise<Float32Array> {
    if (this.#stopped) throw new Error('Search by meaning stopped');
    const { vectors } = await this.#work.embedder.embed('query', [text]);
    if (!vectors[0]) throw new Error('The embedding worker gave no vector.');
    return vectors[0];
  }

  nearest(
    index: searchOperations.PageIndex,
    query: ArrayLike<number>,
    limit: number,
    include?: Include,
  ): MeaningHit[] {
    const kept = this.#kept;
    if (this.#stopped || !kept || kept.size === 0) return [];
    const pages: { page: IndexedPage; passages: readonly MeaningPassage[] }[] = [];
    for (const page of index.pages()) {
      const passages = kept.get(page.doc.revisionId);
      if (!passages || passages.length === 0) continue;
      if (include) {
        const entry = index.page(page.doc.spaceId, page.doc.pageId);
        if (!entry || !include(entry)) continue;
      }
      pages.push({ page, passages });
    }
    const found = nearestPages(
      query,
      pages.map(({ passages }, i) => [i, passages] as const),
      limit,
    );
    return found.map(({ key, passage, score }) => {
      const { page, passages } = pages[key]!;
      return {
        spaceId: page.doc.spaceId,
        pageId: page.doc.pageId,
        page,
        passage: passages[passage]!,
        score,
      };
    });
  }

  status(index: searchOperations.PageIndex): MeaningStatus | null {
    const kept = this.#kept;
    if (this.#stopped || !kept) return null;
    let pages = 0;
    for (const page of index.pages()) if (kept.has(page.doc.revisionId)) pages++;
    return { pages, total: index.size };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  snapshot(): unknown {
    return this.#kept;
  }

  /** Stop, as at a lock: the vectors and the worker go. */
  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#work.embedder.stop();
    this.#set(new Map());
  }
}

/**
 * Where this tab finds pages by meaning: the queue, if this tab runs it,
 * else the vectors kept; null while search by meaning isn't on here.
 */
export function useMeaningSource(): MeaningSource | null {
  const indexer = useSyncExternalStore(subscribeRunning, meaningIndexer);
  const reader = useSyncExternalStore(subscribeRunning, meaningReader);
  return indexer ? queueSource(indexer) : reader;
}

/** What the search dialog lists by meaning, and how far the vectors have got. */
export type MeaningResults = {
  /** The pages close enough in meaning, best first, none of them `listed`. */
  hits: MeaningHit[];
  /** "By meaning: 340 of 1,200 pages so far", while pages are left. */
  progress: string | null;
  /** The query has words enough to search by meaning (`meaningText`). */
  asks: boolean;
};

const keyOf = ({ spaceId, pageId }: { spaceId: string; pageId: string }) => `${spaceId}/${pageId}`;

/**
 * Search `index` by meaning for `query` (ADR 0016, decision 6), or null
 * while search by meaning isn't on here. The query's words are embedded
 * once typing pauses (`MEANING_PAUSE_MS`), in the worker, so typing never
 * waits on it; until a new vector comes, the last stands. Its filters
 * narrow the pages as they narrow word matches, and pages already
 * `listed`, as `spaceId/pageId`, are left out.
 */
export function useMeaningSearch(
  index: searchOperations.PageIndex | undefined,
  query: string,
  listed: readonly string[],
): MeaningResults | null {
  const source = useMeaningSource();
  const text = meaningText(query);
  const [asked, setAsked] = useState<{ source: MeaningSource; vector: Float32Array } | null>(null);
  useEffect(() => source?.prepare(), [source]);
  useEffect(() => {
    if (!source || text === null) {
      setAsked(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      source.query(text).then(
        (vector) => {
          if (current) setAsked({ source, vector });
        },
        // The model couldn't load, or stopped: words alone, this time.
        () => {},
      );
    }, MEANING_PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [source, text]);
  const follow = useCallback(
    (listener: () => void) => source?.subscribe(listener) ?? (() => {}),
    [source],
  );
  const snapshot = useSyncExternalStore(follow, () => source?.snapshot() ?? null);
  const vector = text !== null && asked?.source === source ? asked.vector : null;
  const listedKey = listed.join('\n');
  // Words typed change no filter: the pages aren't scanned again for them.
  const filtersKey = JSON.stringify(parseSearch(query).filters);
  const hits = useMemo(() => {
    if (!source || !index || !vector) return [];
    const filters = JSON.parse(filtersKey) as SearchFilter[];
    const shown = new Set(listedKey.split('\n'));
    const include: Include = (entry) =>
      !shown.has(keyOf(entry)) &&
      filters.every((filter) => matchesFilter(entry.properties, filter));
    return closeEnough(source.nearest(index, vector, MEANING_LIMIT, include));
    // `snapshot` changes as the vectors do.
  }, [source, index, vector, filtersKey, listedKey, snapshot]);
  const status = useMemo(
    () => (source && index ? source.status(index) : null),
    [source, index, snapshot],
  );
  if (!source) return null;
  return { hits, progress: meaningProgress(status), asks: text !== null };
}

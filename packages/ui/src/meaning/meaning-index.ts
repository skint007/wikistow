import {
  estimateTokens,
  meaningPassages,
  nearestPages,
  quantizeVector,
  type IndexedPage as IndexedOf,
  type KeptMeaning,
  type MeaningPassage,
  type PageId,
  type RevisionId,
  type searchOperations,
  type SpaceId,
  type Vector8,
} from '@wikistow/client';
import { KEEP_AT_MOST_MS, KEEP_MS, systemClock, type Clock } from '../data/index-tracker';
import { ModelUnavailable } from './embedder';

// Search by meaning's background queue (ADR 0016, decision 4): the vectors
// of each page the word index holds, made one passage at a time after the
// word index is built, kept by version, and kept on the device where the
// word index is. Nothing here knows React, React Query or the worker: the
// app hands it the word index as it changes and what it needs as
// `MeaningWork` (`background.ts`), so tests drive it by hand.

/** How long a draft this person types waits after its last save before it is embedded. */
export const DRAFT_PAUSE_MS = 30_000;

/**
 * How long the queue rests after each passage, as a share of the time the
 * passage took, so the worker takes at most two thirds of a core; and at
 * least, so the page always gets a turn.
 */
export const REST_SHARE = 0.5;
export const REST_AT_LEAST_MS = 20;
export const REST_AT_MOST_MS = 5_000;

/** How long the queue waits before looking again while a page opens or the word index updates. */
export const BUSY_WAIT_MS = 250;

/** How long the queue waits after the worker failed, before it tries again. */
export const RETRY_MS = 60_000;

/** How far the vectors have got: pages with vectors, of the pages the word index holds. */
export type MeaningStatus = { pages: number; total: number };

/** "By meaning: 340 of 1,200 pages so far" while pages are left to embed, else null. */
export function meaningProgress(status: MeaningStatus | null): string | null {
  if (!status || status.pages >= status.total) return null;
  return `By meaning: ${status.pages.toLocaleString('en')} of ${status.total.toLocaleString('en')} pages so far`;
}

/** Where this device keeps the vectors, sealed (`sealMeaningIndex`). */
export type MeaningFile = {
  read(): Promise<Uint8Array | null>;
  write(sealed: Uint8Array): Promise<void>;
};

/** What the queue needs from the app. */
export type MeaningWork = {
  /** The model, in its worker (`Embedder`). */
  embedder: {
    count(words: string[]): Promise<number[]>;
    embed(kind: 'passage', texts: string[]): Promise<{ vectors: Float32Array[] }>;
    stop(): void;
  };
  /** Where the vectors are kept now, or null to keep them only in memory. */
  file(): Promise<MeaningFile | null>;
  /** The vectors, sealed for this person and model. */
  seal(kept: KeptMeaning): Uint8Array;
  /** What `seal` sealed, or null if it isn't this person's for this model. */
  open(sealed: Uint8Array): KeptMeaning | null;
  /** A page is opening, or the word index updating: the queue waits. */
  busy(): boolean;
  /** Resolves once the page has a moment free (`requestIdleCallback`). */
  idle(): Promise<void>;
  clock?: Clock;
};

/** A page found by meaning (`MeaningIndexer.nearest`), with the passage that matched best. */
export type MeaningHit = {
  spaceId: SpaceId;
  pageId: PageId;
  passage: MeaningPassage;
  score: number;
};

type IndexedPage = Readonly<IndexedOf<searchOperations.SearchPage>>;
type SavedVersion = Pick<
  searchOperations.SavedVersion,
  'spaceId' | 'pageId' | 'revisionId' | 'basedOn'
>;

const keyOf = (spaceId: SpaceId, pageId: PageId) => `${spaceId}/${pageId}`;

/** A run without spaces: what the tokenizer counts (`meaningPassages`). */
const WORD = /\S+/g;

/**
 * The vectors of every page the word index holds, each in the version it
 * shows (ADR 0016, decision 4):
 *
 * - **Kept vectors open first.** The file kept before is read and opened
 *   before anything else; only versions without vectors are embedded.
 * - **In the background,** each page whose version has no vectors yet,
 *   most recently changed first, one passage at a time. After each passage
 *   it rests half as long as the passage took, and waits while a page opens
 *   or the word index updates and for the page to have a moment free, so a
 *   search or a page opening never waits behind it. A passage whose text
 *   has a vector already, in any version kept, isn't embedded again, so an
 *   edit to one section embeds one passage.
 * - **Drafts.** A version this person saved is embedded once their saves
 *   of the page have paused for `DRAFT_PAUSE_MS`; until then, the version
 *   before stands in. Any other version replaced, and any page the word
 *   index lets go, goes at once.
 * - **Kept** where `file` says, once embedding pauses (`KEEP_MS`), at least
 *   once a minute while it goes on (`KEEP_AT_MOST_MS`), and at once after a
 *   version goes that isn't this person's draft saved over.
 * - **Stopped** (`stop`), as at a lock, it drops every vector and the
 *   worker, and keeps nothing after.
 */
export class MeaningIndexer {
  readonly #work: MeaningWork;
  readonly #clock: Clock;
  /** The vectors of each version, by revision ID. */
  readonly #kept = new Map<RevisionId, readonly MeaningPassage[]>();
  /** Each passage's vector by its text's hash, of the versions kept. */
  readonly #byHash = new Map<string, Vector8>();
  /** What each version's vectors were made from, this session; one from the file isn't known. */
  readonly #madeFrom = new Map<RevisionId, { title: string; text: string }>();
  /** Versions whose text changed under the same revision ID, as a save into the queue does. */
  readonly #rewritten = new Set<RevisionId>();
  /** For a page whose draft waits, the version whose vectors stand in for it. */
  readonly #held = new Map<string, RevisionId>();
  /** When this person last saved each page, and the versions they saved. */
  readonly #savedAt = new Map<string, number>();
  readonly #ownVersions = new Set<RevisionId>();
  /**
   * For a page whose version was replaced, or given up as it changed while
   * embedded, the vectors of the passages made so far, by hash: in memory
   * only, never searched or kept, until the page's next version has its
   * own, so an edit to one section embeds that passage alone.
   */
  readonly #reusable = new Map<string, Map<string, Vector8>>();
  readonly #listeners = new Set<() => void>();

  #index: searchOperations.PageIndex | null = null;
  /** Each page the word index holds, by key. */
  #shown = new Map<string, IndexedPage>();
  /** The pages left to embed, best first, from `#cursor` on. */
  #todo: string[] = [];
  #cursor = 0;
  #status: MeaningStatus | null = null;
  #opened: Promise<void>;
  #isOpen = false;
  #running = false;
  #again = false;
  #stopped = false;
  /** When the rest after the last passage ends. */
  #restUntil = 0;
  #wakeAt: { at: number; cancel: () => void } | null = null;
  /** The word index shown is partial (`indexChanged`): nothing is let go of. */
  #partial = false;
  /** Whether the index last given was partial, followed or not yet. */
  #indexPartial = false;
  /** Each page's version when the word index went, until a whole one comes. */
  #lastVersions: Map<string, RevisionId> | null = null;
  /** Since the word index went (`indexGone`), no whole one has come: what a lost grant took may still be here. */
  #unsure = false;
  /** Reading the kept file failed: this session writes nothing over it. */
  #unread = false;
  /** A write came while no whole word index was shown: it follows the next, at once if it was to be. */
  #deferred: 'now' | 'later' | null = null;
  /** Pages passed over as their passages failed twice, by the version that failed, and the first failure. */
  readonly #failed = new Map<string, RevisionId>();
  #failing: { key: string; revisionId: RevisionId } | null = null;
  #keeping: { since: number; now: boolean; cancel: () => void } | null = null;

  constructor(work: MeaningWork) {
    this.#work = work;
    this.#clock = work.clock ?? systemClock;
    this.#opened = this.#open();
  }

  /** Read and open the vectors kept before, if any. */
  async #open() {
    try {
      const file = await this.#work.file();
      let sealed: Uint8Array | null = null;
      try {
        sealed = file && (await file.read());
      } catch (error) {
        // Unread, it may hold what this session would write over.
        this.#unread = true;
        throw error;
      }
      if (this.#stopped || !sealed) return;
      // Opening takes some milliseconds a thousand pages: in a moment free.
      await this.#work.idle();
      if (this.#stopped) return;
      const kept = this.#work.open(sealed);
      if (!kept || this.#stopped) return;
      for (const [revisionId, passages] of kept) this.#store(revisionId, passages);
    } catch {
      // Nothing kept, or it can't be opened: every page is embedded again.
    } finally {
      this.#isOpen = true;
    }
  }

  /**
   * The word index, built or updated: what to embed, and what to let go.
   * One built offline from the pages kept alone (`partial`) may lack pages
   * that are still there: it lets go of nothing, until a whole one does.
   */
  indexChanged(index: searchOperations.PageIndex, { partial = false }: { partial?: boolean } = {}) {
    // The same index once partial may come again whole, updated online with nothing changed.
    if (this.#stopped || (index === this.#index && partial === this.#indexPartial)) return;
    this.#index = index;
    this.#indexPartial = partial;
    if (!this.#isOpen) {
      void this.#opened.then(() => {
        if (this.#index === index && this.#indexPartial === partial) this.#follow(index, partial);
      });
      return;
    }
    this.#follow(index, partial);
  }

  #follow(index: searchOperations.PageIndex, partial: boolean) {
    if (this.#stopped) return;
    this.#partial = partial;
    if (!partial) this.#unsure = false;
    const before = this.#shown;
    // Each page's version before, or before the index went (`indexGone`).
    const lastVersions = this.#lastVersions;
    const oldOf = (key: string) => before.get(key)?.doc.revisionId ?? lastVersions?.get(key);
    if (!partial) this.#lastVersions = null;
    const shown = new Map<string, IndexedPage>();
    for (const page of index.pages()) shown.set(keyOf(page.doc.spaceId, page.doc.pageId), page);
    this.#shown = shown;
    // A draft, this person's or one the index shows as a draft they can
    // edit (saved in another tab, say), waits until its versions pause, and
    // the version before stands in for the page until then; for any other
    // version, nothing does.
    const now = this.#clock.now();
    for (const [key, page] of shown) {
      const old = oldOf(key);
      if (!old || old === page.doc.revisionId) continue;
      this.#reuse(key, this.#kept.get(old));
      const draft = page.doc.draft || this.#ownVersions.has(page.doc.revisionId);
      if (page.doc.draft) {
        this.#savedAt.set(key, Math.max(this.#savedAt.get(key) ?? now, now));
        this.#wakeIn(DRAFT_PAUSE_MS);
      }
      // Nothing stands in for a version that has its own vectors already.
      if (draft && !this.#done(page)) {
        const standing = this.#held.get(key) ?? old;
        if (this.#kept.has(standing)) this.#held.set(key, standing);
      } else this.#held.delete(key);
    }
    // A partial index: pages it lacks keep what stands in for them, for the next.
    if (!partial) {
      for (const key of this.#held.keys()) if (!shown.has(key)) this.#held.delete(key);
      for (const key of this.#reusable.keys()) if (!shown.has(key)) this.#reusable.delete(key);
    }
    // A version let go of goes from the file at once, as from memory: its
    // page left, or another's version replaced it. Only a draft this person
    // saved over waits, which happens once its next version is embedded.
    const letGo = !partial && this.#prune();
    if (letGo || this.#deferred) this.#keep(letGo || this.#deferred === 'now');
    this.#deferred = null;
    this.#plan();
    this.#wake();
  }

  /**
   * The word index went, as when access changes and it is built afresh
   * (`refreshAccess`): until the next, no page is found or embedded, and
   * nothing is kept, since what it held may no longer be this person's to
   * read. The vectors stay in memory, for the versions the next still shows.
   */
  indexGone() {
    if (this.#stopped || !this.#index) return;
    this.#index = null;
    this.#unsure = true;
    // No text of a page the grant may have taken stays; a version's
    // vectors are then taken as made from the text it shows next.
    this.#madeFrom.clear();
    // Only versions, not text, kept to tell the next index what changed.
    // The newest known of each: one followed since the last time it went
    // (a partial index) stands for its pages.
    const versions = new Map(this.#lastVersions ?? []);
    for (const [key, page] of this.#shown) versions.set(key, page.doc.revisionId);
    this.#lastVersions = versions;
    this.#shown = new Map();
    this.#todo = [];
    this.#cursor = 0;
    this.#setStatus(null);
  }

  /** A draft this person saved: it waits until their saves of the page pause. */
  saved(save: SavedVersion) {
    if (this.#stopped) return;
    const key = keyOf(save.spaceId, save.pageId);
    this.#savedAt.set(key, this.#clock.now());
    this.#ownVersions.add(save.revisionId);
    // Into this device's queue, on its base: the same version, another
    // text, so one passed over as it failed is tried again.
    if (save.revisionId === save.basedOn) {
      this.#rewritten.add(save.revisionId);
      this.#failed.delete(key);
      if (this.#failing?.key === key) this.#failing = null;
    }
    this.#wakeIn(DRAFT_PAUSE_MS);
  }

  /** How far the vectors have got, or null before the word index is built, or once stopped. */
  status(): MeaningStatus | null {
    return this.#status;
  }

  /** Call `listener` each time `status` changes, until the returned function is called. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * The `limit` pages whose vectors are nearest `query`, best first, of
   * those the word index holds and `include` keeps (`nearestPages`): each
   * by its best passage, in the version it shows, or the one standing in
   * for a draft.
   */
  nearest(
    query: ArrayLike<number>,
    limit: number,
    include?: (entry: searchOperations.IndexedEntry) => boolean,
  ): MeaningHit[] {
    const index = this.#index;
    if (this.#stopped || !index) return [];
    const pages = new Map<string, { page: IndexedPage; passages: readonly MeaningPassage[] }>();
    for (const [key, page] of this.#shown) {
      const passages = this.#standing(key, page);
      if (!passages || passages.length === 0) continue;
      if (include) {
        const entry = index.page(page.doc.spaceId, page.doc.pageId);
        if (!entry || !include(entry)) continue;
      }
      pages.set(key, { page, passages });
    }
    const found = nearestPages(
      query,
      [...pages].map(([key, { passages }]) => [key, passages] as const),
      limit,
    );
    return found.map(({ key, passage, score }) => {
      const { page, passages } = pages.get(key)!;
      return {
        spaceId: page.doc.spaceId,
        pageId: page.doc.pageId,
        passage: passages[passage]!,
        score,
      };
    });
  }

  /** Keep at once what waits to be kept, as before another tab takes the queue over. */
  async flush(): Promise<void> {
    if (this.#stopped) return;
    if (this.#keeping) {
      const { now } = this.#keeping;
      this.#keeping.cancel();
      this.#keeping = null;
      void this.#writeNow(now);
    }
    await this.#writing;
  }

  /** Stop, as at a lock: the vectors and the worker go, and nothing is kept after. */
  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#work.embedder.stop();
    this.#wakeAt?.cancel();
    this.#keeping?.cancel();
    this.#wakeAt = null;
    this.#keeping = null;
    for (const wake of [...this.#sleeps]) wake();
    this.#kept.clear();
    this.#byHash.clear();
    this.#madeFrom.clear();
    this.#held.clear();
    this.#reusable.clear();
    this.#lastVersions = null;
    this.#shown = new Map();
    this.#todo = [];
    this.#index = null;
    this.#setStatus(null);
  }

  /**
   * The vectors that stand for `page` now: its version's; for a draft, the
   * version before's; for a save into the queue, those of its text before.
   */
  #standing(key: string, page: IndexedPage): readonly MeaningPassage[] | undefined {
    const own = this.#kept.get(page.doc.revisionId);
    if (own && this.#done(page)) return own;
    const held = this.#held.get(key);
    return (held === undefined ? undefined : this.#kept.get(held)) ?? own;
  }

  /** `page`'s version has its vectors, made from the text the word index holds. */
  #done(page: IndexedPage): boolean {
    const { revisionId } = page.doc;
    if (!this.#kept.has(revisionId) || this.#rewritten.has(revisionId)) return false;
    const made = this.#madeFrom.get(revisionId);
    return !made || (made.title === page.title && made.text === page.text);
  }

  /** How long until this person's saves of the page have paused for `DRAFT_PAUSE_MS`, or 0. */
  #pauseLeft(key: string): number {
    const at = this.#savedAt.get(key);
    // At most the pause, should the clock be set back.
    return at === undefined
      ? 0
      : Math.min(DRAFT_PAUSE_MS, Math.max(0, at + DRAFT_PAUSE_MS - this.#clock.now()));
  }

  /** Keep `passages`' vectors for `key`'s next version (`#reusable`). */
  #reuse(key: string, passages: Iterable<{ hash: string; vector: Vector8 }> | undefined) {
    if (!passages) return;
    let reusable = this.#reusable.get(key);
    if (!reusable) this.#reusable.set(key, (reusable = new Map()));
    for (const { hash, vector } of passages) reusable.set(hash, vector);
  }

  #store(revisionId: RevisionId, passages: readonly MeaningPassage[]) {
    this.#kept.set(revisionId, passages);
    for (const { hash, vector } of passages) this.#byHash.set(hash, vector);
  }

  /** Let go of every version no page shows, and no draft stands in on: true if any went. */
  #prune(): boolean {
    const wanted = new Set<RevisionId>(this.#held.values());
    for (const page of this.#shown.values()) wanted.add(page.doc.revisionId);
    let any = false;
    for (const revisionId of this.#kept.keys()) {
      if (wanted.has(revisionId)) continue;
      this.#kept.delete(revisionId);
      this.#madeFrom.delete(revisionId);
      this.#rewritten.delete(revisionId);
      any = true;
    }
    if (any) {
      this.#byHash.clear();
      for (const passages of this.#kept.values()) {
        for (const { hash, vector } of passages) this.#byHash.set(hash, vector);
      }
    }
    return any;
  }

  /** The pages left to embed, most recently changed first, and the status. */
  #plan() {
    const left: IndexedPage[] = [];
    let pages = 0;
    let total = 0;
    for (const [key, page] of this.#shown) {
      // One that can't be embedded can't be found by meaning: not counted.
      const failed = this.#failed.get(key);
      if (failed !== undefined && failed !== page.doc.revisionId) this.#failed.delete(key);
      if (this.#failed.has(key)) continue;
      total++;
      if (this.#standing(key, page)) pages++;
      if (!this.#done(page)) left.push(page);
    }
    for (const key of this.#failed.keys()) if (!this.#shown.has(key)) this.#failed.delete(key);
    left.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
    this.#todo = left.map((page) => keyOf(page.doc.spaceId, page.doc.pageId));
    this.#cursor = 0;
    this.#setStatus({ pages, total });
  }

  #setStatus(status: MeaningStatus | null) {
    const before = this.#status;
    if (before === status) return;
    if (before && status && before.pages === status.pages && before.total === status.total) return;
    this.#status = status;
    for (const listener of this.#listeners) listener();
  }

  /** The next page to embed, or null; a draft still being typed waits, and wakes the queue later. */
  #next(): IndexedPage | null {
    while (this.#cursor < this.#todo.length) {
      const key = this.#todo[this.#cursor]!;
      const page = this.#shown.get(key);
      if (!page || this.#done(page) || this.#failed.has(key)) {
        this.#cursor++;
        continue;
      }
      const left = this.#pauseLeft(key);
      if (left > 0) {
        // Passed over now, and planned again once its pause ends.
        this.#wakeIn(left);
        this.#cursor++;
        continue;
      }
      return page;
    }
    return null;
  }

  /** Wake the queue in `ms`, or sooner if already due. */
  #wakeIn(ms: number) {
    const at = this.#clock.now() + ms;
    if (this.#wakeAt && this.#wakeAt.at <= at) return;
    this.#wakeAt?.cancel();
    this.#wakeAt = {
      at,
      cancel: this.#clock.after(ms, () => {
        this.#wakeAt = null;
        if (this.#stopped || !this.#index) return;
        this.#plan();
        this.#wake();
      }),
    };
  }

  /** Run the queue, unless it runs already; one running takes what changed at its next page. */
  #wake() {
    if (this.#stopped) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    void this.#run();
  }

  async #run() {
    try {
      for (;;) {
        this.#again = false;
        const page = this.#stopped ? null : this.#next();
        if (!page) {
          if (this.#again && !this.#stopped) continue;
          break;
        }
        try {
          await this.#embedPage(page);
        } catch (error) {
          if (this.#stopped) break;
          // A page that fails twice in a row once the model has loaded,
          // refused or stopping the worker, is passed over until its
          // version changes; a model that can't load is tried again later.
          if (!(error instanceof ModelUnavailable)) {
            const key = keyOf(page.doc.spaceId, page.doc.pageId);
            const again =
              this.#failing?.key === key && this.#failing.revisionId === page.doc.revisionId;
            this.#failing = again ? null : { key, revisionId: page.doc.revisionId };
            if (again) {
              this.#failed.set(key, page.doc.revisionId);
              if (this.#index) this.#plan();
              continue;
            }
          }
          await this.#sleep(RETRY_MS);
          if (this.#stopped) break;
          if (this.#index) this.#plan();
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /** `page` changed, left, or waits on its draft since its embedding started: give it up. */
  #given(key: string, page: IndexedPage): boolean {
    if (this.#stopped || this.#pauseLeft(key) > 0) return true;
    const now = this.#shown.get(key);
    return (
      !now ||
      now.doc.revisionId !== page.doc.revisionId ||
      now.title !== page.title ||
      now.text !== page.text
    );
  }

  async #embedPage(page: IndexedPage) {
    const key = keyOf(page.doc.spaceId, page.doc.pageId);
    const { revisionId } = page.doc;
    // Passages are cut by the model's own count of each word's tokens,
    // asked of the worker at the queue's pace, as each passage is.
    await this.#pace();
    if (this.#given(key, page)) return;
    const words = [...new Set([...`${page.title}\n${page.text}`.matchAll(WORD)].map(([w]) => w))];
    const counts = await this.#work.embedder.count(words);
    if (this.#given(key, page)) return;
    const counted = new Map(words.map((word, i) => [word, counts[i] ?? estimateTokens(word)]));
    const passages = meaningPassages(page, {
      countTokens: (word) => counted.get(word) ?? estimateTokens(word),
    });
    const made: MeaningPassage[] = [];
    for (const passage of passages) {
      let vector = this.#byHash.get(passage.hash) ?? this.#reusable.get(key)?.get(passage.hash);
      if (!vector) {
        await this.#pace();
        if (this.#given(key, page)) {
          // What it made so far serves the page's next version.
          if (!this.#stopped) this.#reuse(key, made);
          return;
        }
        const started = this.#clock.now();
        const { vectors } = await this.#work.embedder.embed('passage', [passage.text]);
        const ended = this.#clock.now();
        this.#restUntil = ended + Math.max(REST_AT_LEAST_MS, (ended - started) * REST_SHARE);
        if (!vectors[0]) throw new Error('The embedding worker gave no vector.');
        vector = quantizeVector(vectors[0]);
        if (this.#given(key, page)) {
          if (!this.#stopped) this.#reuse(key, [...made, { hash: passage.hash, vector }]);
          return;
        }
      }
      made.push({ hash: passage.hash, start: passage.start, vector });
    }
    this.#reusable.delete(key);
    if (this.#failing?.key === key) this.#failing = null;
    const had = this.#standing(key, page) !== undefined;
    this.#store(revisionId, made);
    this.#madeFrom.set(revisionId, { title: page.title, text: page.text });
    this.#rewritten.delete(revisionId);
    const held = this.#held.get(key);
    this.#held.delete(key);
    // The version that stood in goes, unless the index may lack pages.
    if (held !== undefined && !this.#partial) this.#prune();
    const status = this.#status;
    if (status && !had) this.#setStatus({ pages: status.pages + 1, total: status.total });
    this.#keep(false);
  }

  /** Rest after the last passage, then wait while a page opens or the index updates, and for a moment free. */
  async #pace() {
    // At most a rest's longest, should the clock be set back.
    const rest = Math.min(REST_AT_MOST_MS, this.#restUntil - this.#clock.now());
    if (rest > 0) await this.#sleep(rest);
    while (!this.#stopped && this.#work.busy()) await this.#sleep(BUSY_WAIT_MS);
    if (!this.#stopped) await this.#work.idle();
  }

  /** Sleeps under way, each ended at once by `stop`, so none holds a page past a lock. */
  readonly #sleeps = new Set<() => void>();

  #sleep(ms: number): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        cancel();
        this.#sleeps.delete(wake);
        resolve();
      };
      const cancel = this.#clock.after(ms, wake);
      this.#sleeps.add(wake);
    });
  }

  /**
   * Keep the vectors once they stop changing for `KEEP_MS`, or
   * `KEEP_AT_MOST_MS` after they first changed; with `now`, at once.
   */
  #keep(now: boolean) {
    if (this.#stopped || this.#keeping?.now) return;
    const at = this.#clock.now();
    const since = this.#keeping?.since ?? at;
    this.#keeping?.cancel();
    const wait = now ? 0 : Math.max(0, Math.min(KEEP_MS, since + KEEP_AT_MOST_MS - at));
    this.#keeping = {
      since: now ? at : since,
      now,
      cancel: this.#clock.after(wait, () => {
        this.#keeping = null;
        void this.#writeNow(now);
      }),
    };
  }

  /** The write under way, if any. */
  #writing: Promise<void> | null = null;

  /** Write now, after any write under way, so one never overtakes another. */
  #writeNow(now: boolean): Promise<void> {
    const after = this.#writing ?? Promise.resolve();
    const writing = after.then(() => this.#write(now)).catch(() => {});
    this.#writing = writing;
    void writing.then(() => {
      if (this.#writing === writing) this.#writing = null;
    });
    return writing;
  }

  /**
   * Seal and keep the vectors. Sealing takes some milliseconds a thousand
   * pages, so in a moment free, unless `now`: a version let go of goes from
   * the file before a lock can come and leave it there.
   */
  async #write(now: boolean) {
    await this.#opened;
    const file = await this.#work.file();
    if (file && !this.#stopped && !now) await this.#work.idle();
    // Stopped meanwhile, the keys may be gone: nothing is sealed with them.
    if (!file || this.#stopped) return;
    // Kept file unread: nothing written over it, this session.
    if (this.#unread) return;
    // Built afresh as access changed: kept once a whole index lets go.
    if (!this.#index || this.#unsure) {
      this.#deferred = now || this.#deferred === 'now' ? 'now' : 'later';
      return;
    }
    await file.write(this.#work.seal(this.#kept));
  }
}

import type { searchOperations, SpaceId } from '@wikistow/client';

// What changed since the search index was last updated, for its next
// update, and when this device keeps it. Nothing here knows React Query:
// the index's query is reached through `IndexQuery`, and time through
// `Clock`, so tests drive both by hand.

/** How long changes gather, while something shows the index, before it follows them together. */
export const GATHER_MS = 300;

/** How long this device waits for changes to pause before keeping the index, and at most. */
export const KEEP_MS = 5_000;
export const KEEP_AT_MOST_MS = 60_000;

/** The index's query, as the tracker follows it. */
export type IndexQuery = {
  /** Whether something shows the index now. */
  shown(): boolean;
  /** The update running now, if any, which may have started before a change. */
  running(): Promise<unknown> | null;
  /** Mark the index stale: it updates now if shown, else when next shown. */
  stale(): void;
};

export type Clock = {
  now(): number;
  /** Run `run` after `ms`, unless the returned function is called first. */
  after(ms: number, run: () => void): () => void;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * A change for the index: the spaces it was in (every one for 'all'), or a
 * draft this person saved, as written, which the index takes without
 * listing anything (`updateIndex`).
 */
export type IndexChange =
  | { spaces: readonly SpaceId[] | 'all' }
  | { saved: searchOperations.SavedVersion };

export type IndexTracker = ReturnType<typeof createIndexTracker>;

/**
 * Track the changes the index behind `query` hasn't taken. A change is
 * followed at once when nothing shows the index (it updates when next
 * shown), and otherwise with the other changes in the next `GATHER_MS`.
 */
export function createIndexTracker(query: IndexQuery, clock: Clock = systemClock) {
  /** The spaces changed since the last update, or every one; null for none. */
  let spaces: Set<SpaceId> | 'all' | null = null;
  /** This person's own drafts saved since, in order. */
  let saved: searchOperations.SavedVersion[] = [];
  let gathering: (() => void) | null = null;
  let keeping: { since: number; now: boolean; cancel: () => void } | null = null;

  const noted = () => spaces !== null || saved.length > 0;

  function changed(changedSpaces: Iterable<SpaceId> | 'all') {
    if (changedSpaces === 'all' || spaces === 'all') spaces = 'all';
    else spaces = new Set([...(spaces ?? []), ...changedSpaces]);
  }

  // One save over a save still waiting stands in for it, over what that was
  // saved over, so a page's autosaves wait as one. One into this device's
  // queue, on its base, keeps the time of the save it stands in for.
  function noteSave(save: searchOperations.SavedVersion) {
    const at = saved.findIndex(
      (before) =>
        before.spaceId === save.spaceId &&
        before.pageId === save.pageId &&
        before.revisionId === save.basedOn,
    );
    const before = saved[at];
    if (!before) saved.push(save);
    else {
      const queued = save.revisionId === save.basedOn;
      const updated = queued ? before.updated : save.updated;
      saved.splice(at, 1, {
        ...save,
        basedOn: before.basedOn,
        ...(updated === undefined ? {} : { updated }),
      });
    }
  }

  /**
   * Note each save as its space alone: the next update lists it, so no
   * draft's text waits here while nothing shows the index.
   */
  function dropSaves() {
    if (saved.length === 0) return;
    changed(saved.map(({ spaceId }) => spaceId));
    saved = [];
  }

  // Marks the index stale, which updates it now if something shows it. One
  // already updating finishes first, then the changes it didn't take, if
  // any, mark it stale again: its success would mark it fresh.
  function follow() {
    // Taken already, by an update that started meanwhile.
    if (!noted()) return;
    if (!query.shown()) dropSaves();
    const running = query.running();
    query.stale();
    if (!running) return;
    const untaken = () => {
      if (!noted()) return;
      if (!query.shown()) dropSaves();
      query.stale();
    };
    void running.then(untaken, untaken);
  }

  return {
    /**
     * Note a change. An update already running may have started before it,
     * so another follows it if so, and changes meanwhile share that one: a
     * stream of autosaves can't keep putting it off.
     */
    note(change: IndexChange) {
      const shown = query.shown();
      if ('saved' in change) {
        if (shown) noteSave(change.saved);
        else changed([change.saved.spaceId]);
      } else changed(change.spaces);
      if (!shown) {
        follow();
        return;
      }
      gathering ??= clock.after(GATHER_MS, () => {
        gathering = null;
        follow();
      });
    },

    /**
     * What changed since the last update, for the next. With nothing noted,
     * as when the index is shown again a minute old, every space.
     */
    take(): searchOperations.IndexChanges {
      const taken: searchOperations.IndexChanges =
        spaces === 'all' || !noted()
          ? { spaces: 'all', saved }
          : { spaces: [...(spaces ?? [])], saved };
      spaces = null;
      saved = [];
      return taken;
    },

    /** Note again what an update that failed took, before what came since, for the next update. */
    putBack(changes: searchOperations.IndexChanges) {
      changed(changes.spaces);
      saved = [...(changes.saved ?? []), ...saved];
    },

    dropSaves,

    /**
     * Once the index has stopped changing for `KEEP_MS`, or `KEEP_AT_MOST_MS`
     * after it first changed, `write` keeps it: once for a burst of changes,
     * not once each. With `now`, at once (on the next turn, after React
     * Query takes it as the index shown), and a write due at once stays so.
     * A failed write only means reading more pages at the next launch.
     */
    keep(now: boolean, write: () => Promise<void>) {
      if (keeping?.now) return;
      const at = clock.now();
      const since = keeping?.since ?? at;
      keeping?.cancel();
      const wait = now ? 0 : Math.max(0, Math.min(KEEP_MS, since + KEEP_AT_MOST_MS - at));
      keeping = {
        since: now ? at : since,
        now,
        cancel: clock.after(wait, () => {
          keeping = null;
          void write().catch(() => {});
        }),
      };
    },

    /** Drop what changed and what waits: the index it was for is gone, as at a lock. */
    forget() {
      gathering?.();
      keeping?.cancel();
      spaces = null;
      saved = [];
      gathering = null;
      keeping = null;
    },
  };
}

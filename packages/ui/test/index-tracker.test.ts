// What the search index is asked to take with each update, and when this
// device keeps it, with time and the index's query driven by hand.
import { PageId, RevisionId, SpaceId, type searchOperations } from '@wikistow/client';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  createIndexTracker,
  GATHER_MS,
  KEEP_AT_MOST_MS,
  KEEP_MS,
  type Clock,
} from '../src/data/index-tracker.ts';

const home = SpaceId.parse('home');
const work = SpaceId.parse('work');

/** A clock whose timers run only when the test moves it on. */
function manualClock() {
  let time = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const clock: Clock = {
    now: () => time,
    after(ms, run) {
      const timer = { at: time + ms, run };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
  };
  const advance = (ms: number) => {
    const end = time + ms;
    for (;;) {
      const next = [...timers].filter(({ at }) => at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.delete(next);
      time = next.at;
      next.run();
    }
    time = end;
  };
  return { clock, advance };
}

// Let promise callbacks run, as an update settles.
const settled = () => new Promise((resolve) => setTimeout(resolve));

/**
 * The index's query as React Query runs it: marked stale, it updates if
 * something shows it and nothing updates already, and each update takes
 * what changed. One that ends is fresh again, as its success makes it.
 */
function indexQuery() {
  const { clock, advance } = manualClock();
  let shown = true;
  let stale = false;
  let running: Promise<void> | null = null;
  const updates: { changes: searchOperations.IndexChanges; end: () => Promise<void> }[] = [];
  const start = () => {
    stale = false;
    const changes = tracker.take();
    let done = () => {};
    running = new Promise((resolve) => (done = resolve));
    updates.push({
      changes,
      end: async () => {
        running = null;
        stale = false;
        done();
        await settled();
      },
    });
  };
  const tracker = createIndexTracker(
    {
      shown: () => shown,
      running: () => running,
      stale() {
        stale = true;
        if (shown && !running) start();
      },
    },
    clock,
  );
  /** What each update took: the spaces, then the saves' versions, if any. */
  const taken = () =>
    updates.map(({ changes: { spaces, saved = [] } }) =>
      saved.length > 0 ? [spaces, saved.map(({ revisionId }) => revisionId)] : spaces,
    );
  return {
    tracker,
    advance,
    updates,
    taken,
    /** An update starting by itself, as a retry's or the first build's. */
    start,
    hide: () => void (shown = false),
    show() {
      shown = true;
      if (stale && !running) start();
    },
    stale: () => stale,
  };
}

/** A draft of soup, `revisionId`, saved over `basedOn`. */
const save = (basedOn: string, revisionId: string): searchOperations.SavedVersion => ({
  spaceId: home,
  pageId: PageId.parse('soup'),
  basedOn: RevisionId.parse(basedOn),
  revisionId: RevisionId.parse(revisionId),
  payload: { title: 'soup', markdown: revisionId, extensions: {} },
});

describe('the search index’s changes', () => {
  it('gathers what changes while it is shown into one update, of the spaces named', async () => {
    const index = indexQuery();
    index.tracker.note({ spaces: [home] });
    index.advance(GATHER_MS - 1);
    index.tracker.note({ spaces: [work, home] });
    expect(index.updates).toHaveLength(0);
    // Changes still coming don't put it off.
    index.advance(1);
    expect(index.taken()).toEqual([[home, work]]);
    await index.updates[0]?.end();
    // Back in view, or after the stream dropped: anything may have changed.
    index.tracker.note({ spaces: 'all' });
    index.tracker.note({ spaces: [home] });
    index.advance(GATHER_MS);
    expect(index.taken()).toEqual([[home, work], 'all']);
  });

  it('follows an update already running with one more, which changes meanwhile share', async () => {
    const index = indexQuery();
    index.start();
    index.tracker.note({ spaces: [home] });
    index.tracker.note({ spaces: [work] });
    index.advance(GATHER_MS);
    expect(index.updates).toHaveLength(1);
    await index.updates[0]?.end();
    expect(index.taken()).toEqual(['all', [home, work]]);
    await index.updates[1]?.end();
    expect(index.updates).toHaveLength(2);
  });

  it('does nothing when what it gathered was taken meanwhile', async () => {
    const index = indexQuery();
    index.tracker.note({ spaces: [home] });
    index.start();
    await index.updates[0]?.end();
    index.advance(GATHER_MS);
    expect(index.taken()).toEqual([[home]]);
  });

  it('is only marked stale, at once, while nothing shows it, and lists the space of a save', () => {
    const index = indexQuery();
    index.hide();
    index.tracker.note({ saved: save('r1', 'own-1') });
    expect(index.stale()).toBe(true);
    expect(index.updates).toHaveLength(0);
    // No draft's text waits while nothing shows it.
    index.show();
    expect(index.taken()).toEqual([[home]]);
  });

  it('puts back what a failed update took, before what came since, with autosaves as one', async () => {
    const index = indexQuery();
    // An update fails, as the query's function does: what it took goes back.
    const fail = async (at: number) => {
      const failed = index.updates[at];
      index.tracker.putBack(failed?.changes ?? { spaces: [] });
      await failed?.end();
    };
    index.tracker.note({ saved: save('r1', 'own-1') });
    index.tracker.note({ spaces: [work] });
    index.advance(GATHER_MS);
    // Saved while that update runs, then it fails.
    index.tracker.note({ saved: save('own-1', 'own-2') });
    await fail(0);
    index.advance(GATHER_MS);
    // It fails again, then a save over one waiting stands in for it, over what that was saved over.
    await fail(1);
    index.tracker.note({ saved: save('own-2', 'own-3') });
    index.advance(GATHER_MS);
    expect(index.taken()).toEqual([
      [[work], ['own-1']],
      [[work], ['own-1', 'own-2']],
      [[work], ['own-1', 'own-3']],
    ]);
    expect(index.updates[2]?.changes.saved?.[1]?.basedOn).toBe('own-1');
  });

  it('keeps a save’s time when one into this device’s queue stands in for it', () => {
    const index = indexQuery();
    const at = '2026-11-13T09:30:00.000Z';
    index.tracker.note({ saved: { ...save('r1', 'own-1'), updated: at } });
    // The connection went: the next autosave is queued, on its base.
    index.tracker.note({ saved: save('own-1', 'own-1') });
    index.advance(GATHER_MS);
    expect(index.updates[0]?.changes.saved).toEqual([{ ...save('r1', 'own-1'), updated: at }]);
  });

  it('keeps no draft’s text from an update given up as nothing shows it', () => {
    const index = indexQuery();
    index.hide();
    index.tracker.putBack({ spaces: [], saved: [save('r1', 'own-1')] });
    index.tracker.dropSaves();
    index.show();
    index.tracker.note({ spaces: [work] });
    index.advance(GATHER_MS);
    expect(index.taken()).toEqual([[home, work]]);
  });

  it('forgets what it hadn’t taken, and stops waiting to keep it, when the vault locks', () => {
    const index = indexQuery();
    const write = vi.fn(async () => {});
    index.tracker.note({ saved: save('r1', 'own-1') });
    index.tracker.keep(false, write);
    index.tracker.forget();
    index.advance(KEEP_AT_MOST_MS);
    expect(index.updates).toHaveLength(0);
    expect(write).not.toHaveBeenCalled();
    // Only what changes from then on is followed.
    index.tracker.note({ spaces: [work] });
    index.advance(GATHER_MS);
    expect(index.taken()).toEqual([[work]]);
  });

  it('keeps the index once changes pause, at least once a minute, and at once when asked', () => {
    const index = indexQuery();
    const write = vi.fn(async () => {});
    // A burst of saves, a second apart: kept once, after they pause.
    for (let i = 0; i < 6; i++) {
      index.tracker.keep(false, write);
      index.advance(1_000);
    }
    expect(write).toHaveBeenCalledTimes(0);
    index.advance(KEEP_MS);
    expect(write).toHaveBeenCalledTimes(1);
    // Saves that never pause: once a minute.
    for (let i = 0; i < (KEEP_AT_MOST_MS * 2.5) / 1_000; i++) {
      index.tracker.keep(false, write);
      index.advance(1_000);
    }
    expect(write).toHaveBeenCalledTimes(3);
    // A version let go: at once, and a later change doesn't put that off.
    index.advance(KEEP_AT_MOST_MS);
    write.mockClear();
    index.tracker.keep(true, write);
    index.tracker.keep(false, write);
    index.advance(0);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

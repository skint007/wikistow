// Which of the browser's tabs runs search by meaning's queue (ADR 0016,
// step 4): one at a time, under a Web Lock.

const QUEUE_LOCK = 'wikistow-meaning-queue';

/** What runs while this tab holds the queue. */
export type Turn = { flush(): Promise<void>; stop(): void };

/** The browser's parts this needs, for tests to stand in for. */
export type Tabs = {
  locks: Pick<LockManager, 'request' | 'query'> | null;
  /** Whether this tab is in view, and a call each time that changes, until the returned function is called. */
  shown(): boolean;
  onShownChange(listener: () => void): () => void;
  /** A channel to the browser's other tabs of this app, or null. */
  channel(name: string): Pick<BroadcastChannel, 'postMessage' | 'close' | 'onmessage'> | null;
};

const browserTabs = (): Tabs => ({
  locks: typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null,
  shown: () => typeof document === 'undefined' || document.visibilityState === 'visible',
  onShownChange(listener) {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  channel: (name) => (typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name)),
});

/**
 * Run `start` while this tab holds the queue's Web Lock, which one tab of
 * the browser holds at a time, so one model and one queue run however many
 * tabs are open, and none writes the vectors over another's. A tab asks for
 * it while in view. One holding it that goes out of view keeps it, so
 * indexing goes on behind other windows, unless or until a tab in view
 * wants it: then it keeps what it made (`flush`) and lets go, since a tab
 * out of view doesn't follow what changes (`useTreeChanges`). It lets go
 * too as it closes or locks. One that let go takes it back, out of view
 * too, if the tab it let go for stopped asking first, so some tab runs it.
 * Returns how to stop. Without Web Locks, as on
 * a page not served over HTTPS, the tab runs it alone, as every tab then does.
 */
export function oneTabAtATime(start: () => Turn, tabs: Tabs = browserTabs()): () => void {
  const { locks } = tabs;
  if (!locks) {
    const turn = start();
    return () => turn.stop();
  }
  let left = false;
  let turn: Turn | null = null;
  /** The turn being handed over, still keeping what it made. */
  let giving: Turn | null = null;
  let release: (() => void) | null = null;
  /** The request whose turn this tab holds, settled once the lock is let go. */
  let holding: Promise<void> | null = null;
  let waiting: AbortController | null = null;
  const channel = tabs.channel(QUEUE_LOCK);
  const ask = () => {
    if (left || turn || waiting) return;
    // A tab holding it out of view lets go on hearing this.
    if (tabs.shown()) channel?.postMessage('shown');
    const asking = new AbortController();
    waiting = asking;
    let settle = () => {};
    const settled = new Promise<void>((resolve) => (settle = resolve));
    void locks
      .request(QUEUE_LOCK, { signal: asking.signal }, async () => {
        if (waiting === asking) waiting = null;
        // Granted as this tab left, or after it stopped asking.
        if (left || asking.signal.aborted) return;
        holding = settled;
        turn = start();
        await new Promise<void>((resolve) => (release = resolve));
      })
      .catch(() => {
        if (waiting === asking) waiting = null;
      })
      .finally(settle);
  };
  const letGo = async () => {
    const handing = turn;
    if (!handing) return;
    turn = null;
    giving = handing;
    await handing.flush();
    // Stopped meanwhile, as this tab left: stopped then already.
    if (giving !== handing) return;
    giving = null;
    handing.stop();
    release?.();
    release = null;
    // Let go once the lock is: it is then the next asker's, if any.
    await holding;
    holding = null;
  };
  /**
   * Once let go, ask again if nobody took it or waits for it, as when the
   * tab that asked went out of view first: the lock goes on release to one
   * that waits, so none holding it means none will.
   */
  const takeBackIfLeft = async () => {
    if (tabs.shown()) return ask();
    const { held = [], pending = [] } = await locks.query();
    const named = (lock: { name?: string }) => lock.name === QUEUE_LOCK;
    if (!held.some(named) && !pending.some(named)) ask();
  };
  /** Let go if a tab in view waits for the queue: tabs out of view don't ask. */
  const letGoIfWanted = async () => {
    const { pending = [] } = await locks.query();
    if (turn && !tabs.shown() && pending.some((lock) => lock.name === QUEUE_LOCK)) await letGo();
  };
  const unwatch = tabs.onShownChange(() => {
    if (tabs.shown()) ask();
    else {
      waiting?.abort();
      waiting = null;
      void letGoIfWanted();
    }
  });
  if (channel) {
    channel.onmessage = () => {
      // A tab came into view that wants the queue.
      if (turn && !tabs.shown()) void letGo().then(takeBackIfLeft);
    };
  }
  if (tabs.shown()) ask();
  return () => {
    left = true;
    unwatch();
    channel?.close();
    waiting?.abort();
    turn?.stop();
    giving?.stop();
    turn = null;
    giving = null;
    release?.();
  };
}

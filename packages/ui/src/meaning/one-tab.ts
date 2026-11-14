// Which of the browser's tabs runs search by meaning's queue (ADR 0016,
// step 4): one at a time, under a Web Lock.

const QUEUE_LOCK = 'wikistow-meaning-queue';

/** What runs while this tab holds the queue. */
export type Turn = { flush(): Promise<void>; stop(): void };

/** The browser's parts this needs, for tests to stand in for. */
export type Tabs = {
  locks: Pick<LockManager, 'request'> | null;
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
 * indexing goes on behind other windows, until a tab that wants it comes
 * into view: then it keeps what it made (`flush`) and lets go, since a tab
 * out of view doesn't follow what changes (`useTreeChanges`). It lets go
 * too as it closes or locks. Returns how to stop. Without Web Locks, as on
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
  let release: (() => void) | null = null;
  let waiting: AbortController | null = null;
  const channel = tabs.channel(QUEUE_LOCK);
  const ask = () => {
    if (left || turn || waiting) return;
    const asking = new AbortController();
    waiting = asking;
    void locks
      .request(QUEUE_LOCK, { signal: asking.signal }, async () => {
        if (waiting === asking) waiting = null;
        // Granted as this tab left, or after it stopped asking.
        if (left || asking.signal.aborted) return;
        turn = start();
        await new Promise<void>((resolve) => (release = resolve));
      })
      .catch(() => {
        if (waiting === asking) waiting = null;
      });
  };
  const letGo = async () => {
    const giving = turn;
    if (!giving) return;
    turn = null;
    await giving.flush();
    giving.stop();
    release?.();
    release = null;
  };
  const unwatch = tabs.onShownChange(() => {
    if (tabs.shown()) {
      channel?.postMessage('shown');
      ask();
    } else {
      waiting?.abort();
      waiting = null;
    }
  });
  if (channel) {
    channel.onmessage = () => {
      // A tab came into view that wants the queue.
      if (turn && !tabs.shown()) void letGo().then(() => (tabs.shown() ? ask() : undefined));
    };
  }
  if (tabs.shown()) ask();
  return () => {
    left = true;
    unwatch();
    channel?.close();
    waiting?.abort();
    turn?.stop();
    turn = null;
    release?.();
  };
}

import { describe, expect, it } from 'vite-plus/test';
import { oneTabAtATime, type Tabs, type Turn } from '../src/meaning/one-tab';

/** Web Locks as a browser grants them, in turn, and a channel between tabs. */
function browser() {
  type Request = { grant: () => Promise<void>; signal: AbortSignal; done: () => void };
  let holder: Request | null = null;
  const queue: Request[] = [];
  const next = () => {
    while (!holder && queue.length > 0) {
      const request = queue.shift()!;
      if (request.signal.aborted) continue;
      holder = request;
      void request.grant().finally(() => {
        holder = null;
        request.done();
        next();
      });
    }
  };
  const locks = {
    request: ((_name: string, options: LockOptions, grant: () => Promise<void>) =>
      new Promise<void>((resolve, reject) => {
        const signal = options.signal!;
        const request: Request = { grant, signal, done: resolve };
        signal.addEventListener('abort', () => {
          const at = queue.indexOf(request);
          if (at >= 0) {
            queue.splice(at, 1);
            reject(new DOMException('Aborted', 'AbortError'));
          }
        });
        queue.push(request);
        next();
      })) as LockManager['request'],
    query: async () => ({
      held: holder ? [{ name: 'wikistow-meaning-queue' }] : [],
      pending: queue
        .filter((r) => !r.signal.aborted)
        .map(() => ({ name: 'wikistow-meaning-queue' })),
    }),
  };
  const channels = new Set<{ onmessage: ((event: MessageEvent) => void) | null }>();
  const tab = (shownAtFirst: boolean) => {
    let shown = shownAtFirst;
    const listeners = new Set<() => void>();
    const tabs: Tabs = {
      locks,
      shown: () => shown,
      onShownChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      channel() {
        const end = {
          onmessage: null as ((event: MessageEvent) => void) | null,
          postMessage(message: unknown) {
            for (const other of channels) {
              if (other !== end) other.onmessage?.(new MessageEvent('message', { data: message }));
            }
          },
          close: () => channels.delete(end),
        };
        channels.add(end);
        return end as unknown as BroadcastChannel;
      },
    };
    const turns: string[] = [];
    /** Each flush waits for this, when set. */
    let flushing: Promise<void> | null = null;
    const turn = (): Turn => {
      turns.push('start');
      return {
        flush: async () => {
          turns.push('flush');
          await flushing;
        },
        stop: () => void turns.push('stop'),
      };
    };
    const slowFlush = (until: Promise<void>) => {
      flushing = until;
    };
    const show = (now: boolean) => {
      shown = now;
      for (const listener of listeners) listener();
    };
    return { tabs, turns, turn, show, slowFlush };
  };
  return { tab };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('one tab at a time', () => {
  it('runs in one tab of several, the one that asked first', async () => {
    const { tab } = browser();
    const a = tab(true);
    const b = tab(true);
    oneTabAtATime(a.turn, a.tabs);
    oneTabAtATime(b.turn, b.tabs);
    await settled();
    expect(a.turns).toEqual(['start']);
    expect(b.turns).toEqual([]);
  });

  it('keeps running out of view, until a tab that wants it comes into view', async () => {
    const { tab } = browser();
    const a = tab(true);
    const b = tab(false);
    oneTabAtATime(a.turn, a.tabs);
    oneTabAtATime(b.turn, b.tabs);
    await settled();
    a.show(false);
    await settled();
    expect(a.turns).toEqual(['start']);
    // B comes into view: A keeps what it made, lets go, and B runs it.
    b.show(true);
    await settled();
    expect(a.turns).toEqual(['start', 'flush', 'stop']);
    expect(b.turns).toEqual(['start']);
    // A in view again doesn't take it from B, also in view.
    a.show(true);
    await settled();
    expect(b.turns).toEqual(['start']);
  });

  it('hands it over on going out of view, when a tab in view waits for it', async () => {
    const { tab } = browser();
    const a = tab(true);
    const b = tab(true);
    oneTabAtATime(a.turn, a.tabs);
    oneTabAtATime(b.turn, b.tabs);
    await settled();
    expect(b.turns).toEqual([]);
    a.show(false);
    await settled();
    await settled();
    expect(a.turns).toEqual(['start', 'flush', 'stop']);
    expect(b.turns).toEqual(['start']);
  });

  it('stopped while handing it over, the turn handed stops at once', async () => {
    const { tab } = browser();
    const a = tab(true);
    const b = tab(false);
    let flushed = () => {};
    a.slowFlush(new Promise<void>((resolve) => (flushed = resolve)));
    const stopA = oneTabAtATime(a.turn, a.tabs);
    oneTabAtATime(b.turn, b.tabs);
    await settled();
    a.show(false);
    b.show(true);
    await settled();
    expect(a.turns).toEqual(['start', 'flush']);
    // Turned off meanwhile: stopped now, not once its flush ends.
    stopA();
    expect(a.turns).toEqual(['start', 'flush', 'stop']);
    flushed();
    await settled();
    expect(a.turns).toEqual(['start', 'flush', 'stop']);
    expect(b.turns).toEqual(['start']);
  });

  it('passes it on when the tab holding it stops, and never starts once stopped', async () => {
    const { tab } = browser();
    const a = tab(true);
    const b = tab(true);
    const stopA = oneTabAtATime(a.turn, a.tabs);
    const stopB = oneTabAtATime(b.turn, b.tabs);
    await settled();
    // B stops before its turn comes: A's ending gives it nothing.
    stopB();
    stopA();
    await settled();
    expect(a.turns).toEqual(['start', 'stop']);
    expect(b.turns).toEqual([]);
  });

  it('a tab that starts in view takes it from one out of view', async () => {
    const { tab } = browser();
    const a = tab(true);
    oneTabAtATime(a.turn, a.tabs);
    await settled();
    a.show(false);
    await settled();
    // Opened, or unlocked, in view: it says so as it asks.
    const b = tab(true);
    oneTabAtATime(b.turn, b.tabs);
    await settled();
    await settled();
    expect(a.turns).toEqual(['start', 'flush', 'stop']);
    expect(b.turns).toEqual(['start']);
  });

  it('a tab out of view from the start waits to be shown', async () => {
    const { tab } = browser();
    const a = tab(false);
    oneTabAtATime(a.turn, a.tabs);
    await settled();
    expect(a.turns).toEqual([]);
    a.show(true);
    await settled();
    expect(a.turns).toEqual(['start']);
  });

  it('runs at once without Web Locks', () => {
    const turns: string[] = [];
    const stop = oneTabAtATime(
      () => {
        turns.push('start');
        return { flush: async () => {}, stop: () => void turns.push('stop') };
      },
      { locks: null, shown: () => true, onShownChange: () => () => {}, channel: () => null },
    );
    stop();
    expect(turns).toEqual(['start', 'stop']);
  });
});

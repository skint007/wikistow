import type { PageId } from '@wikistow/client';

// Each tab or window in a page's live session holds this Web Lock, shared,
// released when it leaves or the tab dies (ADR 0015 decision 1): while
// anyone holds it, this app's queue holds the page's draft entry back.
const lockName = (pageId: PageId) => `wikistow live ${pageId}`;

const locks = (): LockManager | null =>
  typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;

const released = new Set<() => void>();

/** Hear when this tab lets a page's live lock go, so its queue can send what it held back. */
export function onLivePageReleased(listener: () => void): () => void {
  released.add(listener);
  return () => void released.delete(listener);
}

/** Hold the page's live lock until the returned function is called. */
export function holdLivePage(pageId: PageId): () => void {
  const manager = locks();
  if (!manager) return () => {};
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const request = manager.request(lockName(pageId), { mode: 'shared' }, () => held);
  void request.catch(() => {});
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
    // Once let go, the queue may send the page's change it held back.
    void request.finally(() => {
      for (const listener of released) listener();
    });
  };
}

/** Whether a tab or window of this app is in the page's live session now. */
export async function livePageHeld(pageId: PageId): Promise<boolean> {
  const manager = locks();
  if (!manager) return false;
  const { held = [], pending = [] } = await manager.query();
  const name = lockName(pageId);
  // One asked for and not yet given counts: it is on its way into the session.
  return [...held, ...pending].some((lock) => lock.name === name);
}

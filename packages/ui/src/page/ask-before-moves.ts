import { useSyncExternalStore } from 'react';

const KEY = 'wikistow.askBeforeMoves';

// Kept only while off: `false`. Anything else reads as on, the default.
function stored(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'false';
  } catch {
    return true;
  }
}

/**
 * Whether a move stops on its confirmation step, where the person sees who
 * gains and loses access, before it goes ahead. **Don't ask again** there
 * turns it off, and Settings turns it back on. Kept on the device, in
 * `localStorage`, like the idle lock.
 */
function createAskBeforeMoves() {
  let asking = stored();
  const listeners = new Set<() => void>();
  const update = (next: boolean) => {
    asking = next;
    for (const listener of listeners) listener();
  };
  // A choice made in another tab applies here too.
  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) update(stored());
  });
  return {
    set(next: boolean) {
      try {
        if (next) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, 'false');
      } catch {
        // Not kept past this run; it still applies now.
      }
      update(next);
    },
    get: () => asking,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const askBeforeMoves = createAskBeforeMoves();

export function useAskBeforeMoves(): boolean {
  return useSyncExternalStore(askBeforeMoves.subscribe, askBeforeMoves.get);
}

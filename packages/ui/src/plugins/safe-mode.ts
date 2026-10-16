import { desktop } from '../desktop';

const KEY = 'wikistow.safeMode';

/**
 * Safe mode in a browser tab (ADR 0002): kept in the tab's session storage,
 * so it lasts through reloads in that tab until it is turned off, and other
 * tabs keep their plugins. The desktop app keeps its own, in main.
 */
export const tabSafeMode = {
  on(): boolean {
    try {
      return sessionStorage.getItem(KEY) !== null;
    } catch {
      return false;
    }
  },
  set(on: boolean) {
    try {
      if (on) sessionStorage.setItem(KEY, '1');
      else sessionStorage.removeItem(KEY);
    } catch {
      // Storage refused (some private windows): this tab keeps its plugins.
    }
  },
};

// `?safe-mode` in the address turns it on for this tab. It runs as this
// module loads, before the router reads the address, so the parameter is
// gone from it and turning plugins back on stays on.
if (!desktop && typeof location !== 'undefined') {
  const url = new URL(location.href);
  if (url.searchParams.has('safe-mode')) {
    tabSafeMode.set(true);
    url.searchParams.delete('safe-mode');
    history.replaceState(history.state, '', url);
  }
}

/** Ctrl+Shift+Alt+P, the desktop's safe mode keys; the code, so Alt's character on a Mac doesn't matter. */
export const isSafeModeKey = (event: KeyboardEvent) =>
  event.ctrlKey && event.shiftKey && event.altKey && event.code === 'KeyP';

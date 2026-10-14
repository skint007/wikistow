import { useEffect, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { useVault, vaultStore } from './store';

const DELAY_KEY = 'wikistow.idleLock';
const ACTIVE_KEY = 'wikistow.lastActive';

/** The delays Settings offers, in minutes. */
export const IDLE_DELAYS = [5, 15, 30, 60] as const;

// Minutes, absent for Off. Any positive number reads back, not only the
// offered ones, so a check can set a few seconds by hand.
const Delay = z.number().positive();

function stored(): number | null {
  try {
    const parsed = Delay.safeParse(JSON.parse(localStorage.getItem(DELAY_KEY) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * How long this device waits with no activity before it locks the vault, in
 * minutes, or null for never (the default). Kept on the device, in
 * `localStorage`, like the plugin theme: it's about the device, not the account.
 */
function createIdleLockDelay() {
  let minutes = stored();
  const listeners = new Set<() => void>();
  const update = (next: number | null) => {
    minutes = next;
    for (const listener of listeners) listener();
  };
  // A choice made in another tab applies here too.
  window.addEventListener('storage', (event) => {
    if (event.key === DELAY_KEY || event.key === null) update(stored());
  });
  return {
    set(next: number | null) {
      try {
        if (next === null) localStorage.removeItem(DELAY_KEY);
        else localStorage.setItem(DELAY_KEY, JSON.stringify(next));
      } catch {
        // Not kept past this run; it still applies now.
      }
      update(next);
    },
    get: () => minutes,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const idleLockDelay = createIdleLockDelay();

export function useIdleLockDelay(): number | null {
  return useSyncExternalStore(idleLockDelay.subscribe, idleLockDelay.get);
}

/**
 * Whether this device has gone the chosen delay with nobody using it in any
 * tab, by the activity they last shared: a tab restored or reloaded after
 * that long shouldn't reopen the vault it kept.
 */
export function idleTooLong(): boolean {
  const minutes = idleLockDelay.get();
  if (minutes === null) return false;
  try {
    const last = Number(localStorage.getItem(ACTIVE_KEY));
    return last > 0 && Date.now() - last >= minutes * 60_000;
  } catch {
    return false;
  }
}

// Someone using the app: a hidden tab or minimized window gets none of these,
// so it counts as idle.
const ACTIVITY = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart', 'scroll'];

/**
 * Lock the vault once the chosen delay has passed with no activity in any of
 * this device's tabs or windows (they share `localStorage`). Timers in a
 * hidden tab are slowed or paused, so it measures wall time: it looks when a
 * timer fires, when the page shows again, and at the first activity after.
 * The lock is a requested one, with nobody there to answer: drafts save
 * first, and one that can't keeps the vault open until the delay has passed
 * again.
 */
export function useIdleLock() {
  const unlocked = useVault().status === 'unlocked';
  const minutes = useIdleLockDelay();

  useEffect(() => {
    if (!unlocked || minutes === null) return;
    const delay = minutes * 60_000;
    let lastActive = Date.now();
    let shared = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let locking = false;
    let stopped = false;

    // Other tabs see activity here, written at most every few seconds.
    const active = () => {
      // The delay passed unnoticed (a timer that ran late after the computer
      // slept, say): the first activity back locks rather than starting over.
      if (Date.now() - latest() >= delay) return void check();
      lastActive = Date.now();
      if (lastActive - shared < 5_000) return;
      shared = lastActive;
      try {
        localStorage.setItem(ACTIVE_KEY, String(lastActive));
      } catch {
        // Other tabs just don't see it.
      }
    };
    const latest = () => {
      try {
        return Math.max(lastActive, Number(localStorage.getItem(ACTIVE_KEY)) || 0);
      } catch {
        return lastActive;
      }
    };
    const check = async () => {
      clearTimeout(timer);
      if (locking) return;
      const left = latest() + delay - Date.now();
      if (left > 0) {
        timer = setTimeout(() => void check(), left);
        return;
      }
      locking = true;
      const locked = await vaultStore.requestLock(() => false).catch(() => false);
      locking = false;
      if (locked || stopped) return;
      lastActive = Date.now();
      timer = setTimeout(() => void check(), delay);
    };
    const shown = () => {
      if (document.visibilityState === 'visible') void check();
    };

    active();
    timer = setTimeout(() => void check(), delay);
    for (const type of ACTIVITY)
      window.addEventListener(type, active, { capture: true, passive: true });
    document.addEventListener('visibilitychange', shown);
    return () => {
      stopped = true;
      clearTimeout(timer);
      for (const type of ACTIVITY) window.removeEventListener(type, active, { capture: true });
      document.removeEventListener('visibilitychange', shown);
    };
  }, [unlocked, minutes]);
}

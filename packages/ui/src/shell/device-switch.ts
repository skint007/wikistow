import { useSyncExternalStore } from 'react';

/**
 * An on/off setting kept on the device in `localStorage` under `key`, like
 * the idle lock: stored only while it isn't `fallback`, so a device that
 * never changed it keeps nothing. A change made in another tab applies here
 * too. Read it in a component with `useDeviceSwitch`.
 */
export function deviceSwitch(key: string, fallback: boolean) {
  const changed = String(!fallback);
  const stored = (): boolean => {
    try {
      return localStorage.getItem(key) === changed ? !fallback : fallback;
    } catch {
      return fallback;
    }
  };
  let on = stored();
  const listeners = new Set<() => void>();
  const update = (next: boolean) => {
    on = next;
    for (const listener of listeners) listener();
  };
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) update(stored());
  });
  return {
    set(next: boolean) {
      try {
        if (next === fallback) localStorage.removeItem(key);
        else localStorage.setItem(key, changed);
      } catch {
        // Not kept past this run; it still applies now.
      }
      update(next);
    },
    get: () => on,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type DeviceSwitch = ReturnType<typeof deviceSwitch>;

/** The switch's value now, drawn again as it changes. */
export const useDeviceSwitch = (setting: DeviceSwitch): boolean =>
  useSyncExternalStore(setting.subscribe, setting.get);

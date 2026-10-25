import type { SpaceId } from '@wikistow/client';
import { useCallback, useSyncExternalStore } from 'react';
import type { z } from 'zod';
import { useVault } from '../vault/store';

/**
 * A choice kept on the device in `localStorage`, like the theme, per server
 * (its installation, as for the restore notice), account and space, and
 * whatever `parts` name after that, under `prefix`. What doesn't read as
 * `schema` (unset, or from an older app) is `fallback`. Each value read or
 * written in this tab is shared by everything showing it, as the wide
 * layout's sidebar and the phone drawer's are, and one changed in another
 * tab shows here too. It is stored as `encode` gives it, which `schema` reads back.
 */
export function deviceStore<T>(
  prefix: string,
  schema: z.ZodType<T, unknown>,
  fallback: T,
  encode: (value: T) => unknown = (value) => value,
) {
  const values = new Map<string, T>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  // This tab's next save keeps what another tab changed.
  window.addEventListener('storage', (event) => {
    if (event.key === null) values.clear();
    else if (event.key.startsWith(prefix)) values.delete(event.key);
    else return;
    emit();
  });

  function load(key: string): T {
    if (values.has(key)) return values.get(key) as T;
    let value = fallback;
    try {
      const parsed = schema.safeParse(JSON.parse(localStorage.getItem(key) ?? 'null'));
      if (parsed.success) value = parsed.data;
    } catch {
      // Unreadable: the fallback.
    }
    values.set(key, value);
    return value;
  }

  function save(key: string, value: T) {
    values.set(key, value);
    try {
      localStorage.setItem(key, JSON.stringify(encode(value)));
    } catch {
      // Not kept past this run; it still applies now.
    }
    emit();
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  /** The value kept for `spaceId` and `parts`, and a setter taking the current one. */
  return function useDeviceValue(spaceId: SpaceId, ...parts: string[]) {
    const current = useVault();
    if (current.status !== 'unlocked') throw new Error('The vault is locked');
    const key = [
      `${prefix}${current.ctx.installationId}`,
      current.vault.accountId,
      spaceId,
      ...parts,
    ].join('.');
    const value = useSyncExternalStore(subscribe, () => load(key));
    const update = useCallback((change: (current: T) => T) => save(key, change(load(key))), [key]);
    return [value, update] as const;
  };
}

import type { SpaceId } from '@wikistow/client';
import { useCallback, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { useVault } from '../vault/store';

const PREFIX = 'wikistow.expanded.';
const Kept = z.array(z.string());
const NONE: ReadonlySet<string> = new Set();

// The sets read or written in this tab, by storage key, so every sidebar
// showing a space (the wide layout's and the phone drawer's) shares one.
const sets = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

// Folders opened or closed in another tab show here too, and this tab's
// next save keeps them.
window.addEventListener('storage', (event) => {
  if (event.key === null) sets.clear();
  else if (event.key.startsWith(PREFIX)) sets.delete(event.key);
  else return;
  emit();
});

function load(key: string): ReadonlySet<string> {
  let set = sets.get(key);
  if (set) return set;
  try {
    const parsed = Kept.safeParse(JSON.parse(localStorage.getItem(key) ?? 'null'));
    set = parsed.success ? new Set(parsed.data) : NONE;
  } catch {
    set = NONE;
  }
  sets.set(key, set);
  return set;
}

function save(key: string, set: ReadonlySet<string>) {
  sets.set(key, set);
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
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

/**
 * The folders open in a space's tree, by ID, so a rename or move keeps them,
 * and a setter taking the current set. Kept on the device in `localStorage`,
 * like the theme, per server (its installation, as for the restore notice),
 * account and space. The tree skips IDs it no longer has.
 */
export function useExpandedFolders(spaceId: SpaceId) {
  const current = useVault();
  if (current.status !== 'unlocked') throw new Error('The vault is locked');
  const key = `${PREFIX}${current.ctx.installationId}.${current.vault.accountId}.${spaceId}`;
  const expanded = useSyncExternalStore(subscribe, () => load(key));
  const update = useCallback(
    (change: (current: ReadonlySet<string>) => ReadonlySet<string>) => save(key, change(load(key))),
    [key],
  );
  return [expanded, update] as const;
}

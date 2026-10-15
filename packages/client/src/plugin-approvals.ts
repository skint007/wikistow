import { FolderId, SpaceId } from '@wikistow/contracts';
import { PluginId } from '@wikistow/plugin-sdk/manifest';
import { z } from 'zod';
import type { PrivateContacts } from './contacts.ts';

/**
 * Where a person's contacts record keeps the library plugins they approved
 * (ADR 0002), in the private payload, which only the person can open: per
 * plugin, the hash approved, whether it is on, and its plugin access. They
 * follow the person to every device. The desktop's folder and development
 * installs keep theirs in its `plugins.json` instead.
 */
export const PLUGINS_NAMESPACE = 'wikistow.plugins';

/**
 * A space (`folderId` null), or a folder and what is under it, that a
 * plugin may read or write: the desktop's `PluginScope`, which the runtime
 * enforces (`packages/ui/src/plugins/pages.ts`).
 */
export const PluginScope = z.object({
  spaceId: SpaceId,
  folderId: FolderId.nullable(),
  access: z.enum(['read', 'write']),
});
export type PluginScope = z.infer<typeof PluginScope>;

/** One approved library plugin. */
export const PluginApproval = z.object({
  id: PluginId,
  /** The approved version's hash in the library: hex SHA-256 over its files. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  enabled: z.boolean(),
  access: z.array(PluginScope).max(100),
});
export type PluginApproval = z.infer<typeof PluginApproval>;

type Json = PrivateContacts['extensions'][string];
type JsonObject = { [key: string]: Json };

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The stored entries as written, fields this app doesn't know included.
const storedEntries = (own: PrivateContacts): Json[] => {
  const stored = own.extensions[PLUGINS_NAMESPACE];
  const plugins = isObject(stored) ? stored['plugins'] : undefined;
  return Array.isArray(plugins) ? plugins : [];
};

const entryId = (entry: Json) => (isObject(entry) ? entry['id'] : undefined);

/**
 * Every readable approval in the private payload, one per plugin, in the
 * record's order. One that doesn't parse is left out, not fatal.
 */
export function pluginApprovals(own: PrivateContacts): PluginApproval[] {
  const seen = new Set<string>();
  return storedEntries(own).flatMap((entry) => {
    const approval = PluginApproval.safeParse(entry);
    if (!approval.success || seen.has(approval.data.id)) return [];
    seen.add(approval.data.id);
    return [approval.data];
  });
}

/** A change to one library plugin's approval, as `ContactsChange` merges it (section 8.6). */
export type PluginChange =
  /** Install, or approve again: the whole entry, turned on. */
  | { kind: 'plugin-approve'; approval: PluginApproval }
  /** Update (a new `hash`), change access, or turn on or off, if the entry is still there. */
  | { kind: 'plugin-change'; pluginId: string; set: Partial<Omit<PluginApproval, 'id'>> }
  | { kind: 'plugin-remove'; pluginId: string };

/**
 * The private payload with `change` applied, the same object when it
 * changes nothing. It works on the entries as stored, so fields a newer
 * app wrote, in an entry, its scopes or beside `plugins`, survive, and so
 * do entries this app can't read.
 */
export function withPluginChange(own: PrivateContacts, change: PluginChange): PrivateContacts {
  const entries = storedEntries(own);
  const pluginId = change.kind === 'plugin-approve' ? change.approval.id : change.pluginId;
  const others = entries.filter((entry) => entryId(entry) !== pluginId);
  let plugins: Json[];
  switch (change.kind) {
    case 'plugin-approve':
      plugins = [...others, change.approval];
      break;
    case 'plugin-remove':
      if (others.length === entries.length) return own;
      plugins = others;
      break;
    case 'plugin-change': {
      // The entry `pluginApprovals` reads; none means it was removed, which stands.
      const index = entries.findIndex(
        (entry) => entryId(entry) === pluginId && PluginApproval.safeParse(entry).success,
      );
      const current = entries[index];
      if (!isObject(current)) return own;
      plugins = entries.with(index, { ...current, ...change.set });
      break;
    }
  }
  const stored = own.extensions[PLUGINS_NAMESPACE];
  return {
    ...own,
    extensions: {
      ...own.extensions,
      [PLUGINS_NAMESPACE]: { ...(isObject(stored) ? stored : {}), plugins },
    },
  };
}

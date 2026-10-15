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

const Plugins = z.looseObject({ plugins: z.array(z.json()) });
// Just enough of an entry to know its plugin, for entries this version can't read.
const Keyed = z.looseObject({ id: z.string() });

/**
 * Every readable approval in the private payload, one per plugin, in the
 * record's order. One that doesn't parse is left out, not fatal.
 */
export function pluginApprovals(own: PrivateContacts): PluginApproval[] {
  const stored = Plugins.safeParse(own.extensions[PLUGINS_NAMESPACE]);
  if (!stored.success) return [];
  const seen = new Set<string>();
  return stored.data.plugins.flatMap((entry) => {
    const approval = PluginApproval.safeParse(entry);
    if (!approval.success || seen.has(approval.data.id)) return [];
    seen.add(approval.data.id);
    return [approval.data];
  });
}

/**
 * The private payload with `pluginId`'s approval replaced by what `update`
 * makes of it (null when there is none), or dropped when that is null.
 * Other plugins' entries stay as they are, unreadable ones included.
 */
export function withPluginApproval(
  own: PrivateContacts,
  pluginId: string,
  update: (current: PluginApproval | null) => PluginApproval | null,
): PrivateContacts {
  const current = pluginApprovals(own).find((approval) => approval.id === pluginId) ?? null;
  const next = update(current);
  if (next === current) return own;
  const stored = Plugins.safeParse(own.extensions[PLUGINS_NAMESPACE]);
  const others = (stored.success ? stored.data.plugins : []).filter(
    (entry) => Keyed.safeParse(entry).data?.id !== pluginId,
  );
  return {
    ...own,
    extensions: {
      ...own.extensions,
      [PLUGINS_NAMESPACE]: { plugins: next ? [...others, next] : others },
    },
  };
}

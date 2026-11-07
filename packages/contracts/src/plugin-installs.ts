import { trustLevel, type Manifest } from '@wikistow/plugin-sdk/manifest';
import { z } from 'zod';
import type { InstalledPlugin } from './desktop-bridge.ts';
import { FolderId, SpaceId } from './records/ids.ts';

/**
 * A space (`folderId` null), or a folder and what is under it, that a
 * plugin may read or write for one account: the one page access scope,
 * kept in the desktop's `plugins.json` for folder installs and in the
 * account's contacts record for library plugins, and enforced by the
 * runtime (`packages/ui/src/plugins/pages.ts`).
 */
export const PluginScope = z.object({
  spaceId: SpaceId,
  folderId: FolderId.nullable(),
  access: z.enum(['read', 'write']),
});
/** As callers hold it, IDs as plain strings; the stores parse it. */
export type PluginScope = z.input<typeof PluginScope>;

/** A plugin as the runtime runs it. Its trust level always follows from its manifest. */
export const installedPlugin = ({
  manifest,
  ...rest
}: Omit<InstalledPlugin, 'level'>): InstalledPlugin => ({
  manifest,
  level: trustLevel(manifest),
  ...rest,
});

/** A library version as the runtime runs it: its files are served under its hash. */
export const libraryInstall = (manifest: Manifest, hash: string, enabled: boolean) =>
  installedPlugin({ manifest, key: hash, development: null, library: true, enabled });

import {
  installedPlugin,
  PluginScope,
  type InstalledPlugin,
  type PluginCandidate,
  type PluginsState,
} from '@wikistow/contracts';
import { fileType } from '@wikistow/plugin-sdk/files';
import {
  asksMore,
  Manifest,
  PageAccess,
  PluginId,
  settingsFit,
  SettingsValue,
  trustLevel,
} from '@wikistow/plugin-sdk/manifest';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  copyPluginFiles,
  PluginFolderError,
  readPluginFolder,
  uploadFiles,
  type PluginFolder,
} from './folder.ts';

const Level = z.enum(['theme', 'script', 'app']);

const Stored = z.strictObject({
  manifest: Manifest,
  /** An installed plugin's hash, which names its folder; null for a development one. */
  hash: z.string().nullable(),
  development: z.string().nullable(),
  enabled: z.boolean(),
  /**
   * The regions where the app's own part shows in place of its own (ADR
   * 0011), kept through updates. Left out while there are none: an app
   * older than it refuses the file while any are set, as it refuses a
   * manifest with keys it doesn't know.
   */
  ownParts: z.array(z.string().max(40)).max(20).optional(),
  /** What the person approved: more of either asks again. */
  approved: z.strictObject({ access: PageAccess, level: Level }),
});
type Stored = z.infer<typeof Stored>;

/** `plugins.json`: IDs and choices only, never content. */
const State = z.strictObject({
  plugins: z.array(Stored),
  /** Page access, by account and then plugin. */
  access: z.record(z.string(), z.record(z.string(), z.array(PluginScope))),
  /**
   * Settings (`host.settings`, #310), by account and then plugin. Left out
   * while there are none, as `ownParts` is: an app older than it refuses
   * the file while any are kept.
   */
  settings: z.record(z.string(), z.record(z.string(), SettingsValue)).optional(),
  /**
   * The library plugins turned off on this computer only (#312), by
   * account. Left out while there are none, as `settings` is.
   */
  offHere: z.record(z.string(), z.array(PluginId).max(500)).optional(),
});
type State = z.infer<typeof State>;
type Settings = z.infer<typeof SettingsValue>;

/** A file served under `/plugins/`, with what it is served as. */
export type PluginFile = { path: string; type: string };

/** `/plugins/<id>/<key>/<path>`, split, its path decoded. */
export type PluginAddress = { id: string; key: string; path: string };

export function pluginAddress(pathname: string): PluginAddress | null {
  const match = /^\/plugins\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname);
  if (!match) return null;
  const [, id = '', key = '', path = ''] = match;
  try {
    return { id, key, path: decodeURIComponent(path) };
  } catch {
    return null;
  }
}

/**
 * The plugins on this computer: installed copies under `<data>/plugins`,
 * development folders read where they are, the person's approvals and
 * page access in `<data>/plugins.json`. Only the app's main process uses it.
 */
export function desktopPlugins(data: string) {
  const root = join(data, 'plugins');
  const stateFile = join(data, 'plugins.json');
  let state: State = { plugins: [], access: {} };
  /** The folder read for the person to approve, already copied for an install. */
  let pending: { token: string; read: PluginFolder; development: string | null } | null = null;
  /** Each development plugin's reload count, which names its files' URL. */
  const reloads = new Map<string, number>();
  let writing: Promise<void> = Promise.resolve();

  const save = () => {
    const next = `${stateFile}.next`;
    // One write at a time, whole, then moved into place.
    writing = writing
      .then(async () => {
        await writeFile(next, JSON.stringify(state), { mode: 0o600 });
        await rename(next, stateFile);
      })
      .catch(() => {});
    return writing;
  };

  const find = (id: string) => state.plugins.find((plugin) => plugin.manifest.id === id);

  /** Keep `settings` as an account's for a plugin, leaving out what is empty. */
  const keepSettings = (account: string, pluginId: string, settings: Settings) => {
    const all = { ...state.settings };
    const mine = { ...all[account] };
    if (Object.keys(settings).length > 0) mine[pluginId] = settings;
    else delete mine[pluginId];
    if (Object.keys(mine).length > 0) all[account] = mine;
    else delete all[account];
    if (Object.keys(all).length > 0) state.settings = all;
    else delete state.settings;
  };
  const installed = (plugin: Stored) => join(root, plugin.manifest.id, plugin.hash ?? '');
  const keyOf = (plugin: Stored) => plugin.hash ?? `dev-${reloads.get(plugin.manifest.id) ?? 0}`;

  const view = (plugin: Stored): InstalledPlugin =>
    installedPlugin({
      manifest: plugin.manifest,
      key: keyOf(plugin),
      development: plugin.development,
      library: false,
      enabled: plugin.enabled,
      ownParts: plugin.ownParts,
    });

  const candidate = (read: PluginFolder, development: string | null): PluginCandidate => {
    const before = find(read.manifest.id);
    const token = randomUUID();
    pending = { token, read, development };
    return {
      token,
      manifest: read.manifest,
      level: trustLevel(read.manifest),
      development,
      hash: development ? null : read.hash,
      replaces: before
        ? {
            version: before.manifest.version,
            level: before.approved.level,
            access: before.approved.access,
          }
        : null,
    };
  };

  const dropStaging = () => rm(join(root, '.staging'), { recursive: true, force: true });

  return {
    async load() {
      try {
        state = State.parse(JSON.parse(await readFile(stateFile, 'utf8')));
      } catch {
        // None yet, or damaged: no plugins, never a dead app.
        state = { plugins: [], access: {} };
      }
      await dropStaging();
    },

    list: (safeMode: boolean): PluginsState => ({ safeMode, plugins: state.plugins.map(view) }),

    anyEnabled: () => state.plugins.some((plugin) => plugin.enabled),

    /** Read `folder` for approval. An install is copied first, and what is approved is that copy. */
    async pick(folder: string, development: boolean): Promise<PluginCandidate> {
      const read = await readPluginFolder(folder);
      if (development) return candidate(read, folder);
      await dropStaging();
      const staged = join(root, '.staging', read.hash);
      await copyPluginFiles(read, staged);
      return candidate(await readPluginFolder(staged), null);
    },

    async approve(token: unknown) {
      if (!pending || token !== pending.token) {
        throw new PluginFolderError('That plugin is no longer waiting to be approved.');
      }
      const { read, development } = pending;
      pending = null;
      const { manifest, hash } = read;
      const before = find(manifest.id);
      if (!development) {
        const target = join(root, manifest.id, hash);
        await rm(target, { recursive: true, force: true });
        await mkdir(join(root, manifest.id), { recursive: true });
        await rename(read.folder, target);
      }
      const next: Stored = {
        manifest,
        hash: development ? null : hash,
        development,
        enabled: true,
        ...(before?.ownParts && { ownParts: before.ownParts }),
        approved: { access: manifest.access, level: trustLevel(manifest) },
      };
      state.plugins = [...state.plugins.filter((plugin) => plugin !== before), next];
      if (development) reloads.set(manifest.id, (reloads.get(manifest.id) ?? 0) + 1);
      await save();
      // The version it replaces, once nothing points at it.
      if (before?.hash && before.hash !== next.hash)
        await rm(installed(before), { recursive: true, force: true });
    },

    async setEnabled(id: unknown, enabled: unknown) {
      const plugin = find(z.string().parse(id));
      if (!plugin) return;
      plugin.enabled = z.boolean().parse(enabled);
      await save();
    },

    async setOwnParts(id: unknown, regions: unknown) {
      const plugin = find(z.string().parse(id));
      if (!plugin) return;
      const parts = Stored.shape.ownParts.unwrap().parse(regions);
      if (parts.length > 0) plugin.ownParts = parts;
      else delete plugin.ownParts;
      await save();
    },

    /** Read a development folder again; a candidate if it now asks for more. */
    async reload(id: unknown): Promise<PluginCandidate | null> {
      const plugin = find(z.string().parse(id));
      if (!plugin?.development) throw new PluginFolderError('Only a development plugin reloads.');
      const read = await readPluginFolder(plugin.development);
      if (read.manifest.id !== plugin.manifest.id) {
        throw new PluginFolderError(
          `That folder now holds ${read.manifest.id}, not ${plugin.manifest.id}.`,
        );
      }
      const next = { access: read.manifest.access, level: trustLevel(read.manifest) };
      if (asksMore(plugin.approved, next)) return candidate(read, plugin.development);
      plugin.manifest = read.manifest;
      reloads.set(plugin.manifest.id, (reloads.get(plugin.manifest.id) ?? 0) + 1);
      await save();
      return null;
    },

    async remove(id: unknown) {
      const plugin = find(z.string().parse(id));
      if (!plugin) return;
      state.plugins = state.plugins.filter((other) => other !== plugin);
      for (const access of Object.values(state.access)) delete access[plugin.manifest.id];
      for (const account of Object.keys(state.settings ?? {}))
        keepSettings(account, plugin.manifest.id, {});
      await save();
      if (!plugin.development)
        await rm(join(root, plugin.manifest.id), { recursive: true, force: true });
    },

    /** An installed plugin's files, read from its copy, to share to the library. */
    async uploadFiles(id: unknown) {
      const plugin = find(z.string().parse(id));
      if (!plugin || plugin.development) {
        throw new PluginFolderError('Only a plugin installed on this computer can be shared.');
      }
      return uploadFiles(await readPluginFolder(installed(plugin)));
    },

    access: (accountId: unknown): Record<string, PluginScope[]> =>
      state.access[z.string().parse(accountId)] ?? {},

    async setAccess(accountId: unknown, pluginId: unknown, scopes: unknown) {
      const account = z.string().min(1).parse(accountId);
      const plugin = find(z.string().parse(pluginId));
      if (!plugin) throw new PluginFolderError('That plugin isn’t installed.');
      const mine = (state.access[account] ??= {});
      mine[plugin.manifest.id] = z.array(PluginScope).max(100).parse(scopes);
      await save();
    },

    settings: (accountId: unknown): Record<string, Settings> =>
      state.settings?.[z.string().parse(accountId)] ?? {},

    async setSettings(accountId: unknown, pluginId: unknown, settings: unknown) {
      const account = z.string().min(1).parse(accountId);
      const plugin = find(z.string().parse(pluginId));
      if (!plugin) throw new PluginFolderError('That plugin isn’t installed.');
      const value = SettingsValue.parse(settings);
      if (!settingsFit(value)) throw new PluginFolderError('Those settings are too large.');
      keepSettings(account, plugin.manifest.id, value);
      await save();
    },

    offHere: (accountId: unknown): string[] => state.offHere?.[z.string().parse(accountId)] ?? [],

    /** Keep `pluginIds` as the account's library plugins off on this computer. */
    async setOffHere(accountId: unknown, pluginIds: unknown) {
      const account = z.string().min(1).parse(accountId);
      const ids = State.shape.offHere.unwrap().valueType.parse(pluginIds);
      const all = { ...state.offHere };
      if (ids.length > 0) all[account] = [...new Set(ids)];
      else delete all[account];
      if (Object.keys(all).length > 0) state.offHere = all;
      else delete state.offHere;
      await save();
    },

    /**
     * The file at `address`: an enabled plugin's, at its current key, inside
     * its folder. Null for anything else.
     */
    file({ id, key, path }: PluginAddress): PluginFile | null {
      const plugin = find(id);
      if (!plugin?.enabled || keyOf(plugin) !== key) return null;
      const base = resolve(plugin.development ?? installed(plugin));
      const file = resolve(base, path);
      const inside = relative(base, file);
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
      return { path: file, type: fileType(file) };
    },
  };
}

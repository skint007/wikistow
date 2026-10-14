import type {
  InstalledPlugin,
  PluginCandidate,
  PluginScope,
  PluginsState,
} from '@wikistow/contracts';
import { asksMore, Manifest, PageAccess, trustLevel } from '@wikistow/plugin-sdk/manifest';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import {
  copyPluginFiles,
  PluginFolderError,
  readPluginFolder,
  type PluginFolder,
} from './folder.ts';

const Level = z.enum(['theme', 'script', 'app']);
const Scope = z.strictObject({
  spaceId: z.string().min(1).max(100),
  folderId: z.string().min(1).max(100).nullable(),
  access: z.enum(['read', 'write']),
});

const Stored = z.strictObject({
  manifest: Manifest,
  /** An installed plugin's hash, which names its folder; null for a development one. */
  hash: z.string().nullable(),
  development: z.string().nullable(),
  enabled: z.boolean(),
  /** What the person approved: more of either asks again. */
  approved: z.strictObject({ access: PageAccess, level: Level }),
});
type Stored = z.infer<typeof Stored>;

/** `plugins.json`: IDs and choices only, never content. */
const State = z.strictObject({
  plugins: z.array(Stored),
  /** Page access, by account and then plugin. */
  access: z.record(z.string(), z.record(z.string(), z.array(Scope))),
});
type State = z.infer<typeof State>;

const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** A file served under `/plugins/`, with what it is served as. */
export type PluginFile = { path: string; type: string };

/** What a file is served as, by its extension. */
export const fileType = (file: string) =>
  TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';

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
  const installed = (plugin: Stored) => join(root, plugin.manifest.id, plugin.hash ?? '');
  const keyOf = (plugin: Stored) => plugin.hash ?? `dev-${reloads.get(plugin.manifest.id) ?? 0}`;

  const view = (plugin: Stored): InstalledPlugin => ({
    manifest: plugin.manifest,
    level: trustLevel(plugin.manifest),
    key: keyOf(plugin),
    development: plugin.development,
    enabled: plugin.enabled,
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
      await save();
      if (!plugin.development)
        await rm(join(root, plugin.manifest.id), { recursive: true, force: true });
    },

    access: (accountId: unknown): Record<string, PluginScope[]> =>
      state.access[z.string().parse(accountId)] ?? {},

    async setAccess(accountId: unknown, pluginId: unknown, scopes: unknown) {
      const account = z.string().min(1).parse(accountId);
      const plugin = find(z.string().parse(pluginId));
      if (!plugin) throw new PluginFolderError('That plugin isn’t installed.');
      const mine = (state.access[account] ??= {});
      mine[plugin.manifest.id] = z.array(Scope).max(100).parse(scopes);
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

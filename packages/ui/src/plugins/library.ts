import {
  pluginOperations,
  toBase64,
  type ClientContext,
  type PluginApproval,
} from '@wikistow/client';
import { pluginRoutes, type InstalledPlugin, type PluginUploadFile } from '@wikistow/contracts';
import { checkPlugin } from '@wikistow/plugin-sdk/files';
import { trustLevel, type Manifest } from '@wikistow/plugin-sdk/manifest';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { api } from '../api';
import { vaultStore } from '../vault/store';
import type { RuntimeSource } from './runtime';
import { tabSafeMode } from './safe-mode';

/** What every library query's key starts with, to show the library afresh after a change. */
export const LIBRARY_KEY = ['plugin-library'];

/** The listing's `have`: the hashes the person approved, so the Only me plugins they installed stay listed. */
const have = (approvals: readonly PluginApproval[]) =>
  pluginRoutes.haveQuery(approvals.map(({ hash }) => hash));

const listLibrary = async (approvals: readonly PluginApproval[]) =>
  (await api.call(pluginRoutes.listPlugins, { query: { have: have(approvals) } })).plugins;

/**
 * The server's plugin library (ADR 0002) as the person in `ctx` may see it
 * (ADR 0004): every plugin, newest version first. Keyed by the hashes they
 * approved, so it is listed again as those change, showing the last
 * listing meanwhile.
 */
export const libraryQuery = (ctx: ClientContext) => {
  const approvals = pluginOperations.listPluginApprovals(ctx);
  return queryOptions({
    queryKey: [...LIBRARY_KEY, have(approvals)],
    queryFn: () => listLibrary(approvals),
    placeholderData: keepPreviousData,
  });
};

/** The IDs of the person's own Only me plugins. */
export const privatePluginsQuery = queryOptions({
  queryKey: [...LIBRARY_KEY, 'private'],
  queryFn: async () => new Set((await api.call(pluginRoutes.privatePlugins)).ids),
});

export type LibraryPlugin = pluginRoutes.LibraryPlugin;
export type LibraryVersion = pluginRoutes.LibraryVersion;

/** A library version as the runtime runs it: its files are served under its hash. */
export const asInstalled = (version: LibraryVersion, enabled: boolean): InstalledPlugin => ({
  manifest: version.manifest,
  level: trustLevel(version.manifest),
  key: version.hash,
  development: null,
  library: true,
  enabled,
});

/** A built plugin's files to upload, read and hashed here as the server will: what the confirmation shows. */
export type PluginUpload = {
  files: readonly PluginUploadFile[];
  manifest: Manifest;
  hash: string;
};

/** Check `files` as one built plugin folder (`checkPlugin`), throwing what is wrong with it. */
export async function readUpload(files: readonly PluginUploadFile[]): Promise<PluginUpload> {
  const { manifest, hash } = await checkPlugin(
    new Map(files.map(({ path, data }) => [path, data])),
  );
  return { files, manifest, hash };
}

/**
 * Upload `upload` to the library as a version of its ID, as `visibility`
 * if given (a new ID is otherwise Shared, an existing one stays as it is),
 * then install it for the person (ADR 0004): approve its hash, or for
 * an ID they installed, approve it in place of the older hash, keeping
 * page access and on or off. Nothing is approved unless the server
 * answers the hash computed here, which the person was shown.
 */
export async function uploadAndInstall(
  ctx: ClientContext,
  { files, manifest, hash }: PluginUpload,
  visibility?: pluginRoutes.PluginVisibility,
) {
  const { version } = await api.call(pluginRoutes.uploadPlugin, {
    body: {
      files: files.map(({ path, data }) => ({ path, data: toBase64(data) })),
      ...(visibility && { visibility }),
    },
  });
  if (version.hash !== hash)
    throw new Error('The server answered with different files, so the plugin wasn’t installed.');
  const { id } = manifest;
  if (pluginOperations.listPluginApprovals(ctx).some((approval) => approval.id === id))
    await pluginOperations.updatePlugin(ctx, id, hash);
  else await pluginOperations.approvePlugin(ctx, { id, hash, access: [] });
  return version;
}

/**
 * Each approval whose version the library still has, in the record's
 * order, as the runtime runs it. An approval whose version was removed is
 * left out: Settings says it is no longer in the library.
 */
export const approvedPlugins = (
  library: readonly LibraryPlugin[],
  approvals: readonly PluginApproval[],
): InstalledPlugin[] =>
  approvals.flatMap(({ id, hash, enabled }) => {
    const version = library
      .find((plugin) => plugin.id === id)
      ?.versions.find((each) => each.hash === hash);
    return version ? [asInstalled(version, enabled)] : [];
  });

/** The library as last listed, with the session it was listed in. */
let lastListed: { ctx: ClientContext; library: LibraryPlugin[] } | null = null;

export const openCtx = () => {
  const vault = vaultStore.get();
  if (vault.status !== 'unlocked') throw new Error('Unlock your vault first.');
  return vault.ctx;
};

/**
 * The browser's plugins: the library versions the person approved, kept in
 * their account's contacts record, so they are known only once the vault
 * is open. Files come from the server's `/plugins/<id>/<hash>/…`, unhashed:
 * the browser trusts the server for them as for the app's own code.
 */
export const librarySource: Omit<RuntimeSource, 'pages' | 'handle'> = {
  async list() {
    const safeMode = tabSafeMode.on();
    const vault = vaultStore.get();
    if (vault.status !== 'unlocked') return { safeMode, plugins: null };
    const approvals = pluginOperations.listPluginApprovals(vault.ctx);
    // Nothing approved needs no request.
    if (approvals.length === 0) return { safeMode, plugins: [] };
    try {
      lastListed = { ctx: vault.ctx, library: await listLibrary(approvals) };
    } catch {
      // The server is away: the library as this session last saw it, so
      // what runs keeps running. Before any listing, nothing is known.
      if (lastListed?.ctx !== vault.ctx) return { safeMode, plugins: null };
    }
    return { safeMode, plugins: approvedPlugins(lastListed.library, approvals) };
  },
  async access() {
    const vault = vaultStore.get();
    if (vault.status !== 'unlocked') return {};
    return Object.fromEntries(
      pluginOperations.listPluginApprovals(vault.ctx).map(({ id, access }) => [id, access]),
    );
  },
  async setAccess(pluginId, scopes) {
    await pluginOperations.setPluginAccess(openCtx(), pluginId, scopes);
  },
  async disable(pluginId) {
    await pluginOperations.setPluginEnabled(openCtx(), pluginId, false);
  },
};

import {
  pluginOperations,
  toBase64,
  type ClientContext,
  type PluginApproval,
} from '@wikistow/client';
import { pluginRoutes, type InstalledPlugin, type PluginUploadFile } from '@wikistow/contracts';
import { trustLevel } from '@wikistow/plugin-sdk/manifest';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../api';
import { vaultStore } from '../vault/store';
import type { RuntimeSource } from './runtime';
import { tabSafeMode } from './safe-mode';

/** The server's plugin library (ADR 0002): every plugin, newest version first. */
export const libraryQuery = queryOptions({
  queryKey: ['plugin-library'],
  queryFn: async () => (await api.call(pluginRoutes.listPlugins)).plugins,
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

/** Upload a built plugin's files to the library as a new version of its ID. */
export const uploadToLibrary = async (files: readonly PluginUploadFile[]) =>
  api.call(pluginRoutes.uploadPlugin, {
    body: { files: files.map(({ path, data }) => ({ path, data: toBase64(data) })) },
  });

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
      const { plugins } = await api.call(pluginRoutes.listPlugins);
      lastListed = { ctx: vault.ctx, library: plugins };
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
  ownsStorage: false,
};

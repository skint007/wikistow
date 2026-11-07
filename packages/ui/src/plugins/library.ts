import {
  pluginOperations,
  toBase64,
  type ClientContext,
  type PluginApproval,
} from '@wikistow/client';
import {
  libraryInstall,
  pluginRoutes,
  type InstalledPlugin,
  type PluginUploadFile,
} from '@wikistow/contracts';
import { checkPlugin } from '@wikistow/plugin-sdk/files';
import { trustLevel, type Manifest } from '@wikistow/plugin-sdk/manifest';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { api } from '../api';
import { vaultStore } from '../vault/store';
import { tabSafeMode } from './safe-mode';
import type { AppPluginStore, LibraryRequest, PluginListing, PluginStore } from './store';

/** What every library query's key starts with, to show the library afresh after a change. */
export const LIBRARY_KEY = ['plugin-library'];

/** The listing's `have`: the hashes the person approved, so the Only me plugins they installed stay listed. */
const have = (approvals: readonly PluginApproval[]) =>
  pluginRoutes.haveQuery(approvals.map(({ hash }) => hash));

const listLibrary = async (approvals: readonly PluginApproval[]) =>
  (
    await api.call(pluginRoutes.listPlugins, {
      query: { have: have(approvals), manifest: pluginRoutes.MANIFEST_READ },
    })
  ).plugins;

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

/**
 * What the approval dialog asks about for a library version (or an upload
 * of one), as an update of `installed`, the version approved now, if given.
 */
export const libraryRequest = (
  { manifest, hash }: { manifest: Manifest; hash: string },
  installed: Manifest | null = null,
): LibraryRequest => ({
  id: manifest.id,
  hash,
  manifest,
  level: trustLevel(manifest),
  development: null,
  replaces: installed && {
    version: installed.version,
    level: trustLevel(installed),
    access: installed.access,
  },
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
 * then install it for the person (ADR 0004) through `store`: approved,
 * or for an ID they installed approved in place of the older hash.
 * Nothing is approved unless the server answers the hash computed here,
 * which the person was shown.
 */
export async function uploadAndInstall(
  store: PluginStore<LibraryRequest>,
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
  await store.approve(libraryRequest({ manifest, hash }));
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
  approvals.flatMap(({ id, hash, enabled, ownParts }) => {
    const version = library
      .find((plugin) => plugin.id === id)
      ?.versions.find((each) => each.hash === hash);
    return version ? [libraryInstall(version.manifest, hash, enabled, ownParts)] : [];
  });

const openCtx = () => {
  const vault = vaultStore.get();
  if (vault.status !== 'unlocked') throw new Error('Unlock your vault first.');
  return vault.ctx;
};

/** The approvals of the open account, none while the vault is locked. */
export const openApprovals = () => {
  const vault = vaultStore.get();
  return vault.status === 'unlocked' ? pluginOperations.listPluginApprovals(vault.ctx) : [];
};

/**
 * Where a library store's plugins run from: the browser's library
 * listing, or the desktop's copies. Null when that isn't known now.
 */
type LibraryFiles = (
  ctx: ClientContext,
  approvals: readonly PluginApproval[],
) => Promise<Pick<PluginListing, 'plugins' | 'unavailable'> | null>;

/**
 * The library plugins the account approved, kept in its contacts record
 * (ADR 0002) with their on/off, own parts and page access, so they follow
 * the person to every device and are known only while the vault is open.
 * `files` says which of them can run here.
 */
export function libraryStore(files: LibraryFiles): PluginStore<LibraryRequest> {
  return {
    async list() {
      const safeMode = tabSafeMode.on();
      const vault = vaultStore.get();
      if (vault.status !== 'unlocked')
        return { safeMode, plugins: null, access: {}, unavailable: {} };
      const approvals = pluginOperations.listPluginApprovals(vault.ctx);
      const access = Object.fromEntries(approvals.map(({ id, access }) => [id, access]));
      const held = await files(vault.ctx, approvals);
      // The record's choices, whichever copy runs: the desktop's main keeps none of them.
      const plugins =
        held?.plugins?.map((plugin) => ({
          ...plugin,
          ownParts: approvals.find(({ id }) => id === plugin.manifest.id)?.ownParts ?? [],
        })) ?? null;
      return { safeMode, unavailable: {}, ...held, plugins, access };
    },
    // A new install is turned on with no page access; for an ID already
    // approved, the new hash replaces the old, keeping access and on/off.
    async approve({ id, hash }) {
      const ctx = openCtx();
      if (pluginOperations.listPluginApprovals(ctx).some((approval) => approval.id === id))
        await pluginOperations.updatePlugin(ctx, id, hash);
      else await pluginOperations.approvePlugin(ctx, { id, hash, access: [] });
    },
    async enable({ id }, on) {
      await pluginOperations.setPluginEnabled(openCtx(), id, on);
    },
    async setAccess({ id }, scopes) {
      await pluginOperations.setPluginAccess(openCtx(), id, scopes);
    },
    async setOwnParts({ id }, regions) {
      await pluginOperations.setPluginOwnParts(openCtx(), id, regions);
    },
    async remove({ id }) {
      await pluginOperations.removePlugin(openCtx(), id);
    },
  };
}

/** The library as last listed, with the session it was listed in. */
let lastListed: { ctx: ClientContext; library: LibraryPlugin[] } | null = null;

/**
 * The browser's plugins: the library versions the person approved. Files
 * come from the server's `/plugins/<id>/<hash>/…`, unhashed: the browser
 * trusts the server for them as for the app's own code.
 */
export function browserStore(): AppPluginStore {
  const library = libraryStore(async (ctx, approvals) => {
    // Nothing approved needs no request.
    if (approvals.length === 0) return { plugins: [], unavailable: {} };
    try {
      lastListed = { ctx, library: await listLibrary(approvals) };
    } catch {
      // The server is away: the library as this session last saw it, so
      // what runs keeps running. Before any listing, nothing is known.
      if (lastListed?.ctx !== ctx) return null;
    }
    const plugins = approvedPlugins(lastListed.library, approvals);
    // Approved, but its version left the library: it can't load.
    const unavailable = Object.fromEntries(
      approvals
        .filter(({ id }) => !plugins.some((plugin) => plugin.manifest.id === id))
        .map(({ id }) => [id, 'The version you installed is no longer in the library.']),
    );
    return { plugins, unavailable };
  });
  return {
    ...library,
    async approve(version) {
      if ('token' in version) throw new Error('Only the desktop app installs from a folder.');
      await library.approve(version);
    },
    folders: null,
    approvals: openApprovals,
  };
}

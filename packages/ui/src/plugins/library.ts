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
import { vaultStore, type VaultState } from '../vault/store';
import { tabSafeMode } from './safe-mode';
import { developmentStore } from './development';
import {
  inFrontOfLibrary,
  type AppPluginStore,
  type LibraryRequest,
  type PluginListing,
  type PluginRef,
  type PluginStore,
} from './store';

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

/** A size in KB or MB, as Settings shows it. */
export const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** A file of a chosen folder: its path from the folder's top, and as the person sees it. */
export type FolderFile = { file: File; path: string; shown: string };

/**
 * A chosen folder's files as an upload. Paths are checked here as the
 * server checks them, naming the first bad file, and so are the limits,
 * before anything is sent.
 */
export async function readFolder(chosen: readonly FolderFile[]): Promise<PluginUploadFile[]> {
  if (chosen.length > pluginRoutes.MAX_VERSION_FILES)
    throw new Error(`A plugin holds at most ${pluginRoutes.MAX_VERSION_FILES} files.`);
  const bytes = chosen.reduce((total, { file }) => total + file.size, 0);
  if (bytes > pluginRoutes.MAX_VERSION_BYTES)
    throw new Error(`A plugin holds at most ${size(pluginRoutes.MAX_VERSION_BYTES)}.`);
  for (const { path, shown } of chosen) {
    const problem = pluginRoutes.uploadPathProblem(path, shown);
    if (problem) throw new Error(problem);
  }
  return Promise.all(
    chosen.map(async ({ file, path }) => ({
      path,
      data: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

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

type Unlocked = Extract<VaultState, { status: 'unlocked' }>;

/**
 * Where a device keeps the library plugins the open account turned off on
 * it only (#312), by ID: browser storage, or the desktop's `plugins.json`.
 * Never the contacts record, so the other devices keep them on.
 */
export type OffHere = {
  get(vault: Unlocked): Promise<readonly string[]>;
  set(vault: Unlocked, pluginIds: readonly string[]): Promise<void>;
};

/**
 * The library plugins the account approved, kept in its contacts record
 * (ADR 0002) with their on/off, own parts, page access and settings, so they follow
 * the person to every device and are known only while the vault is open.
 * `files` says which of them can run here. `offHere` keeps those turned
 * off on this device only: listed as off (`enabled` false), as if turned
 * off for the account, and named in the listing's `offHere`.
 */
export function libraryStore(files: LibraryFiles, offHere: OffHere): PluginStore<LibraryRequest> {
  /** What is off here, forgetting any no longer approved, so a later install starts on. */
  const offNow = async (vault: Unlocked, approvals: readonly PluginApproval[]) => {
    const kept = await offHere.get(vault);
    const off = kept.filter((id) => approvals.some((approval) => approval.id === id));
    if (off.length < kept.length) await offHere.set(vault, off);
    return off;
  };
  return {
    async list() {
      const safeMode = tabSafeMode.on();
      const vault = vaultStore.get();
      if (vault.status !== 'unlocked')
        return {
          safeMode,
          plugins: null,
          access: {},
          settings: {},
          offHere: [],
          unavailable: {},
        };
      const approvals = pluginOperations.listPluginApprovals(vault.ctx);
      const access = Object.fromEntries(approvals.map(({ id, access }) => [id, access]));
      const settings = Object.fromEntries(approvals.map(({ id, settings }) => [id, settings]));
      const off = await offNow(vault, approvals);
      // Off here runs nowhere here: the desktop's main doesn't serve its files either.
      const held = await files(
        vault.ctx,
        approvals.map((approval) =>
          off.includes(approval.id) ? { ...approval, enabled: false } : approval,
        ),
      );
      // The record's choices, whichever copy runs: the desktop's main keeps none of them.
      const plugins =
        held?.plugins?.map((plugin) => ({
          ...plugin,
          ownParts: approvals.find(({ id }) => id === plugin.manifest.id)?.ownParts ?? [],
        })) ?? null;
      return { safeMode, unavailable: {}, ...held, plugins, access, settings, offHere: off };
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
    async setSettings({ id }, settings) {
      await pluginOperations.setPluginSettings(openCtx(), id, settings);
    },
    async remove({ id }) {
      await pluginOperations.removePlugin(openCtx(), id);
      await turnOffHere(id, false);
    },
    setOffHere: ({ id }, off) => turnOffHere(id, off),
  };

  async function turnOffHere(id: string, off: boolean) {
    const vault = vaultStore.get();
    if (vault.status !== 'unlocked') throw new Error('Unlock your vault first.');
    const others = (await offHere.get(vault)).filter((each) => each !== id);
    await offHere.set(vault, off ? [...others, id] : others);
  }
}

/**
 * The browser's library plugins off here (#312): kept in this browser's
 * storage per server and account, under `wikistow.pluginsOffHere.`, for
 * every tab, until turned back on. Another tab sees a change at its next listing.
 */
const browserOffHere: OffHere = {
  async get({ ctx, vault }) {
    try {
      const kept: unknown = JSON.parse(localStorage.getItem(offHereKey(ctx, vault)) ?? '[]');
      return Array.isArray(kept) ? kept.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  },
  async set({ ctx, vault }, ids) {
    try {
      if (ids.length > 0) localStorage.setItem(offHereKey(ctx, vault), JSON.stringify(ids));
      else localStorage.removeItem(offHereKey(ctx, vault));
    } catch {
      // Storage refused (some private windows): it stays on here.
    }
  },
};
const offHereKey = (ctx: ClientContext, vault: Unlocked['vault']) =>
  `wikistow.pluginsOffHere.${ctx.installationId}.${vault.accountId}`;

/** The library as last listed, with the session it was listed in. */
let lastListed: { ctx: ClientContext; library: LibraryPlugin[] } | null = null;

/**
 * The browser's plugins: the library versions the person approved, and
 * the development folders loaded in this tab (`developmentStore`), one of
 * which replaces the library plugin of its ID here. Files come from the
 * server's `/plugins/<id>/<hash>/…` (or `dev-<hash>-<n>`), unhashed: the
 * browser trusts the server for them as for the app's own code.
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
  }, browserOffHere);
  const own = developmentStore();
  const pick = (ref: PluginRef) => (ref.library ? library : own);
  return {
    async list() {
      const held = await library.list();
      // Not known now (locked, or the server away before any listing):
      // nor are this tab's development folders, which need both.
      if (held.plugins === null) return held;
      return { safeMode: held.safeMode, ...inFrontOfLibrary(await own.list(), held) };
    },
    async approve(version) {
      if ('token' in version) await own.approve(version);
      else await library.approve(version);
    },
    enable: (ref, on) => pick(ref).enable(ref, on),
    setAccess: (ref, scopes) => pick(ref).setAccess(ref, scopes),
    setSettings: (ref, settings) => pick(ref).setSettings(ref, settings),
    setOwnParts: (ref, regions) => pick(ref).setOwnParts(ref, regions),
    setOffHere: (ref, off) => pick(ref).setOffHere(ref, off),
    remove: (ref) => pick(ref).remove(ref),
    folders: null,
    development: own.development,
    approvals: openApprovals,
  };
}

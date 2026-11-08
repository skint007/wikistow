import type {
  InstalledPlugin,
  PluginCandidate,
  PluginScope,
  PluginUploadFile,
} from '@wikistow/contracts';
import type { PluginApproval } from '@wikistow/client';
import type { Settings } from '@wikistow/plugin-sdk';

/**
 * What the approval dialog shows for a version: a plugin folder read for
 * install or development, or a version in the server's library. For an
 * update, `replaces` is what is approved now, so the dialog says what
 * changes.
 */
export type ApprovalRequest = Pick<
  PluginCandidate,
  'manifest' | 'level' | 'development' | 'hash' | 'replaces'
>;

/** Which install a change is for: on the desktop one ID can be both a folder install and a library approval. */
export type PluginRef = { id: string; library: boolean };

export const refOf = (plugin: InstalledPlugin): PluginRef => ({
  id: plugin.manifest.id,
  library: plugin.library,
});

/** What a store holds now. */
export type PluginListing = {
  /** Started with no plugins: nothing runs. */
  safeMode: boolean;
  /**
   * Every plugin here, on or off. Null when that isn't known now, as for
   * library plugins while the vault is locked, since their approvals are encrypted.
   */
  plugins: InstalledPlugin[] | null;
  /** The open account's page access, by plugin; empty while the vault is locked. */
  access: Readonly<Record<string, readonly PluginScope[]>>;
  /** The open account's settings, by plugin, as stored (`host.settings`); empty while the vault is locked. */
  settings: Readonly<Record<string, Settings>>;
  /**
   * The library plugins turned off on this device only (#312), by ID,
   * which `plugins` lists as off; empty while the vault is locked.
   */
  offHere: readonly string[];
  /** Plugins it knows of but couldn't load, by ID, with why. */
  unavailable: Readonly<Record<string, string>>;
};

/**
 * Where a runtime's plugins come from, and the person's choices for each:
 * listing, approving, turning on and off, page access and removal. Each
 * store keeps them where ADR 0001 and ADR 0002 say: `plugins.json` for the
 * desktop's folder and development installs (on/off per computer, page
 * access per account), the account's contacts record for library plugins.
 * ADR 0011's **Use the app's own** is kept the same way as on/off, as
 * `ownParts` beside `enabled` in each. Settings (#310) are kept as page
 * access is: per account, in `plugins.json` or beside the approval. A
 * library plugin can also be turned off on one device only (#312), kept
 * on that device: in browser storage, or in `plugins.json`. It runs here
 * only while it is on for the account and not off here.
 *
 * `Version` is what the store approves. Approving an installed ID updates
 * it, keeping its page access. A library update keeps on/off too; a folder
 * install or development reload turns it on. Every update is shown to the
 * person first with what it replaces, except a development reload, which
 * asks again only if it asks for more (`asksMore`).
 */
export type PluginStore<Version> = {
  list(): Promise<PluginListing>;
  approve(version: Version): Promise<void>;
  enable(plugin: PluginRef, on: boolean): Promise<void>;
  setAccess(plugin: PluginRef, scopes: readonly PluginScope[]): Promise<void>;
  /** Replace the plugin's settings for the open account, as checked by the runtime. */
  setSettings(plugin: PluginRef, settings: Settings): Promise<void>;
  /** The regions where the app's own part shows in place of the plugin's (`InstalledPlugin.ownParts`). */
  setOwnParts(plugin: PluginRef, regions: readonly string[]): Promise<void>;
  /** Turn a library plugin off on this device only, or back on (`PluginListing.offHere`). */
  setOffHere(plugin: PluginRef, off: boolean): Promise<void>;
  /** Its page access and settings go; pages keep its blocks and data. */
  remove(plugin: PluginRef): Promise<void>;
};

/**
 * A device's own installs (the desktop's folder and development installs,
 * a browser tab's development folders) listed in front of the library
 * plugins: one of the same ID replaces the library's here, with its own
 * page access and settings.
 */
export function inFrontOfLibrary(
  own: Pick<PluginListing, 'plugins' | 'access' | 'settings'>,
  library: PluginListing,
): Omit<PluginListing, 'safeMode'> {
  const mine = own.plugins ?? [];
  const here = new Set(mine.map(({ manifest }) => manifest.id));
  const notHere = <T>(record: Readonly<Record<string, T>>) =>
    Object.fromEntries(Object.entries(record).filter(([id]) => !here.has(id)));
  return {
    plugins: [...mine, ...(library.plugins ?? []).filter(({ manifest }) => !here.has(manifest.id))],
    access: { ...own.access, ...notHere(library.access) },
    settings: { ...own.settings, ...notHere(library.settings) },
    offHere: library.offHere,
    unavailable: library.unavailable,
  };
}

/** Any store, as the runtime uses it: it lists and changes choices, and approves nothing. */
export type AnyPluginStore = PluginStore<never>;

/** A library version to approve, as a new install or as an update of the one approved. */
export type LibraryRequest = ApprovalRequest & { id: string; hash: string };

/** What only the desktop's store does: install from a folder, and what goes with that. */
export type FolderInstalls = {
  /** Read a folder the person picks for approval; null if they cancelled. */
  pick(kind: 'install' | 'development'): Promise<PluginCandidate | null>;
  /** Read a development folder again: a candidate to approve if it now asks for more. */
  reload(pluginId: string): Promise<PluginCandidate | null>;
  /** An installed plugin's files, to share to the library. */
  files(pluginId: string): Promise<PluginUploadFile[]>;
};

/**
 * A development folder the person chose in a browser: its handle, which
 * the File System Access picker gives and Reload reads again (Chromium),
 * or the files a folder input gives, chosen again at each Reload.
 */
export type ChosenFolder = { handle: FileSystemDirectoryHandle } | { files: File[] };

/** What only the browser's store does: load a development folder (#317), held in this tab. */
export type DevelopmentFolders = {
  /** Whether Reload reads the folder again by itself, from a kept handle; otherwise the person chooses it again. */
  keepsFolder: boolean;
  /** Read a chosen folder for approval as a development plugin. */
  load(folder: ChosenFolder): Promise<PluginCandidate>;
  /**
   * Read a development plugin's folder again, from `folder` or its kept
   * handle, and run it: a candidate to approve instead if it now asks for more.
   */
  reload(pluginId: string, folder: ChosenFolder | null): Promise<PluginCandidate | null>;
};

/** The app's own store: the desktop's, or the browser's library plugins and development folders. */
export type AppPluginStore = PluginStore<PluginCandidate | LibraryRequest> & {
  /** Null in the browser, which installs only from the library. */
  folders: FolderInstalls | null;
  /** Null in the desktop app, whose `folders` load development folders. */
  development: DevelopmentFolders | null;
  /** The library plugins the open account approved, in its record's order, versions gone from the library included. */
  approvals(): readonly PluginApproval[];
};

/**
 * A store held in memory, for tests. Approving a plugin installs it, or
 * updates the one of its ID as the library does, keeping on/off, own
 * parts, page access, settings and off here. The workshop's preview keeps its
 * settings in one, so trying a version leaves the real ones as they are.
 */
export function memoryStore({
  plugins = [],
  access = {},
  settings = {},
  safeMode = false,
}: {
  plugins?: InstalledPlugin[];
  access?: Record<string, readonly PluginScope[]>;
  settings?: Record<string, Settings>;
  safeMode?: boolean;
} = {}): PluginStore<InstalledPlugin> {
  let held = [...plugins];
  let scopes = { ...access };
  let kept = { ...settings };
  let off: string[] = [];
  const is = (ref: PluginRef) => (plugin: InstalledPlugin) =>
    plugin.manifest.id === ref.id && plugin.library === ref.library;
  const without = <T>(record: Record<string, T>, id: string) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== id));
  return {
    list: async () => ({
      safeMode,
      plugins: held.map((plugin) =>
        plugin.library && off.includes(plugin.manifest.id) ? { ...plugin, enabled: false } : plugin,
      ),
      access: { ...scopes },
      settings: { ...kept },
      offHere: [...off],
      unavailable: {},
    }),
    async approve(version) {
      const before = held.find(is(refOf(version)));
      held = [
        ...held.filter((plugin) => plugin !== before),
        { ...version, enabled: before?.enabled ?? true, ownParts: before?.ownParts ?? [] },
      ];
    },
    async enable(ref, on) {
      held = held.map((plugin) => (is(ref)(plugin) ? { ...plugin, enabled: on } : plugin));
    },
    async setOwnParts(ref, regions) {
      held = held.map((plugin) =>
        is(ref)(plugin) ? { ...plugin, ownParts: [...regions] } : plugin,
      );
    },
    async setOffHere(ref, value) {
      off = off.filter((id) => id !== ref.id);
      if (value) off.push(ref.id);
    },
    async setAccess(ref, list) {
      scopes = { ...scopes, [ref.id]: [...list] };
    },
    async setSettings(ref, value) {
      kept = { ...kept, [ref.id]: value };
    },
    async remove(ref) {
      held = held.filter((plugin) => !is(ref)(plugin));
      scopes = without(scopes, ref.id);
      kept = without(kept, ref.id);
      if (ref.library) off = off.filter((id) => id !== ref.id);
    },
  };
}

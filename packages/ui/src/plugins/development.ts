import { toBase64 } from '@wikistow/client';
import {
  installedPlugin,
  pluginRoutes,
  type PluginCandidate,
  type PluginScope,
} from '@wikistow/contracts';
import type { PageAccess, Settings, TrustLevel } from '@wikistow/plugin-sdk';
import { asksMore, trustLevel, type Manifest } from '@wikistow/plugin-sdk/manifest';
import { api } from '../api';
import { vaultStore } from '../vault/store';
import { folderFiles } from './choose-folder';
import { readFolder, readUpload, type FolderFile, type PluginUpload } from './library';
import type { ChosenFolder, DevelopmentFolders, PluginListing, PluginStore } from './store';

declare global {
  interface Window {
    /** The File System Access picker: Chromium only, so not in TypeScript's DOM types. */
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

/** Whether this browser can keep a chosen folder to read again (`showDirectoryPicker`). */
export const keepsFolders = () => typeof window.showDirectoryPicker === 'function';

/** Ask for a folder through the File System Access picker; null if the person cancelled. */
export async function pickFolder(): Promise<ChosenFolder | null> {
  try {
    const handle = await window.showDirectoryPicker?.({ id: 'wikistow-plugin', mode: 'read' });
    return handle ? { handle } : null;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

/** Every file under `handle`, each path from its top. */
async function filesUnder(handle: FileSystemDirectoryHandle, under = ''): Promise<FolderFile[]> {
  const found: FolderFile[] = [];
  for await (const [name, entry] of handle.entries()) {
    const path = under ? `${under}/${name}` : name;
    if (entry.kind === 'file') {
      found.push({ path, shown: path, file: await entry.getFile() });
    } else found.push(...(await filesUnder(entry, path)));
    // Past the limit already: readFolder says so.
    if (found.length > pluginRoutes.MAX_VERSION_FILES) break;
  }
  return found;
}

/** A chosen folder's name and its files, checked as one built plugin folder. */
async function readChosen(folder: ChosenFolder) {
  if ('handle' in folder) {
    return {
      name: folder.handle.name,
      upload: await readUpload(await readFolder(await filesUnder(folder.handle))),
    };
  }
  const [first] = folder.files;
  return {
    // A folder input's paths start with the chosen folder's own name.
    name: first?.webkitRelativePath.split('/')[0] || 'the folder you chose',
    upload: await readUpload(await readFolder(folderFiles(folder.files))),
  };
}

/** A development plugin this tab runs, with the choices made for it. */
type Held = {
  accountId: string;
  manifest: Manifest;
  hash: string;
  /** The chosen folder's name, which Settings shows. */
  folder: string;
  /** Kept to read again at Reload, where the browser gives one. */
  handle: FileSystemDirectoryHandle | null;
  /** Which of the tab's loads and Reloads ran it last, which names its files' address. */
  load: number;
  enabled: boolean;
  ownParts: readonly string[];
  /** What the person approved: more of either asks again. */
  approved: { access: PageAccess; level: TrustLevel };
  access: readonly PluginScope[];
  settings: Settings;
};

/** A folder read for the person to approve. */
type Pending = {
  token: string;
  accountId: string;
  upload: PluginUpload;
  folder: string;
  handle: FileSystemDirectoryHandle | null;
};

const openAccount = () => {
  const vault = vaultStore.get();
  if (vault.status !== 'unlocked') throw new Error('Unlock your vault first.');
  return vault.vault.accountId;
};

/** Upload a read folder as the person's development build of its ID, checking the server stored those files. */
async function send({ manifest, files, hash }: PluginUpload) {
  const stored = await api.call(pluginRoutes.putDevelopment, {
    params: { pluginId: manifest.id },
    body: { files: files.map(({ path, data }) => ({ path, data: toBase64(data) })) },
  });
  if (stored.hash !== hash)
    throw new Error('The server answered with different files, so the plugin wasn’t loaded.');
}

/**
 * The browser's development folders (#317): each a plugin folder the
 * person chose, approved as the desktop approves one (for the folder, not
 * a hash; asked again only when it asks for more), uploaded at each Reload
 * as their own development build on the server, since the app's policy
 * runs only the server's scripts, and run from there under `dev-<hash>-<n>`.
 * Everything about them, choices included, is held in this tab only, for
 * the account that loaded them, and ends with it: the account's record
 * and other tabs never see them. Listed only while that account's vault is
 * open, as library plugins are.
 */
export function developmentStore(): PluginStore<PluginCandidate> & {
  development: DevelopmentFolders;
} {
  let held: Held[] = [];
  let pending: Pending | null = null;
  // Counted across removals too, so each load gets an address this tab never imported.
  let loads = 0;

  const find = (id: string) => {
    const vault = vaultStore.get();
    return vault.status === 'unlocked'
      ? held.find(
          (plugin) => plugin.manifest.id === id && plugin.accountId === vault.vault.accountId,
        )
      : undefined;
  };
  const change = (id: string, changes: Partial<Held>) => {
    held = held.map((plugin) => (plugin === find(id) ? { ...plugin, ...changes } : plugin));
  };

  const candidate = (
    { upload, folder, handle }: Omit<Pending, 'token' | 'accountId'>,
    before: Held | undefined,
  ): PluginCandidate => {
    const token = crypto.randomUUID();
    pending = { token, accountId: openAccount(), upload, folder, handle };
    return {
      token,
      manifest: upload.manifest,
      level: trustLevel(upload.manifest),
      development: folder,
      hash: null,
      replaces: before
        ? {
            version: before.manifest.version,
            level: before.approved.level,
            access: before.approved.access,
          }
        : null,
    };
  };

  return {
    async list(): Promise<PluginListing> {
      const vault = vaultStore.get();
      const mine =
        vault.status === 'unlocked'
          ? held.filter((plugin) => plugin.accountId === vault.vault.accountId)
          : [];
      return {
        safeMode: false,
        plugins: mine.map((plugin) =>
          installedPlugin({
            manifest: plugin.manifest,
            key: pluginRoutes.developmentKey(plugin.hash, plugin.load),
            development: plugin.folder,
            library: false,
            enabled: plugin.enabled,
            ownParts: plugin.ownParts,
          }),
        ),
        access: Object.fromEntries(mine.map(({ manifest, access }) => [manifest.id, access])),
        settings: Object.fromEntries(mine.map(({ manifest, settings }) => [manifest.id, settings])),
        offHere: [],
        unavailable: {},
      };
    },
    // Loading or approving more turns it on, as on the desktop, keeping its other choices.
    async approve({ token }) {
      if (!pending || pending.token !== token || pending.accountId !== openAccount())
        throw new Error('That plugin is no longer waiting to be approved.');
      const { upload, folder, handle, accountId } = pending;
      pending = null;
      await send(upload);
      const { manifest, hash } = upload;
      const before = find(manifest.id);
      held = [
        ...held.filter((plugin) => plugin !== before),
        {
          accountId,
          manifest,
          hash,
          folder,
          handle,
          load: ++loads,
          enabled: true,
          ownParts: before?.ownParts ?? [],
          approved: { access: manifest.access, level: trustLevel(manifest) },
          access: before?.access ?? [],
          settings: before?.settings ?? {},
        },
      ];
    },
    async enable({ id }, on) {
      change(id, { enabled: on });
    },
    async setOwnParts({ id }, regions) {
      change(id, { ownParts: [...regions] });
    },
    async setAccess({ id }, scopes) {
      change(id, { access: [...scopes] });
    },
    async setSettings({ id }, settings) {
      change(id, { settings });
    },
    // Its on/off is this tab's already.
    async setOffHere() {},
    async remove({ id }) {
      const plugin = find(id);
      if (!plugin) return;
      held = held.filter((other) => other !== plugin);
      // Its build goes too; the server drops it in a week if this fails.
      await api.call(pluginRoutes.removeDevelopment, { params: { pluginId: id } }).catch(() => {});
    },
    development: {
      keepsFolder: keepsFolders(),
      async load(folder) {
        const { name, upload } = await readChosen(folder);
        const handle = 'handle' in folder ? folder.handle : null;
        return candidate({ upload, folder: name, handle }, find(upload.manifest.id));
      },
      async reload(id, folder) {
        const plugin = find(id);
        if (!plugin) throw new Error('Only a development plugin reloads.');
        const chosen = folder ?? (plugin.handle && { handle: plugin.handle });
        if (!chosen) throw new Error('Choose its folder again to reload it.');
        const { name, upload } = await readChosen(chosen);
        if (upload.manifest.id !== id)
          throw new Error(`That folder now holds ${upload.manifest.id}, not ${id}.`);
        const handle = 'handle' in chosen ? chosen.handle : plugin.handle;
        const next = { access: upload.manifest.access, level: trustLevel(upload.manifest) };
        if (asksMore(plugin.approved, next))
          return candidate({ upload, folder: name, handle }, plugin);
        // Sent even unchanged, so the server keeps it another week.
        await send(upload);
        change(id, {
          manifest: upload.manifest,
          hash: upload.hash,
          folder: name,
          handle,
          load: ++loads,
        });
        return null;
      },
    },
  };
}

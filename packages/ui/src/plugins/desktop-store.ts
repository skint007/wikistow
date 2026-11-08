import type { DesktopBridge } from '@wikistow/contracts';
import { vaultStore } from '../vault/store';
import { libraryStore, openApprovals } from './library';
import { inFrontOfLibrary, type AppPluginStore } from './store';

/**
 * The desktop's plugins: folder and development installs on this computer,
 * with their on/off kept there and their page access and settings kept
 * there per account (`plugins.json`), and, while the vault is open, the library
 * plugins the account approved (ADR 0002), which main downloads, checks
 * against their hashes and keeps copies of. Those keep their choices in
 * the account's contacts record, as in a browser, except off here (#312),
 * kept per account in `plugins.json`. A folder or development
 * install replaces the library's plugin of the same ID on this computer.
 */
export function desktopStore(bridge: DesktopBridge): AppPluginStore {
  const library = libraryStore(
    async (_ctx, approvals) => {
      const approved = approvals.map(({ id, hash, enabled }) => ({ id, hash, enabled }));
      // Asked even with none approved, so main deletes copies no longer approved.
      // Never anything but this computer's own plugins, whatever went wrong.
      const copies = await bridge
        .libraryPlugins(approved)
        .catch(() => ({ plugins: [], problems: {} }));
      return { plugins: copies.plugins, unavailable: copies.problems };
    },
    {
      get: ({ vault }) => bridge.pluginsOffHere(vault.accountId),
      set: ({ vault }, ids) => bridge.setPluginsOffHere(vault.accountId, [...ids]),
    },
  );
  const accountId = () => {
    const vault = vaultStore.get();
    return vault.status === 'unlocked' ? vault.vault.accountId : null;
  };

  return {
    async list() {
      const state = await bridge.plugins();
      const account = accountId();
      if (account === null)
        return { ...state, access: {}, settings: {}, offHere: [], unavailable: {} };
      const [held, access, settings] = await Promise.all([
        library.list(),
        bridge.pluginAccess(account).catch(() => ({})),
        bridge.pluginSettings(account).catch(() => ({})),
      ]);
      return {
        safeMode: state.safeMode,
        ...inFrontOfLibrary({ plugins: state.plugins, access, settings }, held),
      };
    },
    async approve(version) {
      if ('token' in version) await bridge.approvePlugin(version.token);
      else await library.approve(version);
    },
    async enable(plugin, on) {
      if (plugin.library) await library.enable(plugin, on);
      else await bridge.setPluginEnabled(plugin.id, on);
    },
    async setOwnParts(plugin, regions) {
      if (plugin.library) await library.setOwnParts(plugin, regions);
      else await bridge.setPluginOwnParts(plugin.id, [...regions]);
    },
    async setOffHere(plugin, off) {
      // A folder install's on/off is this computer's already.
      if (plugin.library) await library.setOffHere(plugin, off);
    },
    async setAccess(plugin, scopes) {
      if (plugin.library) return library.setAccess(plugin, scopes);
      const account = accountId();
      if (account !== null) await bridge.setPluginAccess(account, plugin.id, [...scopes]);
    },
    async setSettings(plugin, settings) {
      if (plugin.library) return library.setSettings(plugin, settings);
      const account = accountId();
      if (account !== null) await bridge.setPluginSettings(account, plugin.id, settings);
    },
    async remove(plugin) {
      if (plugin.library) await library.remove(plugin);
      else await bridge.removePlugin(plugin.id);
    },
    folders: {
      pick: (kind) => bridge.pickPlugin(kind),
      reload: (pluginId) => bridge.reloadPlugin(pluginId),
      files: (pluginId) => bridge.pluginUpload(pluginId),
    },
    development: null,
    approvals: openApprovals,
  };
}

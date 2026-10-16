import { pluginOperations } from '@wikistow/client';
import type { DesktopBridge, LibraryCopies } from '@wikistow/contracts';
import { vaultStore } from '../vault/store';
import { openCtx } from './library';
import type { RuntimeSource } from './runtime';

/**
 * The desktop's plugins: folder and development installs on this computer,
 * with their page access and on/off kept there, and, while the vault is
 * open, the library plugins the account approved (ADR 0002), which main
 * downloads, checks against their hashes and keeps copies of. Those keep
 * their access and on/off in the account's contacts record, as in a
 * browser. A folder or development install replaces the library's plugin
 * of the same ID on this computer.
 */
export function desktopSource(bridge: DesktopBridge): Omit<RuntimeSource, 'pages' | 'handle'> {
  /** The IDs installed from a folder here, as last listed: their choices stay on this computer. */
  let here = new Set<string>();
  /** Approved in the account's record and not replaced here, so their choices are kept there. */
  const inRecord = (pluginId: string) => {
    const vault = vaultStore.get();
    return (
      vault.status === 'unlocked' &&
      !here.has(pluginId) &&
      pluginOperations.listPluginApprovals(vault.ctx).some(({ id }) => id === pluginId)
    );
  };

  return {
    async list() {
      const state = await bridge.plugins();
      here = new Set(state.plugins.map(({ manifest }) => manifest.id));
      const vault = vaultStore.get();
      if (vault.status !== 'unlocked') return state;
      const approved = pluginOperations
        .listPluginApprovals(vault.ctx)
        .map(({ id, hash, enabled }) => ({ id, hash, enabled }));
      // Never anything but this computer's own plugins, whatever went wrong.
      const copies: LibraryCopies = await bridge
        .libraryPlugins(approved)
        .catch(() => ({ plugins: [], problems: {} }));
      const library = copies.plugins.filter(({ manifest }) => !here.has(manifest.id));
      return {
        safeMode: state.safeMode,
        plugins: [...state.plugins, ...library],
        unavailable: copies.problems,
      };
    },
    async access() {
      const vault = vaultStore.get();
      if (vault.status !== 'unlocked') return {};
      const folders = await bridge.pluginAccess(vault.vault.accountId);
      const approved = pluginOperations
        .listPluginApprovals(vault.ctx)
        .filter(({ id }) => !here.has(id))
        .map(({ id, access }) => [id, access] as const);
      return { ...folders, ...Object.fromEntries(approved) };
    },
    async setAccess(pluginId, scopes) {
      if (inRecord(pluginId)) {
        await pluginOperations.setPluginAccess(openCtx(), pluginId, scopes);
        return;
      }
      const vault = vaultStore.get();
      if (vault.status !== 'unlocked') return;
      await bridge.setPluginAccess(vault.vault.accountId, pluginId, scopes);
    },
    async disable(pluginId) {
      if (inRecord(pluginId)) await pluginOperations.setPluginEnabled(openCtx(), pluginId, false);
      else await bridge.setPluginEnabled(pluginId, false);
    },
    ownsStorage: true,
  };
}

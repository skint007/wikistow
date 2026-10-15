// The narrow bridge the app's pages get (`DesktopBridge`). Sandboxed, so it
// is bundled on its own as CommonJS and may only use `electron`.
import {
  DESKTOP_CHANNELS,
  type DesktopBridge,
  type DesktopResult,
} from '@wikistow/contracts/desktop-bridge';
import { contextBridge, ipcRenderer } from 'electron';

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as DesktopResult<T>;
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

const bridge: DesktopBridge = {
  server: () => call(DESKTOP_CHANNELS.server),
  signIn: (origin) => call(DESKTOP_CHANNELS.signIn, origin),
  cancelSignIn: () => call(DESKTOP_CHANNELS.cancelSignIn),
  signedOut: () => call(DESKTOP_CHANNELS.signedOut),
  secureStorage: () => call(DESKTOP_CHANNELS.secureStorage),
  rememberVault: (accountId, vaultKey) => call(DESKTOP_CHANNELS.rememberVault, accountId, vaultKey),
  rememberedVault: (accountId) => call(DESKTOP_CHANNELS.rememberedVault, accountId),
  forgetVault: () => call(DESKTOP_CHANNELS.forgetVault),
  searchIndex: () => call(DESKTOP_CHANNELS.searchIndex),
  keepSearchIndex: (sealed) => call(DESKTOP_CHANNELS.keepSearchIndex, sealed),
  trustMarks: () => call(DESKTOP_CHANNELS.trustMarks),
  keepTrustMarks: (sealed) => call(DESKTOP_CHANNELS.keepTrustMarks, sealed),
  plugins: () => call(DESKTOP_CHANNELS.plugins),
  pickPlugin: (kind) => call(DESKTOP_CHANNELS.pickPlugin, kind),
  approvePlugin: (token) => call(DESKTOP_CHANNELS.approvePlugin, token),
  setPluginEnabled: (id, enabled) => call(DESKTOP_CHANNELS.setPluginEnabled, id, enabled),
  reloadPlugin: (id) => call(DESKTOP_CHANNELS.reloadPlugin, id),
  removePlugin: (id) => call(DESKTOP_CHANNELS.removePlugin, id),
  pluginAccess: (accountId) => call(DESKTOP_CHANNELS.pluginAccess, accountId),
  setPluginAccess: (accountId, pluginId, scopes) =>
    call(DESKTOP_CHANNELS.setPluginAccess, accountId, pluginId, scopes),
  setSafeMode: (on) => call(DESKTOP_CHANNELS.setSafeMode, on),
  workshopStart: () => call(DESKTOP_CHANNELS.workshopStart),
  workshopEnd: (session) => call(DESKTOP_CHANNELS.workshopEnd, session),
  workshopFiles: (session) => call(DESKTOP_CHANNELS.workshopFiles, session),
  workshopRead: (session, path) => call(DESKTOP_CHANNELS.workshopRead, session, path),
  workshopWrite: (session, path, text) => call(DESKTOP_CHANNELS.workshopWrite, session, path, text),
  workshopDelete: (session, path) => call(DESKTOP_CHANNELS.workshopDelete, session, path),
  workshopBuild: (session) => call(DESKTOP_CHANNELS.workshopBuild, session),
  workshopCancel: (session) => call(DESKTOP_CHANNELS.workshopCancel, session),
  workshopExport: (session, version, hash) =>
    call(DESKTOP_CHANNELS.workshopExport, session, version, hash),
  workshopInstall: (session, version, hash) =>
    call(DESKTOP_CHANNELS.workshopInstall, session, version, hash),
  update: () => call(DESKTOP_CHANNELS.update),
};

contextBridge.exposeInMainWorld('wikistowDesktop', bridge);

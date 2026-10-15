import type { Manifest, PageAccess, TrustLevel } from '@wikistow/plugin-sdk/manifest';

/** A space, or a folder and what is under it, that a plugin may read or write for one account. */
export type PluginScope = { spaceId: string; folderId: string | null; access: 'read' | 'write' };

/** A plugin installed on this computer, or loaded from a development folder. */
export type InstalledPlugin = {
  manifest: Manifest;
  level: TrustLevel;
  /** The path segment its files are served under, which changes with each version or reload. */
  key: string;
  /** The folder a development plugin is read from, or null once installed. */
  development: string | null;
  enabled: boolean;
};

/** A plugin folder read and checked, waiting for the person to approve it. */
export type PluginCandidate = {
  token: string;
  manifest: Manifest;
  level: TrustLevel;
  development: string | null;
  /** SHA-256 of an install's files, which approval binds to; null for a development folder. */
  hash: string | null;
  /** What it replaces: another version, or the same development folder asking for more. */
  replaces: { version: string; level: TrustLevel; access: PageAccess } | null;
};

export type PluginsState = {
  /** Started with no plugins (Ctrl+Shift+Alt+P, `--safe-mode`, or after a crash). */
  safeMode: boolean;
  plugins: InstalledPlugin[];
};

/** A problem a workshop build found, and where, when it knows. */
export type BuildDiagnostic = {
  severity: 'error' | 'warning';
  file: string | null;
  line: number | null;
  column: number | null;
  message: string;
};

/** A file in a workshop's workspace: its path from the top, with `/` between names. */
export type WorkshopFile = { path: string; size: number };

/** One build of a workshop's workspace, numbered from 1 in its session, failed builds included. */
export type WorkshopVersion = {
  version: number;
  /** Errors, and warnings for a build that worked. */
  diagnostics: BuildDiagnostic[];
  /**
   * The built plugin, served at a key of its own (`workshop-<session>-<version>`)
   * for the preview; null when the build failed.
   */
  plugin: InstalledPlugin | null;
  /** SHA-256 of the built folder as an install hashes it, or null when the build failed. */
  hash: string | null;
};

/** A stable release newer than the desktop app running, and how this copy is updated (#12). */
export type DesktopUpdate = {
  /** The app's own version, as `0.3.0`. */
  installed: string;
  /** The newest stable release, as `0.4.0`. */
  version: string;
  /** Its release page, with the notes and the downloads. */
  url: string;
  /** How this copy was installed (`install-source`), or null when the app can't tell. */
  source: 'aur' | 'deb' | 'rpm' | null;
};

/**
 * What the desktop app's preload script gives its pages, as
 * `window.wikistowDesktop`. The browser has none. Every call crosses into the
 * app's main process, which checks what it is given again. The session itself
 * never crosses: the main process adds it to the pages' API requests.
 */
export type DesktopBridge = {
  /** The server this app signs in to, once one was chosen. */
  server(): Promise<string | null>;
  /**
   * Sign in through the system browser to the server at `origin` (`https:`,
   * or `http:` on this computer). Settles once the browser has handed the
   * app a session; fails with a message to show otherwise.
   */
  signIn(origin: string): Promise<void>;
  /** Stop waiting for the browser; a link that comes back later is ignored. */
  cancelSignIn(): Promise<void>;
  /** Tell the app its person signed out, once the server ended the session. It forgets the unlock too. */
  signedOut(): Promise<void>;
  /**
   * Whether this computer has a secret store the app trusts (GNOME Keyring
   * or KWallet). Only then does it keep the session between launches, or
   * offer to remember the vault's unlock.
   */
  secureStorage(): Promise<boolean>;
  /** Unlock this account's vault at every launch, until a lock or sign-out. */
  rememberVault(accountId: string, vaultKey: Uint8Array): Promise<void>;
  /** The vault key remembered for this account, if any. */
  rememberedVault(accountId: string): Promise<Uint8Array | null>;
  /** Stop unlocking the vault at launch. */
  forgetVault(): Promise<void>;
  /**
   * The search index kept from an earlier launch, as the pages sealed it
   * (`sealKept`), or null. Kept only with a trusted secret store, and
   * deleted at sign-out and at a new sign-in.
   */
  searchIndex(): Promise<Uint8Array | null>;
  /** Keep this sealed search index, in place of the one kept. */
  keepSearchIndex(sealed: Uint8Array): Promise<void>;
  /** The plugins on this computer, and whether safe mode is on. */
  plugins(): Promise<PluginsState>;
  /**
   * Choose a built plugin folder to install, or to load for development,
   * and read it. Null if the person cancelled; fails with a message if the
   * folder isn't a plugin. Nothing runs until `approvePlugin`.
   */
  pickPlugin(kind: 'install' | 'development'): Promise<PluginCandidate | null>;
  /** Install or update the candidate the person approved, enabled. */
  approvePlugin(token: string): Promise<void>;
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  /**
   * Read a development plugin's folder again. Null when it reloaded; a
   * candidate when it asks for more than was approved.
   */
  reloadPlugin(id: string): Promise<PluginCandidate | null>;
  /** Uninstall: its files and every account's access settings for it go. */
  removePlugin(id: string): Promise<void>;
  /** Each plugin's page access for this account. */
  pluginAccess(accountId: string): Promise<Record<string, PluginScope[]>>;
  setPluginAccess(accountId: string, pluginId: string, scopes: PluginScope[]): Promise<void>;
  /** Turn safe mode on or off; the window reloads. */
  setSafeMode(on: boolean): Promise<void>;
  /** Start a plugin workshop (#257): an empty workspace of its own. Its ID names it from then on. */
  workshopStart(): Promise<string>;
  /** End a workshop: its workspace and every version built in it are deleted. */
  workshopEnd(session: string): Promise<void>;
  workshopFiles(session: string): Promise<WorkshopFile[]>;
  workshopRead(session: string, path: string): Promise<string>;
  /** Create or replace a text file in the workspace. Paths outside it, or of other kinds, fail. */
  workshopWrite(session: string, path: string, text: string): Promise<void>;
  workshopDelete(session: string, path: string): Promise<void>;
  /** Build the workspace as it is now into its next version. Null if it was cancelled meanwhile. */
  workshopBuild(session: string): Promise<WorkshopVersion | null>;
  /** Drop the build running now, if any: it makes no version. */
  workshopCancel(session: string): Promise<void>;
  /**
   * Copy version `version` into a new folder the person chooses, if its files
   * still hash to `hash`. The folder written, or null if the person cancelled.
   */
  workshopExport(session: string, version: number, hash: string): Promise<string | null>;
  /**
   * Install version `version` through the usual approval, if its files still
   * hash to `hash`: a candidate for `approvePlugin`, with that same hash.
   */
  workshopInstall(session: string, version: number, hash: string): Promise<PluginCandidate>;
  /**
   * A newer stable release, if the last check found one; null otherwise,
   * offline and before any check worked. The app checks GitHub itself.
   */
  update(): Promise<DesktopUpdate | null>;
};

/** The IPC channels behind `DesktopBridge`, one per method. */
export const DESKTOP_CHANNELS = {
  server: 'wikistow:server',
  signIn: 'wikistow:sign-in',
  cancelSignIn: 'wikistow:cancel-sign-in',
  signedOut: 'wikistow:signed-out',
  secureStorage: 'wikistow:secure-storage',
  rememberVault: 'wikistow:remember-vault',
  rememberedVault: 'wikistow:remembered-vault',
  forgetVault: 'wikistow:forget-vault',
  searchIndex: 'wikistow:search-index',
  keepSearchIndex: 'wikistow:keep-search-index',
  plugins: 'wikistow:plugins',
  pickPlugin: 'wikistow:pick-plugin',
  approvePlugin: 'wikistow:approve-plugin',
  setPluginEnabled: 'wikistow:set-plugin-enabled',
  reloadPlugin: 'wikistow:reload-plugin',
  removePlugin: 'wikistow:remove-plugin',
  pluginAccess: 'wikistow:plugin-access',
  setPluginAccess: 'wikistow:set-plugin-access',
  setSafeMode: 'wikistow:set-safe-mode',
  workshopStart: 'wikistow:workshop-start',
  workshopEnd: 'wikistow:workshop-end',
  workshopFiles: 'wikistow:workshop-files',
  workshopRead: 'wikistow:workshop-read',
  workshopWrite: 'wikistow:workshop-write',
  workshopDelete: 'wikistow:workshop-delete',
  workshopBuild: 'wikistow:workshop-build',
  workshopCancel: 'wikistow:workshop-cancel',
  workshopExport: 'wikistow:workshop-export',
  workshopInstall: 'wikistow:workshop-install',
  update: 'wikistow:update',
} as const satisfies Record<keyof DesktopBridge, string>;

/** What a channel answers: the value, or the message for a failure. */
export type DesktopResult<T> = { ok: true; value: T } | { ok: false; message: string };

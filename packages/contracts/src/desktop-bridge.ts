import type { Settings } from '@wikistow/plugin-sdk';
import type { Manifest, PageAccess, TrustLevel } from '@wikistow/plugin-sdk/manifest';
// Types only: the preload bundles this file and may load nothing but electron.
// The package's index exports `PluginScope`.
import type { PluginScope } from './plugin-installs.ts';
import type { FolderId, PageId, SpaceId } from './records/ids.ts';

/**
 * A plugin installed on this computer or loaded from a development folder,
 * or one approved from the server's library.
 */
export type InstalledPlugin = {
  manifest: Manifest;
  level: TrustLevel;
  /** The path segment its files are served under, which changes with each version or reload. */
  key: string;
  /** The folder a development plugin is read from, or null once installed. */
  development: string | null;
  /**
   * From the server's library (ADR 0002): approved in the account's contacts
   * record, where its on/off and page access are kept too. False for a
   * folder or development install, whose choices stay on this computer.
   */
  library: boolean;
  /**
   * Whether it runs here: for a library plugin, on for the account and not
   * turned off on this device (#312).
   */
  enabled: boolean;
  /**
   * The regions where the person chose the app's own part over this
   * plugin's (ADR 0011, Settings' **Use the app's own**), kept where its
   * on/off is.
   */
  ownParts: readonly string[];
};

/** A library plugin approved in the account's contacts record, for the desktop to hold a copy of. */
export type LibraryApproval = { id: string; hash: string; enabled: boolean };

/** The approved library plugins this computer holds, each checked against its hash. */
export type LibraryCopies = {
  plugins: InstalledPlugin[];
  /** Approved plugins it couldn't install, by ID, with why. */
  problems: Record<string, string>;
};

/** A built plugin's file, to share to the library or preview: its path from the folder's top, and its bytes. */
export type PluginUploadFile = { path: string; data: Uint8Array };

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

/**
 * A file in a workshop's plugin draft: its path from the top, with `/`
 * between names, its size, and `binary` for a font or image.
 */
export type WorkshopFile = { path: string; size: number; binary?: true };

/** One build of a workshop's plugin draft, numbered from 1 in its conversation, failed builds included. */
export type WorkshopVersion = {
  version: number;
  /** Errors, and warnings for a build that worked. */
  diagnostics: BuildDiagnostic[];
  /**
   * The built plugin, served for the preview under `draft-<hash>` (ADR 0004);
   * null when the build failed.
   */
  plugin: InstalledPlugin | null;
  /** SHA-256 of the built folder as an install hashes it, or null when the build failed. */
  hash: string | null;
};

/** A stable release newer than the desktop app running, and how this copy is updated (#12). */
export type DesktopUpdate = {
  /** The app's own version, as `0.3.0`. */
  installed: string;
  /** The newest release on this copy's channel, as `0.4.0` (stable) or `0.5.0-beta.1` (beta). */
  version: string;
  /** Its release page, with the notes and the downloads; for a Windows install, its installer. */
  url: string;
  /**
   * How this copy was installed (`install-source`), or null when the app
   * can't tell: `apt` and `dnf` are a .deb or .rpm with WikiStow's
   * repository added.
   */
  source: 'aur' | 'apt' | 'deb' | 'dnf' | 'rpm' | 'windows' | 'mac' | null;
};

/**
 * Where the pages keep items for offline use (ADR 0009): `kept` for pages,
 * trees and images, `queue` for changes made offline, both sealed, and
 * `unlock` for what unlocking offline reads before the vault opens (the
 * last `/api/me` answer, the vault wrapper and the installation ID), which
 * isn't.
 */
export type KeptFolder = 'kept' | 'queue' | 'unlock';
export const KEPT_FOLDERS = ['kept', 'queue', 'unlock'] as const satisfies readonly KeptFolder[];

/**
 * A kept item's name: base64url (`deviceTag`), so no name leaves its folder.
 * The desktop app's main process refuses any other.
 */
export const KEPT_ITEM_NAME = /^[\w-]{1,64}$/;

/** A kept item as listed: its name, and its size in bytes. */
export type KeptItem = { name: string; size: number };

/**
 * The account everything kept belongs to, kept unsealed so the app can tell
 * whose it is before anyone unlocks (ADR 0009, decision 2).
 */
export type KeptAccount = { id: string; name: string };

/** Whether the desktop window fills the screen, for its titlebar's buttons (#74). */
export type WindowState = { maximized: boolean; fullScreen: boolean };

/** A browser the web clipper's host manifests are written for (ADR 0017, decision 2). */
export type ClipBrowser = 'chrome' | 'chromium' | 'edge' | 'brave' | 'firefox';

/** **Settings → Browser clipping** on this computer (ADR 0017). */
export type ClippingState = {
  /** The person's choice; it starts on. */
  on: boolean;
  /**
   * Why browsers can't reach the app although it's on, or null: a Mac app
   * run from where it was unzipped (`translocated`), a development build
   * started without `--clip-manifests` or a copy with no helper
   * (`development`), or the socket
   * couldn't be opened (`unavailable`).
   */
  problem: 'translocated' | 'development' | 'unavailable' | null;
  /** The browsers whose manifests name this app, found on this computer. */
  browsers: ClipBrowser[];
  /** This session's last ten clips saved, newest first, from memory only (ADR 0017, decision 3). */
  recent: ClippedPage[];
};

/** A clip saved this session, as Settings → Browser clipping lists it. */
export type ClippedPage = {
  spaceId: SpaceId;
  pageId: PageId;
  title: string;
  /** The folder's path, as the person sees it. */
  path: string;
};

/** What a clip captured (ADR 0017, decision 5). Screenshots come later (step 6). */
export type ClipMode = 'link' | 'selection' | 'article' | 'page';

/**
 * A clip from the browser extension, as main hands it to the page to save
 * (ADR 0017, decisions 4 and 5). Main checked its fields' sizes; the page
 * makes it a draft. Its ID is main's own, not the extension's.
 */
export type DesktopClip = {
  id: string;
  mode: ClipMode;
  /** The tab's address, as the extension sent it: `http:` and `https:` are linked, others go in as text. */
  url: string;
  /** The title the person gave it, possibly blank. */
  title: string;
  /** The person's note, plain text. */
  note: string;
  tags: string[];
  /** The clip's HTML, with every address absolute; empty for a link. */
  html: string;
  /** Its plain text: a link's selection, or the HTML's text, for when the HTML gives nothing. */
  text: string;
  /** An article's byline, the page's `author`. */
  byline: string | null;
  /** Where it goes: a folder, or the top of a space for a null `folderId`. */
  folder: { spaceId: SpaceId; folderId: FolderId | null };
  /** It came while the app was starting or locked, so its answer may reach no popup. */
  waited: boolean;
};

/** How saving a clip went, as the page tells main, which tells the extension. */
export type ClipOutcome =
  | {
      ok: true;
      spaceId: SpaceId;
      pageId: PageId;
      title: string;
      path: string;
      images: { saved: number; skipped: number };
      /** False when the Markdown reads back otherwise than the clip's HTML showed (`htmlMarkdown`). */
      faithful: boolean;
    }
  | {
      ok: false;
      code: 'too-large' | 'no-folder' | 'not-allowed' | 'failed';
      message: string;
    };

/** A place a clip can go, as the folder search answers it. */
export type ClipFolder = { spaceId: SpaceId; folderId: FolderId | null; path: string };

/** The folder search's answer: the five places clips went last, and what matches. */
export type ClipFolders = { recent: ClipFolder[]; matches: ClipFolder[] };

/** What main asks of the page for the extension (`onClipRequest`). */
export type ClipRequest =
  | { kind: 'clip'; clip: DesktopClip }
  /** Answer with `clipFolders`, under `id`. */
  | { kind: 'folders'; id: string; query: string }
  /** Open the draft a clip made this session. */
  | { kind: 'show'; spaceId: SpaceId; pageId: PageId };

/** The vault's state as the page tells main, for the extension (ADR 0017, decision 7). */
export type ClipPageState = { vault: 'locked' | 'unlocked'; offline: boolean };

/** An image of a clip, as main fetched it (ADR 0017, decision 5). */
export type ClipImage =
  | { ok: true; bytes: Uint8Array; mediaType: string }
  | {
      ok: false;
      /**
       * `refused`: not an address main fetches (a local one, another
       * scheme); `not-image`; `too-large`; `limit`: past the clip's
       * images, or the minute's; `failed`: anything else.
       */
      reason: 'refused' | 'not-image' | 'too-large' | 'limit' | 'failed';
    };

/**
 * What the titlebar asks of the window. `toggle-maximize` leaves full screen
 * first; `close` closes as the window manager's close does, so changes still
 * to save ask first.
 */
export const WINDOW_ACTIONS = [
  'minimize',
  'toggle-maximize',
  'close',
  'reload',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'toggle-full-screen',
  'toggle-developer-tools',
] as const;
export type WindowAction = (typeof WINDOW_ACTIONS)[number];

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
   * Sign out on this computer only, for a server that no longer answers as
   * WikiStow (#257): forget the session, the unlock, everything kept and the
   * server chosen, so sign-in asks for one. The server isn't asked, so its
   * session stays alive until it expires or is signed out from elsewhere.
   */
  signOutHere(): Promise<void>;
  /**
   * Whether this computer has a secret store the app trusts (GNOME Keyring
   * or KWallet on Linux, DPAPI on Windows, the Keychain on macOS). Only then
   * does it keep the session between launches, or offer to remember the
   * vault's unlock.
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
  /** Delete the search index kept, as with **Pages I open** nothing keeps it (ADR 0009, decision 9). */
  dropSearchIndex(): Promise<void>;
  /**
   * The contacts and No going back marks kept from an earlier launch, as the
   * pages sealed them (`KeptMarks`), or null. Kept and deleted as the search
   * index is.
   */
  trustMarks(): Promise<Uint8Array | null>;
  /** Keep these sealed marks, in place of the ones kept. */
  keepTrustMarks(sealed: Uint8Array): Promise<void>;
  /**
   * The items kept in `folder` (ADR 0009). The `kept` and `unlock` folders
   * hold items only with a trusted secret store, and list none without; the
   * `queue` folder holds them either way.
   */
  keptItems(folder: KeptFolder): Promise<KeptItem[]>;
  /** The sealed item `name` in `folder`, or null if there is none. */
  keptItem(folder: KeptFolder, name: string): Promise<Uint8Array | null>;
  /** Keep a sealed item as `name` in `folder`, in place of any kept so. */
  keepItem(folder: KeptFolder, name: string, sealed: Uint8Array): Promise<void>;
  /** Delete the items `names` from `folder`. */
  dropKeptItems(folder: KeptFolder, names: string[]): Promise<void>;
  /** The account the kept items belong to, or null. */
  keptAccount(): Promise<KeptAccount | null>;
  keepKeptAccount(account: KeptAccount): Promise<void>;
  /** Delete everything kept for offline: every folder and the account. */
  clearKept(): Promise<void>;
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
  /** The regions where a folder install gives way to the app's own part (`InstalledPlugin.ownParts`). */
  setPluginOwnParts(id: string, regions: string[]): Promise<void>;
  /**
   * Read a development plugin's folder again. Null when it reloaded; a
   * candidate when it asks for more than was approved.
   */
  reloadPlugin(id: string): Promise<PluginCandidate | null>;
  /** Uninstall: its files and every account's access and settings for it go. */
  removePlugin(id: string): Promise<void>;
  /** Each plugin's page access for this account. */
  pluginAccess(accountId: string): Promise<Record<string, PluginScope[]>>;
  setPluginAccess(accountId: string, pluginId: string, scopes: PluginScope[]): Promise<void>;
  /** Each folder or development install's settings for this account (`host.settings`), where it has any. */
  pluginSettings(accountId: string): Promise<Record<string, Settings>>;
  setPluginSettings(accountId: string, pluginId: string, settings: Settings): Promise<void>;
  /** The library plugins this account turned off on this computer only (#312), by ID. */
  pluginsOffHere(accountId: string): Promise<string[]>;
  setPluginsOffHere(accountId: string, pluginIds: string[]): Promise<void>;
  /**
   * Hold a copy of each library plugin the account approved (ADR 0002):
   * those this computer lacks are downloaded through the app's session,
   * every file is checked against the approved hash, and the copy goes
   * into the app's data, as a folder install's does. Copies no longer
   * approved are deleted. Served under `/plugins/<id>/<hash>/` while the
   * last call names them enabled.
   */
  libraryPlugins(approved: LibraryApproval[]): Promise<LibraryCopies>;
  /**
   * An installed plugin's files, to share to the library. Fails, naming the
   * file, if a path is one the library refuses, or past its limits.
   */
  pluginUpload(id: string): Promise<PluginUploadFile[]>;
  /** Turn safe mode on or off; the window reloads. */
  setSafeMode(on: boolean): Promise<void>;
  /**
   * Serve a plugin workshop build the page made (ADR 0004) for its preview,
   * under `/plugins/<id>/draft-<hash>/`, until the window navigates. Checked
   * as the library checks an upload. Answers its hash, which must be the
   * page's own.
   */
  workshopPreview(files: PluginUploadFile[]): Promise<string>;
  /**
   * Write a workshop build into a new folder, `<id>-<first 8 of the hash>`,
   * in one the person chooses, if its files hash to `hash`. The folder
   * written, or null if the person cancelled.
   */
  workshopExport(files: PluginUploadFile[], hash: string): Promise<string | null>;
  /**
   * A newer stable release, if the last check found one; null otherwise,
   * offline and before any check worked. The app checks GitHub itself.
   */
  update(): Promise<DesktopUpdate | null>;
  /** Do what the titlebar's button or menu item asks of the window. */
  windowAction(action: WindowAction): Promise<void>;
  windowState(): Promise<WindowState>;
  /**
   * Hear of each change to `windowState`, as the window is maximized,
   * restored or put in full screen, however that happened. The returned
   * function stops it. One of the two calls main makes to the page, not the other way.
   */
  onWindowState(listener: (state: WindowState) => void): () => void;
  /**
   * Hear each Find… picked from a Mac's Edit menu, which opens Find on page
   * (#276). Cmd+F itself goes to the page first. The returned function stops it.
   */
  onFind(listener: () => void): () => void;
  /** Browser clipping on this computer: whether it's on, and which browsers can reach the app. */
  clipping(): Promise<ClippingState>;
  /**
   * Turn browser clipping on or off on this computer. Off closes the
   * socket and deletes the host manifests (and on Windows their keys); on
   * writes them again.
   */
  setClipping(on: boolean): Promise<ClippingState>;
  /** Tell main the vault's state, which the extension hears as `locked` or `ready`. */
  setClipState(state: ClipPageState): Promise<void>;
  /**
   * Hear what main asks of the page for the extension: a clip to save, a
   * folder search, or a draft to show. The returned function stops it. A
   * clip that came before anyone heard is in `waitingClips`.
   */
  onClipRequest(listener: (request: ClipRequest) => void): () => void;
  /** The clips main holds that no `clipDone` answered yet, oldest first, as after a reload. */
  waitingClips(): Promise<DesktopClip[]>;
  /** Say how saving the clip `clipId` went; main lets it go. */
  clipDone(clipId: string, outcome: ClipOutcome): Promise<void>;
  /** Answer the folder search `requestId`: null while the vault is locked. */
  clipFolders(requestId: string, folders: ClipFolders | null): Promise<void>;
  /**
   * Fetch an image the clip `clipId` names, `http:`, `https:` or `data:`:
   * without cookies, never from the local network unless the clipped page
   * is on it, within the clip's limits.
   */
  clipImage(clipId: string, url: string): Promise<ClipImage>;
};

/** The IPC channels behind `DesktopBridge`, one per method. */
export const DESKTOP_CHANNELS = {
  server: 'wikistow:server',
  signIn: 'wikistow:sign-in',
  cancelSignIn: 'wikistow:cancel-sign-in',
  signedOut: 'wikistow:signed-out',
  signOutHere: 'wikistow:sign-out-here',
  secureStorage: 'wikistow:secure-storage',
  rememberVault: 'wikistow:remember-vault',
  rememberedVault: 'wikistow:remembered-vault',
  forgetVault: 'wikistow:forget-vault',
  searchIndex: 'wikistow:search-index',
  keepSearchIndex: 'wikistow:keep-search-index',
  dropSearchIndex: 'wikistow:drop-search-index',
  trustMarks: 'wikistow:trust-marks',
  keepTrustMarks: 'wikistow:keep-trust-marks',
  keptItems: 'wikistow:kept-items',
  keptItem: 'wikistow:kept-item',
  keepItem: 'wikistow:keep-item',
  dropKeptItems: 'wikistow:drop-kept-items',
  keptAccount: 'wikistow:kept-account',
  keepKeptAccount: 'wikistow:keep-kept-account',
  clearKept: 'wikistow:clear-kept',
  plugins: 'wikistow:plugins',
  pickPlugin: 'wikistow:pick-plugin',
  approvePlugin: 'wikistow:approve-plugin',
  setPluginEnabled: 'wikistow:set-plugin-enabled',
  setPluginOwnParts: 'wikistow:set-plugin-own-parts',
  reloadPlugin: 'wikistow:reload-plugin',
  removePlugin: 'wikistow:remove-plugin',
  pluginAccess: 'wikistow:plugin-access',
  setPluginAccess: 'wikistow:set-plugin-access',
  pluginSettings: 'wikistow:plugin-settings',
  setPluginSettings: 'wikistow:set-plugin-settings',
  pluginsOffHere: 'wikistow:plugins-off-here',
  setPluginsOffHere: 'wikistow:set-plugins-off-here',
  libraryPlugins: 'wikistow:library-plugins',
  pluginUpload: 'wikistow:plugin-upload',
  setSafeMode: 'wikistow:set-safe-mode',
  workshopPreview: 'wikistow:workshop-preview',
  workshopExport: 'wikistow:workshop-export',
  update: 'wikistow:update',
  windowAction: 'wikistow:window-action',
  windowState: 'wikistow:window-state',
  onWindowState: 'wikistow:window-state-changed',
  onFind: 'wikistow:find',
  clipping: 'wikistow:clipping',
  setClipping: 'wikistow:set-clipping',
  setClipState: 'wikistow:set-clip-state',
  onClipRequest: 'wikistow:clip-request',
  waitingClips: 'wikistow:waiting-clips',
  clipDone: 'wikistow:clip-done',
  clipFolders: 'wikistow:clip-folders',
  clipImage: 'wikistow:clip-image',
} as const satisfies Record<keyof DesktopBridge, string>;

/** What a channel answers: the value, or the message for a failure. */
export type DesktopResult<T> = { ok: true; value: T } | { ok: false; message: string };

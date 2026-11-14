// The desktop app's main process. It serves the built web app from
// `app://wikistow`, forwards that origin's API requests to the server with
// the session only it holds, signs in through the system browser, keeps
// and serves the plugins installed on this computer and copies of those
// approved from the server's library, serves the builds the plugin
// workshop previews, checks for a newer release, and opens its window where
// it was last left. The window has no system frame: the pages draw its
// titlebar, and main answers the old menu's shortcuts. A Mac keeps its menu
// bar (mac-menu.ts) and the system's window buttons.
import {
  DESKTOP_CHANNELS,
  KEPT_FOLDERS,
  KEPT_ITEM_NAME,
  SECURITY_HEADERS,
  securityHeadersFor,
  WINDOW_ACTIONS,
  type DesktopBridge,
  type DesktopResult,
  type WindowAction,
  type WindowState,
} from '@wikistow/contracts';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { APP_ORIGIN, appFile } from './app-files.ts';
import { desktopClipping } from './clip/clipping.ts';
import { contextMenu } from './context-menu.ts';
import { APP_NAMES, desktopApp, windowIcon } from './install.ts';
import { cookieChange, forward } from './forward.ts';
import { keptFile, keptFolder } from './kept-file.ts';
import { PluginFolderError } from './plugins/folder.ts';
import { macMenu, type MenuAction } from './mac-menu.ts';
import { libraryPlugins } from './plugins/library.ts';
import { desktopPlugins, pluginAddress } from './plugins/plugins.ts';
import { sealedByKeyring, secretFile, type Cipher, type Secrets } from './secrets.ts';
import { shortcut } from './shortcuts.ts';
import {
  checkServer,
  handoffCode,
  linkArgument,
  newVerifier,
  redeem,
  serverOrigin,
  signOutSession,
  SignInError,
} from './sign-in.ts';
import { desktopUpdates } from './updates.ts';
import { windowPlace } from './window-place.ts';
import { desktopWorkshop, WorkshopError } from './workshop/workshop.ts';

/** How long a browser sign-in may take before the app stops waiting for it. */
const SIGN_IN_MS = 10 * 60_000;
/** How long quitting waits for the server to end a session nothing kept. */
const QUIT_SIGN_OUT_MS = 3_000;
/** How long one request downloading a library plugin may take. */
const LIBRARY_REQUEST_MS = 60_000;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

// The stable app, or the AUR's beta installed beside it under names of its
// own (install.ts).
const which = desktopApp(app.getAppPath());
const names = APP_NAMES[which];
// The name also keys the keyring: the beta's key is `WikiStow Beta Safe Storage`.
app.setName(names.name);

// The launcher entry the Linux desktop shows for these windows, which also
// claims `wikistow://` links, or the beta's `wikistow-beta://` ones
// (packaging/wikistow-desktop.desktop, wikistow-desktop-beta.desktop). Its
// name is the windows' class too.
if (process.platform === 'linux') app.setDesktopName(names.entry);

// On Windows the app's data would be %APPDATA%\WikiStow, which is the CLI's
// %APPDATA%\wikistow as Windows ignores case, so it gets a folder of its own.
// The beta keeps its own data, apart from the stable app's, and so its own
// single-instance lock. Set before anything reads it, the lock included.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  if (which === 'beta') app.setPath('userData', join(app.getPath('appData'), names.name));
  else if (process.platform === 'win32') {
    app.setPath('userData', join(app.getPath('appData'), 'WikiStow Desktop'));
  }
}

// A second launch, such as the browser opening a `wikistow://` link, hands
// its arguments to this one and quits.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();

const mac = process.platform === 'darwin';

// The web build sits inside the packed app (`scripts/asar.ts`), or beside it
// in the workspace. It is looked for rather than read off `app.isPackaged`,
// which depends on how Electron was started.
const packedWeb = join(app.getAppPath(), 'web');
const webDist = existsSync(join(packedWeb, 'index.html'))
  ? packedWeb
  : join(app.getAppPath(), '..', 'web', 'dist');
const configFile = () => join(app.getPath('userData'), 'config.json');
const Config = z.object({ server: z.string().nullable() });

/** The server chosen at the last sign-in. Not a secret. */
let server: string | null = null;
/** The server's cookies, the session among them (`Upstream`). Only ever in this process. */
let cookie: string | null = null;
/** The remembered vault key, if the person asked for one (`rememberVault`). */
let vault: Secrets['vault'] = null;
/** Where the cookies and the vault key are kept between launches, sealed by a trusted store. */
let store: ReturnType<typeof secretFile> | null = null;
let writing: Promise<void> = Promise.resolve();
/** Writes queued or running, which quitting waits for. */
let unwritten = 0;
/** The session quitting is ending on the server, which quitting also waits for. */
let signingOut: Promise<void> | null = null;

/**
 * Keep the latest cookies and unlock, one write at a time. It never fails:
 * when a write does, the file goes, so the app forgets rather than keeps.
 */
function persist(): Promise<void> {
  unwritten += 1;
  writing = writing
    .then(() => store?.write({ origin: server, cookie, vault }))
    .catch(() => store?.clear())
    .catch(() => {})
    .finally(() => {
      unwritten -= 1;
    });
  return writing;
}

/** Drop the remembered vault key, overwriting the copy held here. */
function forget() {
  vault?.key.fill(0);
  vault = null;
}
/** The sign-in waiting for its link back from the browser. */
let pending: {
  origin: string;
  verifier: string;
  /** A link being redeemed now; others are ignored until it settles. */
  redeeming: boolean;
  done: (result: DesktopResult<void>) => void;
} | null = null;
/** Counts sign-ins started and cancelled, so a slow check can tell it was overtaken. */
let signInRun = 0;
let window: BrowserWindow | null = null;
const plugins = desktopPlugins(app.getPath('userData'));
// Library plugins download through the session, each request given a minute.
const library = libraryPlugins(app.getPath('userData'), (path) =>
  toServer(new Request(`${APP_ORIGIN}${path}`), (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(LIBRARY_REQUEST_MS) }),
  ),
);
const workshop = desktopWorkshop(app.getPath('userData'));
const updates = desktopUpdates(app.getPath('userData'), app.getVersion(), app.getAppPath());
const searchIndex = keptFile(join(app.getPath('userData'), 'search-index'));
const trustMarks = keptFile(join(app.getPath('userData'), 'trust-marks'));
// What the pages keep for offline use (ADR 0009): pages, trees and images
// in `kept`, changes made offline in `queue`, what unlocking offline reads
// in `unlock`, and whose they are.
const keptFolders = {
  kept: keptFolder(join(app.getPath('userData'), 'kept')),
  queue: keptFolder(join(app.getPath('userData'), 'queue')),
  unlock: keptFolder(join(app.getPath('userData'), 'unlock')),
};
const keptAccountFile = keptFile(join(app.getPath('userData'), 'kept-account'));
const place = windowPlace(app.getPath('userData'));
// The web clipper's socket and host manifests, and its clips (ADR 0017).
// Main knows whether the page has loaded and whether there is a session;
// the page tells it the vault's state (`setClipState`).
const clipping = desktopClipping({
  which,
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  home: app.getPath('home'),
  userData: app.getPath('userData'),
  ownDataFolder: app.commandLine.hasSwitch('user-data-dir'),
  appPath: app.getAppPath(),
  execPath: process.execPath,
  version: app.getVersion(),
  argv: process.argv,
  // Signed out is known before the window loads: the session is read first.
  session: () =>
    !(server && cookie)
      ? 'signed-out'
      : !window || window.webContents.isLoading()
        ? 'starting'
        : 'signed-in',
  show: () => bringForward(),
  userAgent: app.userAgentFallback,
});

/**
 * Delete the search index and the trust marks the pages kept sealed, as
 * at every new sign-in. Pages kept for offline stay: the pages delete them
 * once the server names another account (ADR 0009, decision 10).
 */
async function removeSignInKept() {
  await Promise.all([searchIndex.remove(), trustMarks.remove()]).catch(() => {});
}

/**
 * Delete what the pages kept that needs a trusted keyring: the search
 * index, the trust marks, the pages kept for offline and what unlocking
 * offline reads. Changes made offline, and whose they are, stay: they are
 * kept with or without a keyring, and are never lost to one that didn't open.
 */
async function removeKept() {
  await Promise.all([
    removeSignInKept(),
    keptFolders.kept.clear(),
    keptFolders.unlock.clear(),
  ]).catch(() => {});
}

/** Delete everything the pages kept, as signing out does. */
async function removeAllKept() {
  await Promise.all([removeKept(), keptFolders.queue.clear(), keptAccountFile.remove()]).catch(
    () => {},
  );
}

/**
 * No plugins load: asked for with `--safe-mode` or Ctrl+Shift+Alt+P, or
 * after the window crashed with plugins on. Until the person turns them
 * back on, or the app restarts.
 */
let safeMode = process.argv.includes('--safe-mode');

/** A plugin file's response is refused everything a response's policy governs, as the server's library route does. */
const PLUGIN_FILE_CSP = "default-src 'none'";

// A missing or damaged file means no server chosen yet, never a dead app.
async function loadConfig() {
  try {
    const stored = Config.parse(JSON.parse(await readFile(configFile(), 'utf8')));
    server = serverOrigin(stored.server ?? '');
  } catch {
    server = null;
  }
}

// Written whole, then moved into place, so a crash never leaves half a file.
async function saveConfig() {
  const next = `${configFile()}.next`;
  await writeFile(next, JSON.stringify({ server }), { mode: 0o600 });
  await rename(next, configFile());
}

// The server's answer to signing out already cleared the session cookie;
// its other cookies stay, as a browser's would. The unlock goes with it.
async function signedOut() {
  clipping.desk.signedOut();
  forget();
  await persist();
  await removeAllKept();
}

/**
 * Sign out on this computer only, when the server no longer answers as
 * WikiStow (#257): what signing out forgets, and the server's cookies and the
 * server chosen too, so sign-in asks for a server. Nothing goes to the
 * server, whose session stays alive until it expires or is revoked.
 */
async function signOutHere() {
  cookie = null;
  server = null;
  await signedOut();
  // A failed write brings the old server back at the next launch, where this
  // can be done again.
  await saveConfig().catch(() => {});
}

/**
 * Send `request` on to the server with the session, keeping any cookie the
 * server changes. Fails when there is no server, or no answer.
 */
async function toServer(request: Request, send: typeof fetch = fetch): Promise<Response> {
  if (!server) throw new Error('No server');
  const upstream = { origin: server, cookie };
  const sent = await forward(request, upstream, send);
  // Only if nothing replaced the session meanwhile, such as a sign-in.
  if (sent.cookie !== undefined && server === upstream.origin && cookie === upstream.cookie) {
    cookie = sent.cookie;
    void persist();
  }
  return sent.response;
}

async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Node gives custom schemes no origin (`null`), so the parts are compared.
  if (`${url.protocol}//${url.host}` !== APP_ORIGIN) return new Response(null, { status: 404 });
  if (url.pathname.startsWith('/api/')) {
    // No server yet: to the pages that is being signed out, so they ask for one.
    if (!server) {
      const error = { code: 'unauthenticated', message: 'Sign in first' };
      return Response.json({ error }, { status: 401 });
    }
    // Only the app's own pages may use its session.
    const from = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    if ((from !== null && from !== APP_ORIGIN) || (site !== null && site !== 'same-origin')) {
      return new Response(null, { status: 403 });
    }
    return toServer(request).catch(() => Response.error());
  }
  if (url.pathname.startsWith('/plugins/')) {
    // An installed plugin's file, a library plugin's copy, or a workshop build's.
    const address = safeMode ? null : pluginAddress(url.pathname);
    const plugin =
      address && (plugins.file(address) ?? library.file(address) ?? workshop.file(address));
    const found = plugin
      ? await net.fetch(pathToFileURL(plugin.path).href).catch(() => null)
      : null;
    if (!plugin || !found?.ok) return new Response(null, { status: 404 });
    const headers = new Headers(SECURITY_HEADERS);
    headers.set('Content-Security-Policy', PLUGIN_FILE_CSP);
    headers.set('Content-Type', plugin.type);
    return new Response(found.body, { status: 200, headers });
  }
  const file = appFile(webDist, url.pathname);
  const found = file ? await net.fetch(pathToFileURL(file).href).catch(() => null) : null;
  if (!found?.ok) return new Response(null, { status: 404 });
  const headers = new Headers(found.headers);
  // The plugin and diagram host frames' files get the server's exceptions (ADR 0002, 0010).
  for (const [name, value] of Object.entries(securityHeadersFor(url.pathname, APP_ORIGIN))) {
    headers.set(name, value);
  }
  return new Response(found.body, { status: 200, headers });
}

/** A folder the person chooses in a native dialog, or null if they cancel. */
async function chooseFolder(options: OpenDialogOptions) {
  const chosen = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const [folder] = chosen.filePaths;
  return chosen.canceled || !folder ? null : folder;
}

// Only the app's own pages may call the bridge.
function fromApp(event: IpcMainInvokeEvent) {
  return event.senderFrame?.url.startsWith(`${APP_ORIGIN}/`) === true;
}

function handle<K extends keyof DesktopBridge>(
  channel: K,
  run: (...args: unknown[]) => Promise<Awaited<ReturnType<DesktopBridge[K]>>>,
) {
  ipcMain.handle(DESKTOP_CHANNELS[channel], async (event, ...args) => {
    if (!fromApp(event)) return { ok: false, message: 'Refused' } satisfies DesktopResult<never>;
    try {
      return { ok: true, value: await run(...args) };
    } catch (error) {
      const shown =
        error instanceof SignInError ||
        error instanceof PluginFolderError ||
        error instanceof WorkshopError;
      const message = shown ? error.message : 'Something went wrong.';
      return { ok: false, message };
    }
  });
}

/** Start a browser sign-in. Settles when its link comes back, or it times out. */
async function signIn(input: unknown): Promise<void> {
  const origin = typeof input === 'string' ? serverOrigin(input) : null;
  if (!origin) {
    throw new SignInError('Enter the server’s address, such as https://wiki.example.com.');
  }
  const run = ++signInRun;
  await checkServer(origin);
  if (run !== signInRun) throw new SignInError('Signing in was cancelled.');
  const { verifier, challenge } = newVerifier();
  pending?.done({ ok: false, message: 'Another sign-in started.' });
  const result = new Promise<DesktopResult<void>>((resolve) => {
    const waiting = {
      origin,
      verifier,
      redeeming: false,
      done: (outcome: DesktopResult<void>) => {
        clearTimeout(timer);
        if (pending === waiting) pending = null;
        resolve(outcome);
      },
    };
    const timer = setTimeout(
      () => waiting.done({ ok: false, message: 'Signing in took too long. Try again.' }),
      SIGN_IN_MS,
    );
    pending = waiting;
  });
  const asBeta = which === 'beta' ? '&app=beta' : '';
  await shell
    .openExternal(`${origin}/desktop-sign-in?challenge=${challenge}${asBeta}`)
    .catch(() => {
      pending?.done({ ok: false, message: 'Couldn’t open your browser.' });
    });
  const outcome = await result;
  if (!outcome.ok) throw new SignInError(outcome.message);
}

/**
 * A `wikistow://` link arrived. Only the sign-in this app started can use
 * it. A link that fails to redeem, whatever the reason, is ignored, so no
 * program sending links can end a sign-in waiting for its own; the person
 * can cancel it instead.
 */
async function linkArrived(link: string) {
  const code = handoffCode(link, which);
  const waiting = pending;
  if (!code || !waiting || waiting.redeeming) return;
  waiting.redeeming = true;
  const redeemed = await redeem(waiting.origin, code, waiting.verifier).catch(() => null);
  waiting.redeeming = false;
  if (!redeemed) return;
  // Given up on while it was redeemed: the session goes unused, so end it.
  if (pending !== waiting) return void signOutSession(waiting.origin, redeemed);
  // As does one held already, say from a sign-in cancelled just as it finished.
  if (server && cookie) void signOutSession(server, cookie);
  // The server's other cookies stay, if it is the same server.
  const kept = server === waiting.origin ? cookie : null;
  cookie = cookieChange(kept, [redeemed]) ?? kept;
  // A new sign-in starts with no unlock, search index or marks kept, whoever
  // it is for. Pages kept for offline wait for the pages to learn whose it is.
  // Clips held from before go, as they may have been someone else's.
  forget();
  clipping.desk.signedOut();
  server = waiting.origin;
  waiting.done({ ok: true, value: undefined });
  // Signed in either way; a failed write only means signing in again next time.
  await saveConfig().catch(() => {});
  await persist();
  await removeSignInKept();
}

function openWindow() {
  const kept = place.read();
  window = new BrowserWindow({
    ...kept.bounds,
    title: names.name,
    icon: windowIcon(app.getAppPath(), which),
    // The page's titlebar stands in for the frame (shell/titlebar.tsx). Its
    // empty part moves the window and double-clicking it maximizes; the
    // window still resizes from a few pixels inside each edge. A Mac's
    // window buttons stay, drawn by the system over its left end, centred
    // in its 36 pixels.
    ...(mac
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 11 } }
      : { frame: false }),
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  place.track(window);
  // Maximizing shows the window too.
  window.once('ready-to-show', () => (kept.maximized ? window?.maximize() : window?.show()));
  // The titlebar shows the maximize button as restore while the window fills the screen.
  const tellState = () => {
    if (window) window.webContents.send(DESKTOP_CHANNELS.onWindowState, windowState(window));
  };
  window.on('maximize', tellState);
  window.on('unmaximize', tellState);
  window.on('enter-full-screen', tellState);
  window.on('leave-full-screen', tellState);
  // Main sees these keys before the page does, so this works however a
  // plugin left the page.
  window.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      input.control &&
      input.shift &&
      input.alt &&
      input.code === 'KeyP'
    ) {
      event.preventDefault();
      setSafeMode(true);
      return;
    }
    const action = shortcut(input);
    if (!action) return;
    event.preventDefault();
    act(action);
  });
  // Right-click on the app's own page; plugin frames get no menu. The
  // spellchecker uses the system's language, as Electron does by default.
  window.webContents.on('context-menu', (_event, params) => {
    if (!window || params.frame?.parent !== null) return;
    const { webContents } = window;
    const items = contextMenu(params, {
      replace: (word) => webContents.replaceMisspelling(word),
      learn: (word) => webContents.session.addWordToSpellCheckerDictionary(word),
    });
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window });
  });
  window.webContents.on('did-finish-load', () => {
    switching = null;
    reloading = false;
    clearTimeout(stuck);
  });
  // Emitted before the page's beforeunload, so the handler below can tell
  // a close from a reload. A clip still to save asks first (ADR 0017).
  window.on('close', (event) => {
    if (window && !keepClips(window)) return event.preventDefault();
    closing = true;
  });
  clipping.desk.attach(window.webContents);
  // A draft with changes still to save asks before it is left. Electron
  // refuses that silently, so main asks the person instead: for a close,
  // whether to close once they're saved, and for a reload, whether to lose
  // them. One for safe mode leaves the mode as it was if they stay.
  window.webContents.on('will-prevent-unload', (event) => {
    const closed = closing;
    const reloaded = reloading;
    closing = false;
    reloading = false;
    if (!window) return;
    if (closed && !switching) return askToClose(window, event);
    if (!switching && !reloaded) return;
    // The page answered, so it isn't stuck; the person decides.
    clearTimeout(stuck);
    const answer = dialog.showMessageBoxSync(window, {
      type: 'question',
      buttons: [switching ? 'Restart' : 'Reload', 'Stay'],
      defaultId: 0,
      cancelId: 1,
      message: !switching
        ? 'Reload WikiStow?'
        : safeMode
          ? 'Restart without plugins?'
          : 'Restart with plugins?',
      detail: 'What you typed in the last few seconds isn’t saved yet and would be lost.',
    });
    if (answer === 0) {
      event.preventDefault();
      if (switching) watchReload();
      return;
    }
    if (!switching) return;
    safeMode = switching.before;
    switching = null;
  });
  // A workshop's previews last as long as the page that made them: a new
  // document committed ends them, and a navigation `will-navigate` refuses doesn't.
  window.webContents.on('did-navigate', () => void workshop.clear());
  window.webContents.on('render-process-gone', (_event, details) => {
    clearTimeout(stuck);
    // A workshop's preview runs plugin code too.
    const previewing = workshop.previewing();
    void workshop.clear();
    const forced = ended;
    ended = false;
    if (switching) {
      // Gone while reloading for a change of mode. Ended by main, or on the
      // way into safe mode: load it again, in the mode asked for. Crashing
      // as plugins come back on: they still break it, so stay without them.
      if (forced || safeMode) return window?.webContents.reload();
      switching = null;
      return setSafeMode(true);
    }
    if (details.reason === 'clean-exit') return;
    if (safeMode || !(plugins.anyEnabled() || previewing)) return void askAfterCrash();
    setSafeMode(true);
  });
  window.on('closed', () => {
    clearInterval(closeRetry);
    window = null;
  });
  void window.loadURL(`${APP_ORIGIN}/`);
}

/**
 * The page stopped with no plugin to blame. The window has no frame, so
 * without its page nothing would close it: ask whether to load it again,
 * or close.
 */
async function askAfterCrash() {
  if (!window) return;
  const { response } = await dialog.showMessageBox(window, {
    type: 'error',
    buttons: ['Reload', 'Close'],
    defaultId: 0,
    cancelId: 0,
    message: 'WikiStow stopped working',
    detail: 'Its page closed unexpectedly. Reload to open it again.',
  });
  if (response === 0) window?.webContents.reload();
  else window?.close();
}

/** The clips the person chose to close without, so the close's retries don't ask again. */
const clipsLetGo = new Set<string>();

/** Whether to close with clips still to save, which only memory holds: true unless the person stays. */
function keepClips(window: BrowserWindow) {
  const held = clipping.desk.holding();
  if (held.every((id) => clipsLetGo.has(id))) return true;
  const count = held.length;
  const answer = dialog.showMessageBoxSync(window, {
    type: 'question',
    buttons: ['Close', 'Stay'],
    defaultId: 1,
    cancelId: 1,
    message: count === 1 ? 'A clip isn’t saved yet' : `${count} clips aren’t saved yet`,
    detail: 'It came from your browser and is kept only until it’s saved. Closing now loses it.',
  });
  if (answer !== 0) {
    // Staying is staying: a "Close when saved" waiting to close again stops too.
    clearInterval(closeRetry);
    closeBy = null;
    return false;
  }
  for (const id of held) clipsLetGo.add(id);
  return true;
}

/** How long "Close when saved" waits for the save before asking again. */
const CLOSE_WAIT_MS = 10_000;
/** The window is closing, for the page's beforeunload that follows. */
let closing = false;
/** The person asked for a reload (Ctrl+R, or the titlebar's menu), for the beforeunload that follows. */
let reloading = false;

const windowState = (window: BrowserWindow): WindowState => ({
  maximized: window.isMaximized(),
  fullScreen: window.isFullScreen(),
});

/** What a shortcut or a Mac's menu asks for: quitting, Find on page, or `windowAction`. */
function act(action: MenuAction) {
  if (action === 'quit') app.quit();
  else if (action === 'find') window?.webContents.send(DESKTOP_CHANNELS.onFind);
  else windowAction(action);
}

/**
 * What the titlebar or a shortcut asks of the window. Maximize and restore go
 * through `maximize()` and `unmaximize()` so `place` keeps the state, and
 * closing through `close()`, as the window manager's close does.
 */
function windowAction(action: WindowAction) {
  if (!window) return;
  const { webContents } = window;
  switch (action) {
    case 'minimize':
      return window.minimize();
    case 'toggle-maximize':
      if (window.isFullScreen()) return window.setFullScreen(false);
      return window.isMaximized() ? window.unmaximize() : window.maximize();
    case 'close':
      return window.close();
    case 'reload':
      reloading = true;
      return webContents.reload();
    // The steps the default menu's zoom took.
    case 'zoom-in':
      return webContents.setZoomLevel(webContents.getZoomLevel() + 0.5);
    case 'zoom-out':
      return webContents.setZoomLevel(webContents.getZoomLevel() - 0.5);
    case 'zoom-reset':
      return webContents.setZoomLevel(0);
    case 'toggle-full-screen':
      return window.setFullScreen(!window.isFullScreen());
    case 'toggle-developer-tools':
      return webContents.toggleDevTools();
  }
}
/** Waiting to close once the changes are saved: when to give up and ask again. */
let closeBy: number | null = null;
let closeRetry: ReturnType<typeof setInterval> | undefined;

/**
 * The page held a close for changes not yet saved (typing, or a file still
 * uploading). Ask whether to close once they're saved, close now and lose
 * them, or stay. Closing once saved tries the
 * close again every half second, which the page lets through as soon as the
 * save is answered; a save that hasn't come (a conflict, or no connection)
 * asks again after `CLOSE_WAIT_MS`.
 */
function askToClose(window: BrowserWindow, event: { preventDefault(): void }) {
  if (closeBy !== null && Date.now() < closeBy) return;
  const waited = closeBy !== null;
  clearInterval(closeRetry);
  closeBy = null;
  const answer = dialog.showMessageBoxSync(window, {
    type: 'question',
    buttons: ['Close when saved', 'Close now', 'Stay'],
    defaultId: 0,
    cancelId: 2,
    message: waited ? 'Your changes still aren’t saved' : 'Close WikiStow?',
    detail: waited
      ? 'The page shows why. Closing now loses them.'
      : 'Your latest changes to this page aren’t saved yet. They save in a moment.',
  });
  if (answer === 1) return event.preventDefault();
  // Staying: clips the person let go for this close are theirs to be asked about again.
  if (answer !== 0) return clipsLetGo.clear();
  closeBy = Date.now() + CLOSE_WAIT_MS;
  closeRetry = setInterval(() => window.close(), 500);
}

/** How long a reload for safe mode may take before the page is taken as stuck and ended. */
const STUCK_MS = 5_000;
/** Safe mode was changed and the window is reloading for it: the mode it had before, for a reload refused. */
let switching: { before: boolean } | null = null;
let stuck: ReturnType<typeof setTimeout> | undefined;
/** Main ended the page itself, for a reload it held up. */
let ended = false;

/** End the page if the reload hasn't got through by then, as a plugin stuck in a loop never lets it. */
function watchReload() {
  clearTimeout(stuck);
  stuck = setTimeout(() => {
    if (!switching || window?.webContents.isCrashed()) return;
    ended = true;
    window?.webContents.forcefullyCrashRenderer();
  }, STUCK_MS);
}

/**
 * Turn safe mode on or off and reload the window for it. A page that
 * doesn't let the reload through is ended, and loads again once it is
 * gone (`render-process-gone`).
 */
function setSafeMode(on: boolean) {
  switching ??= { before: safeMode };
  safeMode = on;
  window?.webContents.reload();
  watchReload();
}

// On a Mac, links come to the running app as this event instead, from the
// scheme its Info.plist claims (scripts/macos-app.sh).
app.on('open-url', (event, url) => {
  event.preventDefault();
  window?.focus();
  void linkArrived(url);
});

/** Show the window in front, as the web clipper's `open` asks (ADR 0017, decision 1). */
function bringForward() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (mac) app.focus({ steal: true });
}

app.on('second-instance', (_event, argv) => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
  const link = linkArgument(argv, which);
  if (link) void linkArrived(link);
  // Asked for while a plugin holds the window: this launch only hands it over.
  if (argv.includes('--safe-mode') && !safeMode) setSafeMode(true);
});

// Pages never leave the app: other links open in the system browser.
app.on('web-contents-created', (_event, contents) => {
  const stayInApp = (event: { preventDefault(): void }, url: string) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
  };
  contents.on('will-navigate', stayInApp);
  contents.on('will-redirect', stayInApp);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

// The helper then finds the app closed, rather than a socket nobody
// answers: from the window's closing, as quitting may wait on writes after.
app.on('window-all-closed', () => {
  clipping.stopNow();
  app.quit();
});
app.on('will-quit', () => clipping.stopNow());

// Quitting (Ctrl+Q) closes the window first, as its close button
// does, so a draft with changes still to save can ask while the session
// still works; closing the last window quits again.
// A forget written as the app quits (lock, then close) must land first, or
// the next launch would unlock with the key the person asked to forget.
// Without a trusted store nothing keeps the session, so no later launch can
// use it: it ends on the server, as signing out does. That is best effort,
// so a server that doesn't answer never holds the app open. A second quit
// meanwhile waits for it too.
app.on('before-quit', (event) => {
  if (window) {
    event.preventDefault();
    window.close();
    return;
  }
  if (!store?.secure && server && cookie) {
    const ending = signOutSession(server, cookie, AbortSignal.timeout(QUIT_SIGN_OUT_MS)).finally(
      () => {
        // Not one started since, for a sign-in that landed meanwhile.
        if (signingOut === ending) signingOut = null;
      },
    );
    signingOut = ending;
    cookie = null;
  }
  if (unwritten === 0 && !signingOut) return;
  event.preventDefault();
  void Promise.all([writing, signingOut]).then(() => app.quit());
});

/**
 * The system's secret store, if it is one worth trusting. On Windows
 * (DPAPI) and macOS (the Keychain) the key is the person's own, or there is
 * none. On Linux, without a keyring, Electron seals with a key every program
 * knows; then nothing secret is kept and each launch signs in again. The
 * async API keeps its key in the keyring under the app's name: on KWallet
 * `WikiStow Safe Storage` in `WikiStow Keys`, where the sync API uses the
 * entry every Chromium-based app shares.
 */
async function systemCipher(): Promise<Cipher | null> {
  if (!(await safeStorage.isAsyncEncryptionAvailable().catch(() => false))) return null;
  // Electron picks its key once, so one sealed value shows which it is.
  const probe = await safeStorage.encryptStringAsync('probe').catch(() => null);
  if (!probe || (process.platform === 'linux' && !sealedByKeyring(probe))) return null;
  return {
    encrypt: (text) => safeStorage.encryptStringAsync(text),
    decrypt: async (sealed) => (await safeStorage.decryptStringAsync(sealed)).result,
  };
}

const VaultKey = z.instanceof(Uint8Array).refine((key) => key.length === 32);
const KeptAccountJson = z.strictObject({ id: z.string().max(100), name: z.string().max(200) });

void app.whenReady().then(async () => {
  await loadConfig();
  await plugins.load();
  store = secretFile(join(app.getPath('userData'), 'secrets.json'), await systemCipher());
  const kept = await store.read();
  // Kept for another server than the one chosen (a write cut short between
  // the two files): those cookies must not go to this one.
  if (kept.origin === server) ({ cookie, vault } = kept);
  if (!store.secure) {
    await store.clear();
    // Sealed by the vault, but kept no more than the sign-in is.
    await removeKept();
  }
  // Copying a command or a recovery key is the one thing pages may ask for.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, allow) =>
    allow(permission === 'clipboard-sanitized-write'),
  );
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission) => permission === 'clipboard-sanitized-write',
  );
  protocol.handle('app', serve);
  // No menu bar, and none of its shortcuts: `shortcut` keeps the useful ones.
  // A Mac's menu bar is never empty, so it has the app's own.
  Menu.setApplicationMenu(mac ? Menu.buildFromTemplate(macMenu(act)) : null);
  updates.start();
  handle('update', () => updates.state());
  handle('server', async () => server);
  handle('signIn', (origin) => signIn(origin));
  handle('cancelSignIn', async () => {
    signInRun += 1;
    pending?.done({ ok: false, message: 'Signing in was cancelled.' });
  });
  handle('signedOut', signedOut);
  handle('signOutHere', signOutHere);
  handle('secureStorage', async () => store?.secure === true);
  handle('rememberVault', async (accountId, key) => {
    // The pages only offer this with a trusted store.
    if (!store?.secure) throw new Error('No secret store');
    const remembered = { accountId: z.string().parse(accountId), key: VaultKey.parse(key) };
    forget();
    vault = remembered;
    await persist();
  });
  handle('rememberedVault', async (accountId) =>
    vault && vault.accountId === accountId ? vault.key : null,
  );
  handle('forgetVault', async () => {
    forget();
    await persist();
  });
  handle('searchIndex', async () => (store?.secure ? searchIndex.read() : null));
  handle('keepSearchIndex', async (sealed) => {
    if (store?.secure) await searchIndex.write(z.instanceof(Uint8Array).parse(sealed));
  });
  handle('dropSearchIndex', async () => {
    await searchIndex.remove();
  });
  handle('trustMarks', async () => (store?.secure ? trustMarks.read() : null));
  handle('keepTrustMarks', async (sealed) => {
    if (store?.secure) await trustMarks.write(z.instanceof(Uint8Array).parse(sealed));
  });
  // Pages, and what unlocking offline reads, are kept on disk only with a
  // trusted keyring, as the session is; changes made offline, and whose
  // they are, either way (ADR 0009).
  const keptIn = (folder: unknown) => {
    const name = z.enum(KEPT_FOLDERS).parse(folder);
    return name === 'queue' || store?.secure ? keptFolders[name] : null;
  };
  const KeptName = z.string().regex(KEPT_ITEM_NAME);
  handle('keptItems', async (folder) => (await keptIn(folder)?.list()) ?? []);
  handle('keptItem', async (folder, name) => {
    const parsed = KeptName.parse(name);
    return (await keptIn(folder)?.read(parsed)) ?? null;
  });
  handle('keepItem', async (folder, name, sealed) => {
    const parsed = { name: KeptName.parse(name), sealed: z.instanceof(Uint8Array).parse(sealed) };
    await keptIn(folder)?.write(parsed.name, parsed.sealed);
  });
  handle('dropKeptItems', async (folder, names) => {
    await keptIn(folder)?.remove(z.array(KeptName).parse(names));
  });
  handle('keptAccount', async () => {
    const kept = await keptAccountFile.read();
    if (!kept) return null;
    try {
      return KeptAccountJson.parse(JSON.parse(Buffer.from(kept).toString('utf8')));
    } catch {
      return null;
    }
  });
  handle('keepKeptAccount', async (account) => {
    const parsed = KeptAccountJson.parse(account);
    await keptAccountFile.write(Buffer.from(JSON.stringify(parsed)));
  });
  handle('clearKept', removeAllKept);
  handle('plugins', async () => plugins.list(safeMode));
  handle('pickPlugin', async (kind) => {
    const development = kind === 'development';
    const folder = await chooseFolder({
      title: development ? 'Load a plugin folder for development' : 'Install a plugin',
      buttonLabel: development ? 'Load' : 'Choose',
      properties: ['openDirectory'],
    });
    return folder === null ? null : plugins.pick(folder, development);
  });
  handle('approvePlugin', (token) => plugins.approve(token));
  handle('setPluginEnabled', (id, enabled) => plugins.setEnabled(id, enabled));
  handle('setPluginOwnParts', (id, regions) => plugins.setOwnParts(id, regions));
  handle('reloadPlugin', (id) => plugins.reload(id));
  handle('removePlugin', (id) => plugins.remove(id));
  handle('pluginAccess', async (accountId) => plugins.access(accountId));
  handle('setPluginAccess', (accountId, pluginId, scopes) =>
    plugins.setAccess(accountId, pluginId, scopes),
  );
  handle('pluginSettings', async (accountId) => plugins.settings(accountId));
  handle('setPluginSettings', (accountId, pluginId, settings) =>
    plugins.setSettings(accountId, pluginId, settings),
  );
  handle('pluginsOffHere', async (accountId) => plugins.offHere(accountId));
  handle('setPluginsOffHere', (accountId, pluginIds) => plugins.setOffHere(accountId, pluginIds));
  handle('libraryPlugins', (approved) => library.sync(approved));
  handle('pluginUpload', (id) => plugins.uploadFiles(id));
  handle('setSafeMode', async (on) => setSafeMode(on === true));
  handle('windowAction', async (action) => windowAction(z.enum(WINDOW_ACTIONS).parse(action)));
  handle('windowState', async () =>
    window ? windowState(window) : { maximized: false, fullScreen: false },
  );
  await workshop.load();
  handle('workshopPreview', (files) => workshop.preview(files));
  handle('workshopExport', (files, hash) =>
    workshop.exportTo(files, hash, () =>
      chooseFolder({
        title: 'Export the plugin into a folder',
        buttonLabel: 'Export here',
        properties: ['openDirectory', 'createDirectory'],
      }),
    ),
  );
  handle('clipping', () => clipping.state());
  handle('setClipping', async (on) => clipping.set(z.boolean().parse(on)));
  handle('setClipState', async (state) => clipping.desk.setPageState(state));
  handle('waitingClips', async () => clipping.desk.waiting());
  handle('clipMade', async (clipId, page) => clipping.desk.made(clipId, page));
  handle('clipDone', async (clipId, outcome) => clipping.desk.done(clipId, outcome));
  handle('clipFolders', async (requestId, folders) =>
    clipping.desk.answerFolders(requestId, folders),
  );
  handle('clipImage', (clipId, url) => clipping.desk.image(clipId, url));
  // Listening before the window loads, as a helper may be waiting to connect.
  if (firstInstance) await clipping.start();
  openWindow();
});

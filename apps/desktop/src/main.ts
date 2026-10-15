// The desktop app's main process. It serves the built web app from
// `app://wikistow`, forwards that origin's API requests to the server with
// the session only it holds, signs in through the system browser, keeps
// and serves the plugins installed on this computer, builds and serves
// the plugin workshop's versions, and checks for a newer release.
import {
  DESKTOP_CHANNELS,
  SECURITY_HEADERS,
  type DesktopBridge,
  type DesktopResult,
} from '@wikistow/contracts';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { APP_ORIGIN, appFile } from './app-files.ts';
import { cookieChange, forward } from './forward.ts';
import { PluginFolderError } from './plugins/folder.ts';
import { desktopPlugins, pluginAddress } from './plugins/plugins.ts';
import { searchIndexFile } from './search-index.ts';
import { sealedByKeyring, secretFile, type Cipher, type Secrets } from './secrets.ts';
import {
  checkServer,
  handoffCode,
  newVerifier,
  redeem,
  serverOrigin,
  signOutSession,
  SignInError,
} from './sign-in.ts';
import { desktopUpdates } from './updates.ts';
import { workshopBuilder } from './workshop/builder.ts';
import { desktopWorkshop, WorkshopError } from './workshop/workshop.ts';

/** How long a browser sign-in may take before the app stops waiting for it. */
const SIGN_IN_MS = 10 * 60_000;
/** How long quitting waits for the server to end a session nothing kept. */
const QUIT_SIGN_OUT_MS = 3_000;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

// The launcher entry the desktop shows for these windows, which also claims
// `wikistow://` links (packaging/wikistow-desktop.desktop).
app.setDesktopName('wikistow-desktop.desktop');

// A second launch, such as the browser opening a `wikistow://` link, hands
// its arguments to this one and quits.
if (!app.requestSingleInstanceLock()) app.quit();

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
// The bundler's worker and WebAssembly are beside this bundle (`vite.config.ts`).
const bundler = workshopBuilder(
  new URL('./workshop-build.mjs', import.meta.url),
  fileURLToPath(new URL('./esbuild.wasm', import.meta.url)),
);
const workshop = desktopWorkshop(app.getPath('userData'), bundler);
const updates = desktopUpdates(app.getPath('userData'), app.getVersion(), app.getAppPath());
const searchIndex = searchIndexFile(join(app.getPath('userData'), 'search-index'));

/** End every workshop, as the page that held them goes, and the bundler with them. */
async function endWorkshops() {
  if (!workshop.open()) return;
  await workshop.endAll();
  bundler.stop();
}
/**
 * No plugins load: asked for with `--safe-mode` or Ctrl+Shift+Alt+P, or
 * after the window crashed with plugins on. Until the person turns them
 * back on, or the app restarts.
 */
let safeMode = process.argv.includes('--safe-mode');

/** A plugin file's response is refused everything a response's policy governs: a worker's requests above all. */
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
    try {
      const upstream = { origin: server, cookie };
      const sent = await forward(request, upstream);
      // Only if nothing replaced the session meanwhile, such as a sign-in.
      if (sent.cookie !== undefined && server === upstream.origin && cookie === upstream.cookie) {
        cookie = sent.cookie;
        void persist();
      }
      return sent.response;
    } catch {
      return Response.error();
    }
  }
  if (url.pathname.startsWith('/plugins/')) {
    // An installed plugin's file, or a workshop version's.
    const address = safeMode ? null : pluginAddress(url.pathname);
    const plugin = address && (plugins.file(address) ?? workshop.file(address));
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
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
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
  await shell.openExternal(`${origin}/desktop-sign-in?challenge=${challenge}`).catch(() => {
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
  const code = handoffCode(link);
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
  // A new sign-in starts with no unlock or search index kept, whoever it is for.
  forget();
  server = waiting.origin;
  waiting.done({ ok: true, value: undefined });
  // Signed in either way; a failed write only means signing in again next time.
  await saveConfig().catch(() => {});
  await persist();
  await searchIndex.remove().catch(() => {});
}

function openWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'WikiStow',
    icon: join(app.getAppPath(), 'packaging', 'wikistow-desktop.png'),
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  window.once('ready-to-show', () => window?.show());
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
    }
  });
  window.webContents.on('did-finish-load', () => {
    switching = null;
    clearTimeout(stuck);
  });
  // Emitted before the page's beforeunload, so the handler below can tell
  // a close from a reload.
  window.on('close', () => {
    closing = true;
  });
  // A draft with changes still to save asks before it is left. Electron
  // refuses that silently, so main asks the person instead: for a close,
  // whether to close once they're saved, and for a reload for safe mode, which
  // leaves the mode as it was if they stay.
  window.webContents.on('will-prevent-unload', (event) => {
    const closed = closing;
    closing = false;
    if (!window) return;
    if (closed && !switching) return askToClose(window, event);
    if (!switching) return;
    // The page answered, so it isn't stuck; the person decides.
    clearTimeout(stuck);
    const answer = dialog.showMessageBoxSync(window, {
      type: 'question',
      buttons: ['Restart', 'Stay'],
      defaultId: 0,
      cancelId: 1,
      message: safeMode ? 'Restart without plugins?' : 'Restart with plugins?',
      detail: 'What you typed in the last few seconds isn’t saved yet and would be lost.',
    });
    if (answer === 0) {
      event.preventDefault();
      watchReload();
      return;
    }
    safeMode = switching.before;
    switching = null;
  });
  // A workshop lives as long as the page that holds its conversation: a new
  // document committed ends it, and a navigation `will-navigate` refuses doesn't.
  window.webContents.on('did-navigate', () => void endWorkshops());
  window.webContents.on('render-process-gone', (_event, details) => {
    clearTimeout(stuck);
    // A workshop's preview runs plugin code too.
    const previewing = workshop.open();
    void endWorkshops();
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
    if (details.reason === 'clean-exit' || safeMode || !(plugins.anyEnabled() || previewing)) {
      return;
    }
    setSafeMode(true);
  });
  window.on('closed', () => {
    clearInterval(closeRetry);
    window = null;
  });
  void window.loadURL(`${APP_ORIGIN}/`);
}

/** How long "Close when saved" waits for the save before asking again. */
const CLOSE_WAIT_MS = 10_000;
/** The window is closing, for the page's beforeunload that follows. */
let closing = false;
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
  if (answer !== 0) return;
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

app.on('second-instance', (_event, argv) => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
  const link = argv.find((arg) => arg.startsWith('wikistow:'));
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

app.on('window-all-closed', () => app.quit());

// Quitting (the menu's Quit) closes the window first, as its close button
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
 * The system's secret store, if it is one worth trusting. Without a keyring,
 * Electron seals with a key every program knows; then nothing secret is kept
 * and each launch signs in again. The async API keeps its key in the keyring
 * under the app's name: on KWallet `WikiStow Safe Storage` in `WikiStow
 * Keys`, where the sync API uses the entry every Chromium-based app shares.
 */
async function systemCipher(): Promise<Cipher | null> {
  // Linux only, for now: the key can't be checked anywhere else.
  if (process.platform !== 'linux') return null;
  // Electron picks its key once, so one sealed value shows which it is.
  const probe = await safeStorage.encryptStringAsync('probe').catch(() => null);
  if (!probe || !sealedByKeyring(probe)) return null;
  return {
    encrypt: (text) => safeStorage.encryptStringAsync(text),
    decrypt: async (sealed) => (await safeStorage.decryptStringAsync(sealed)).result,
  };
}

const VaultKey = z.instanceof(Uint8Array).refine((key) => key.length === 32);

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
    await searchIndex.remove().catch(() => {});
  }
  // Copying a command or a recovery key is the one thing pages may ask for.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, allow) =>
    allow(permission === 'clipboard-sanitized-write'),
  );
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission) => permission === 'clipboard-sanitized-write',
  );
  protocol.handle('app', serve);
  updates.start();
  handle('update', () => updates.state());
  handle('server', async () => server);
  handle('signIn', (origin) => signIn(origin));
  handle('cancelSignIn', async () => {
    signInRun += 1;
    pending?.done({ ok: false, message: 'Signing in was cancelled.' });
  });
  // The server's answer to signing out already cleared the session cookie;
  // its other cookies stay, as a browser's would. The unlock goes with it.
  handle('signedOut', async () => {
    forget();
    await persist();
    await searchIndex.remove().catch(() => {});
  });
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
  handle('reloadPlugin', (id) => plugins.reload(id));
  handle('removePlugin', (id) => plugins.remove(id));
  handle('pluginAccess', async (accountId) => plugins.access(accountId));
  handle('setPluginAccess', (accountId, pluginId, scopes) =>
    plugins.setAccess(accountId, pluginId, scopes),
  );
  handle('setSafeMode', async (on) => setSafeMode(on === true));
  await workshop.load();
  handle('workshopStart', () => workshop.start());
  handle('workshopEnd', async (session) => {
    await workshop.end(session);
    if (!workshop.open()) bundler.stop();
  });
  handle('workshopFiles', (session) => workshop.files(session));
  handle('workshopRead', (session, path) => workshop.read(session, path));
  handle('workshopWrite', (session, path, text) => workshop.write(session, path, text));
  handle('workshopDelete', (session, path) => workshop.remove(session, path));
  handle('workshopBuild', (session) => workshop.build(session));
  handle('workshopCancel', async (session) => workshop.cancel(session));
  handle('workshopExport', async (session, version, hash) => {
    const parent = await chooseFolder({
      title: 'Export the plugin into a folder',
      buttonLabel: 'Export here',
      properties: ['openDirectory', 'createDirectory'],
    });
    return parent === null ? null : workshop.exportTo(session, version, hash, parent);
  });
  // The usual install, from the reviewed version's folder: copied, hashed
  // again, and approved by the person in the app's own dialog.
  handle('workshopInstall', async (session, version, hash) => {
    const candidate = await plugins.pick(
      await workshop.installFolder(session, version, hash),
      false,
    );
    if (candidate.hash !== hash)
      throw new WorkshopError('The copy doesn’t match the reviewed version.');
    return candidate;
  });
  openWindow();
});

// The extension's background: Chrome's service worker, Firefox's
// background script (ADR 0017, decisions 4 to 7). It alone talks to the
// desktop app, so a clip waiting for the app to open or unlock goes on
// when the popup closes. It takes calls only from its own popup, over a
// port: no other extension or page can reach it. The content script it
// injects answers as the injection's result; the one message it takes is
// the area overlay's (area.ts), from the tab it was injected in, naming
// the nonce it was given there.
import { api } from './api.ts';
import type { Captured } from './capture.ts';
import { base64, cropPng, dataBytes, isAreaMessage, type Area, type ViewSize } from './shot.ts';
import { ask, converse, find, HostGone, TimedOut, type Found } from './host.ts';
import {
  POPUP_PORT,
  type Call,
  type Calls,
  type Choosing,
  type ClipView,
  type Failure,
  type Form,
  type FromBackground,
  type LocalState,
  type SessionState,
  type View,
} from './messages.ts';
import {
  envelope,
  HOSTS,
  MAX_CLIP_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_NAME,
  MAX_NOTE,
  MAX_QUERY,
  MAX_SCREENSHOT_CHARS,
  MAX_TITLE,
  MAX_URL,
  PROTOCOL,
  speaks,
  type Clip,
  type Folder,
  type Saved,
  type TextMode,
} from './protocol.ts';

/** How long a clip waits for the app to open or unlock, or to save it, before the extension stops waiting. */
const WAIT_MS = 10 * 60_000;
/** How long, at most, between answers while a clip is sent, the app opening included (60 s). */
const SEND_MS = 2 * 60_000;
/** How long the toolbar button shows its check after a save. */
const CHECK_MS = 4_000;
/** How long the person has to drag out an area, as the overlay waits. */
const CHOOSE_MS = 5 * 60_000;

/** The app found last, which searches and shows go to. */
let found: Found | null = null;
/** How the last clip went, as `storage.session` keeps it too. */
let current: ClipView | null = null;
let sending = false;
const popups = new Set<chrome.runtime.Port>();
/** The folder the last clip went to, once read: known without waiting, for Firefox's `openPopup`. */
let lastFolder: Folder | null | undefined;

const session = async () => (await api.storage.session.get(['lastFolder', 'clip'])) as SessionState;

async function pin() {
  const { host } = (await api.storage.local.get('host')) as LocalState;
  return host ?? 'auto';
}

function push(message: FromBackground) {
  for (const port of popups) {
    try {
      port.postMessage(message);
    } catch {
      popups.delete(port);
    }
  }
}

function viewOf(at: Found | null): View {
  if (!at) return { app: 'missing' };
  const { status } = at;
  if (!speaks(status)) {
    return { app: 'version', update: status.protocols!.max < PROTOCOL ? 'app' : 'extension' };
  }
  return { app: status.app, offline: status.offline ?? false, host: at.host };
}

async function status(): Promise<View> {
  found = await find(await pin());
  return viewOf(found);
}

/** Open the app, or bring it forward, saying how it is as that changes, until it's ready. */
async function open(signal: AbortSignal): Promise<Calls['open']['result']> {
  if (!found) await status();
  if (!found) return { view: viewOf(null), failed: null };
  const { host } = found;
  const message = envelope({ type: 'open' });
  let failed: string | null = null;
  try {
    await converse(
      HOSTS[host],
      [message],
      (answer) => {
        if (answer.id !== message.id) return false;
        if (answer.type === 'error') {
          failed = answer.message ?? 'WikiStow didn’t open.';
          return true;
        }
        if (answer.type !== 'status') return false;
        found = { host, status: answer };
        push({ push: 'view', view: viewOf(found) });
        return answer.app === 'ready';
      },
      { ms: SEND_MS, signal },
    );
  } catch {
    // The popup closed, or the helper went: what it said last stands.
  }
  return { view: viewOf(found), failed };
}

async function folders(query: string): Promise<Calls['folders']['result']> {
  if (!found) await status();
  if (!found) return { error: 'missing' };
  try {
    const answer = await ask(found.host, { type: 'folders', query: query.slice(0, MAX_QUERY) });
    if (answer.type === 'folders') return { recent: answer.recent, matches: answer.matches };
    if (answer.type === 'error') return { error: answer.code };
    return { error: 'closed' };
  } catch {
    return { error: 'missing' };
  }
}

/** The tab's address and title, and its selection, or null where no script may run, as on the browser's own pages. */
async function probe(tabId: number): Promise<Calls['probe']['result']> {
  const tab = await api.tabs.get(tabId);
  let selection: string | null;
  try {
    const [ran] = await api.scripting.executeScript({
      target: { tabId },
      func: () => getSelection()?.toString() ?? '',
    });
    selection = typeof ran?.result === 'string' ? ran.result : '';
  } catch {
    selection = null;
  }
  return { url: tab.url ?? '', title: tab.title ?? '', selection };
}

async function capture(tabId: number, mode: TextMode): Promise<Captured> {
  await api.scripting.executeScript({ target: { tabId }, files: ['capture.js'] });
  const [ran] = await api.scripting.executeScript({
    target: { tabId },
    func: (mode: TextMode) => globalThis.wikistowCapture!(mode),
    args: [mode],
  });
  if (!ran?.result) throw new Error('Nothing captured');
  return ran.result as Captured;
}

async function show(spaceId: string, pageId: string): Promise<Calls['show']['result']> {
  if (!found) await status();
  if (!found) return { shown: false };
  try {
    const answer = await ask(found.host, { type: 'show', spaceId, pageId });
    return { shown: answer.type === 'shown' };
  } catch {
    return { shown: false };
  }
}

let unbadge: ReturnType<typeof setTimeout> | undefined;
function badge(text: '' | '✓' | '!') {
  clearTimeout(unbadge);
  void api.action.setBadgeText({ text });
  if (text) {
    void api.action.setBadgeBackgroundColor({ color: text === '✓' ? '#1f7a45' : '#b3261e' });
  }
  if (text === '✓')
    unbadge = setTimeout(() => void api.action.setBadgeText({ text: '' }), CHECK_MS);
}

function clearClip() {
  current = null;
  void api.storage.session.remove('clip');
  push({ push: 'clip', clip: null });
  badge('');
}

function setClip(next: ClipView) {
  current = next;
  void api.storage.session.set({ clip: next });
  push({ push: 'clip', clip: next });
  if (next.phase === 'saved') badge('✓');
  else if (next.phase === 'failed') badge('!');
  else badge('');
}

const fail = (code: Failure, message: string) => setClip({ phase: 'failed', code, message });

const TOO_LONG =
  'This is too long to clip. Try Article, or select part of it and clip the selection.';

/** Why a screenshot couldn't be taken, in the popup's words. */
class NoShot extends Error {
  readonly code: Failure;
  constructor(code: Failure, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The tab as shown, as PNG base64, or the part of it under `part`: the
 * browser's own screenshot of the visible area, which `activeTab` allows
 * for the tab the person clicked in, cut here for a part.
 */
async function screenshot(
  tab: chrome.tabs.Tab,
  part: { area: Area; view: ViewSize } | null,
): Promise<string> {
  if (!tab.active) throw new NoShot('capture', 'Switch to that tab, then try again.');
  let png: Uint8Array | null;
  try {
    png = dataBytes(await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' }), 'image/png');
  } catch {
    png = null;
  }
  if (!png) throw new NoShot('capture', 'WikiStow can’t take a screenshot of this page.');
  if (part) png = await cropPng(png, part.area, part.view);
  const shot = base64(png);
  if (shot.length > MAX_SCREENSHOT_CHARS) {
    throw new NoShot(
      'too-long',
      part
        ? 'This screenshot is too large to clip. Choose a smaller area.'
        : 'This screenshot is too large to clip. Try Choose an area.',
    );
  }
  return shot;
}

/** The area being chosen, as `storage.session` keeps it, which outlives a sleeping background. */
async function choosing(): Promise<Choosing | null> {
  return ((await api.storage.session.get('choosing')) as SessionState).choosing ?? null;
}

/** Whether the overlay is still on its page: one that went with its page, or was taken off, isn't. */
async function overlayShown(tabId: number): Promise<boolean> {
  try {
    const [ran] = await api.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.wikistowAreaShown?.() ?? false,
    });
    return ran?.result === true;
  } catch {
    return false;
  }
}

/** Stop choosing an area, taking the overlay off its page. */
async function stopChoosing() {
  const was = await choosing();
  if (!was) return;
  await api.storage.session.remove('choosing');
  await api.scripting
    .executeScript({ target: { tabId: was.tabId }, func: () => globalThis.wikistowAreaStop?.() })
    .catch(() => {});
}

/**
 * Put the overlay on the tab, for the person to drag out an area. It names
 * `nonce` when they have (`areaChosen`), and the screenshot is taken then.
 */
async function choose(tabId: number, form: Form) {
  await stopChoosing();
  const nonce = crypto.randomUUID();
  const next: Choosing = { nonce, tabId, form, until: Date.now() + CHOOSE_MS };
  await api.storage.session.set({ choosing: next });
  let started: unknown;
  try {
    await api.scripting.executeScript({ target: { tabId }, files: ['area.js'] });
    const [ran] = await api.scripting.executeScript({
      target: { tabId },
      func: (nonce: string) => globalThis.wikistowArea!(nonce),
      args: [nonce],
    });
    started = ran?.result;
  } catch {
    started = null;
  }
  if (started === 'choosing') return setClip({ phase: 'choosing' });
  await api.storage.session.remove('choosing');
  if (started === 'zoomed') {
    return fail('capture', 'Pinch the page back to its usual size, then choose an area.');
  }
  fail('capture', 'WikiStow can’t take a screenshot of this page.');
}

/** The overlay's message: the area the person dragged out, or that they stopped. */
async function areaChosen(message: unknown, sender: chrome.runtime.MessageSender) {
  if (sender.id !== api.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined) return;
  // A content script's sender is its page, never one of the extension's own.
  if (!sender.url || sender.url.startsWith(api.runtime.getURL(''))) return;
  if (!isAreaMessage(message)) return;
  const was = await choosing();
  if (!was || was.nonce !== message.nonce || was.tabId !== sender.tab.id) return;
  await api.storage.session.remove('choosing');
  if (!message.area || Date.now() > was.until) return clearClip();
  await send(was.tabId, was.form, { area: message.area, view: message.view });
}

/** The clip's JSON is within the app's limit: counted exactly only when it might not be. */
function fits(message: object) {
  const json = JSON.stringify(message);
  if (json.length * 3 <= MAX_MESSAGE_BYTES) return true;
  return new TextEncoder().encode(json).length <= MAX_MESSAGE_BYTES;
}

/** The folder the next quick clip goes to, after one went to `folder` and was saved as `saved`. */
function rememberFolder(folder: Folder, saved: Saved) {
  // The app may have put it elsewhere, if the folder was gone by the unlock.
  if (saved.spaceId !== folder.spaceId || (saved.path && saved.path !== folder.path)) return;
  lastFolder = folder;
  void api.storage.session.set({ lastFolder: folder });
}

/** What the person typed for `url` is saved now: the popup starts afresh there. */
async function forgetDraft(url: string) {
  const { draft } = (await api.storage.session.get('draft')) as SessionState;
  if (draft?.url === url) await api.storage.session.remove('draft');
}

const NOTHING: Captured = { url: '', title: '', html: '', text: '', byline: null, siteName: null };

/**
 * Capture the tab as `form` says and send it to the app: with the app
 * closed, `open` first, which the helper holds the clip behind until the
 * app listens. How it goes is `current`, which open popups hear. An area's
 * screenshot starts with the overlay (`choose`), and is taken and sent
 * here once the person has dragged it out (`part`).
 */
async function send(tabId: number, form: Form, part: { area: Area; view: ViewSize } | null = null) {
  if (sending) return fail('busy', 'A clip is still on its way to WikiStow.');
  if (form.mode === 'area' && !part) return choose(tabId, form);
  sending = true;
  setClip({ phase: 'sending' });
  try {
    if (!part) await stopChoosing();
    const tab = await api.tabs.get(tabId);
    let captured: Captured;
    let shot: string | undefined;
    if (form.mode === 'visible' || form.mode === 'area') {
      captured = NOTHING;
      try {
        shot = await screenshot(tab, part);
      } catch (error) {
        if (error instanceof NoShot) return fail(error.code, error.message);
        throw error;
      }
    } else {
      try {
        captured = await capture(tabId, form.mode);
      } catch {
        // A link needs no script: the browser's own pages can still be linked.
        if (form.mode !== 'link') {
          return fail('capture', 'WikiStow can’t clip this page. Try Link.');
        }
        captured = NOTHING;
      }
    }
    const clip: Clip = {
      mode: shot === undefined ? (form.mode as TextMode) : 'screenshot',
      url: tab.url || captured.url,
      title: (form.title.trim() || tab.title || captured.title).slice(0, MAX_TITLE),
      note: form.note.slice(0, MAX_NOTE),
      tags: form.tags,
      html: captured.html,
      text: captured.text,
      byline: captured.byline?.slice(0, MAX_NAME) ?? null,
      siteName: captured.siteName?.slice(0, MAX_NAME) ?? null,
      folder: { spaceId: form.folder.spaceId, folderId: form.folder.folderId },
      ...(shot === undefined ? {} : { screenshot: shot }),
    };
    if (!clip.url) return fail('capture', 'WikiStow can’t read this tab’s address.');
    if (clip.url.length > MAX_URL)
      return fail('too-long', 'This tab’s address is too long to clip.');
    if (form.mode === 'selection' && !clip.html.trim()) {
      return fail('capture', 'Select some of the page first, or choose another mode.');
    }
    if (clip.html.length > MAX_CLIP_CHARS || clip.text.length > MAX_CLIP_CHARS) {
      return fail('too-long', TOO_LONG);
    }
    const message = envelope({ type: 'clip', ...clip });
    if (!fits(message)) return fail('too-long', TOO_LONG);

    const at = await find(await pin());
    found = at;
    push({ push: 'view', view: viewOf(at) });
    if (!at) return fail('missing', 'Clipping needs the WikiStow desktop app on this computer.');
    if (!speaks(at.status)) return fail('version', 'Update WikiStow or the extension to clip.');
    if (at.status.app === 'signed-out') return fail('signed-out', 'Sign in to WikiStow first.');
    const opening = at.status.app === 'closed' ? envelope({ type: 'open' }) : null;
    if (opening) setClip({ phase: 'waiting', waits: 'starting' });

    let accepted = false;
    try {
      await converse(
        HOSTS[at.host],
        opening ? [opening, message] : [message],
        (answer, conversation) => {
          if (opening && answer.id === opening.id) {
            if (answer.type === 'status') {
              found = { host: at.host, status: answer };
              push({ push: 'view', view: viewOf(found) });
            }
            return false;
          }
          if (answer.id !== message.id) return false;
          switch (answer.type) {
            case 'accepted':
              accepted = true;
              if (answer.waits) setClip({ phase: 'waiting', waits: answer.waits });
              conversation.wait(WAIT_MS);
              return false;
            case 'saved':
              rememberFolder(form.folder, answer);
              void forgetDraft(clip.url);
              setClip({ phase: 'saved', saved: answer });
              return true;
            case 'error':
              fail(answer.code, answer.message ?? 'WikiStow couldn’t save the clip.');
              return true;
            case 'status':
              // The helper answered for a closed app: it didn't open in time.
              fail('closed', 'WikiStow didn’t open. Open it, then try again.');
              return true;
            default:
              return false;
          }
        },
        { ms: SEND_MS },
      );
    } catch (error) {
      if (error instanceof TimedOut && accepted) return setClip({ phase: 'still-waiting' });
      if (error instanceof HostGone && !error.answered) {
        return fail('missing', 'Clipping needs the WikiStow desktop app on this computer.');
      }
      return fail('failed', 'The connection to WikiStow closed before the clip was saved.');
    }
  } catch {
    fail('failed', 'WikiStow couldn’t save the clip.');
  } finally {
    sending = false;
  }
}

async function answer(call: Call, signal: AbortSignal): Promise<unknown> {
  switch (call.call) {
    case 'status':
      return status();
    case 'open':
      return open(signal);
    case 'folders':
      return folders(call.query);
    case 'probe':
      return probe(call.tabId);
    case 'save':
      void send(call.tabId, call.form);
      return null;
    case 'show':
      return show(call.spaceId, call.pageId);
  }
}

/** Only this extension's own popup page may call. */
function fromPopup(port: chrome.runtime.Port) {
  if (port.name !== POPUP_PORT || port.sender?.id !== api.runtime.id || !port.sender.url) {
    return false;
  }
  const url = new URL(port.sender.url);
  return `${url.origin}${url.pathname}` === api.runtime.getURL('popup.html');
}

api.runtime.onMessage.addListener((message, sender) => {
  void areaChosen(message, sender);
  return false;
});

api.runtime.onConnect.addListener((port) => {
  if (!fromPopup(port)) return port.disconnect();
  const closed = new AbortController();
  popups.add(port);
  port.onDisconnect.addListener(() => {
    popups.delete(port);
    closed.abort();
  });
  port.onMessage.addListener((call: Call) => {
    void answer(call, closed.signal).then(
      (result) => {
        if (!closed.signal.aborted) port.postMessage({ id: call.id, result });
      },
      () => {
        if (!closed.signal.aborted) port.postMessage({ id: call.id, result: null });
      },
    );
  });
  void (async () => {
    current ??= (await session()).clip ?? null;
    // An overlay that went with its page, or gave up, leaves nothing to wait for.
    if (current?.phase === 'choosing') {
      const was = await choosing();
      if (!was || Date.now() > was.until || !(await overlayShown(was.tabId))) {
        await api.storage.session.remove('choosing');
        clearClip();
      }
    }
    // A failure's `!` has been seen once the popup opens.
    if (current?.phase === 'failed') badge('');
    port.postMessage({ push: 'clip', clip: current });
  })();
});

/**
 * Send without the popup, from the context menu or the shortcut, to the
 * folder the last clip went to. Before there is one, open the popup:
 * Firefox opens it only while handling the person's click or key, so it's
 * asked at once when no folder is known yet.
 */
async function quick(tab: chrome.tabs.Tab | undefined, mode: 'link' | 'selection' | 'either') {
  if (lastFolder === null) return void api.action.openPopup().catch(() => {});
  const tabId = tab?.id ?? (await api.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  lastFolder ??= (await session()).lastFolder ?? null;
  if (!lastFolder) {
    await api.action.openPopup().catch(() => {
      fail('no-folder', 'Choose a folder here first. Then the menu and the shortcut send to it.');
    });
    return;
  }
  if (tabId === undefined) return;
  let chosen: TextMode = mode === 'selection' ? 'selection' : 'link';
  if (mode === 'either') chosen = (await probe(tabId)).selection?.trim() ? 'selection' : 'link';
  await send(tabId, { mode: chosen, title: '', note: '', tags: [], folder: lastFolder });
}

const MENU = { link: 'send-link', selection: 'send-selection' } as const;

function menuClicked(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  if (info.menuItemId === MENU.link) return quick(tab, 'link');
  if (info.menuItemId === MENU.selection) return quick(tab, 'selection');
}

function commanded(command: string, tab?: chrome.tabs.Tab) {
  if (command === 'send') return quick(tab, 'either');
}

// Firefox for Android has neither menus nor shortcuts; its popup still
// says clipping needs the desktop app.
const menus = api.contextMenus as
  | (typeof chrome.contextMenus & { onShown?: chrome.events.Event<() => void> })
  | undefined;
const commands = api.commands as typeof chrome.commands | undefined;

api.runtime.onInstalled.addListener(() => {
  void menus?.removeAll().then(() => {
    menus.create({ id: MENU.link, title: 'Send link to WikiStow', contexts: ['page'] });
    menus.create({
      id: MENU.selection,
      title: 'Send selection to WikiStow',
      contexts: ['selection'],
    });
  });
});
menus?.onClicked.addListener((info, tab) => void menuClicked(info, tab));
// Firefox wakes its background to show the context menu, before the click,
// so the last folder is read by then, and a click with none can open the
// popup at once, as Firefox asks. Chrome has no `onShown`, and opens the
// popup after a wait too. A shortcut has no such warning: pressed while
// Firefox's background sleeps, with no folder yet, it shows `!` instead.
menus?.onShown?.addListener(() => void readLastFolder());
commands?.onCommand.addListener((command, tab) => void commanded(command, tab));

async function readLastFolder() {
  const kept = await session();
  lastFolder ??= kept.lastFolder ?? null;
}
void readLastFolder();

declare global {
  var wikistowClipper: { menuClicked: typeof menuClicked; commanded: typeof commanded } | undefined;
}
// The handlers the browser calls for the context menu and the shortcut,
// for the tests, which can't click the browser's own menus. Only this
// extension's own pages can reach its background's globals.
globalThis.wikistowClipper = { menuClicked, commanded };

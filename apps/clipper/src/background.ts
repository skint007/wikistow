// The extension's background: Chrome's service worker, Firefox's
// background script (ADR 0017, decisions 4 to 7). It alone talks to the
// desktop app, so a clip waiting for the app to open or unlock goes on
// when the popup closes. It takes calls only from its own popup, over a
// port: no other extension or page can reach it. The content script it
// injects answers as the injection's result; the one message it takes is
// the area overlay's (area.ts), from the tab it was injected in, naming
// the nonce it was given there.
import { api, browserName } from './api.ts';
import type { Captured } from './capture.ts';
import {
  base64,
  CHOOSE_MS,
  cropPng,
  dataBytes,
  isAreaMessage,
  isShotMessage,
  type Area,
  type AreaMessage,
  type ShotMessage,
  type ViewSize,
} from './shot.ts';
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
  type HostKey,
  type Saved,
  type TextMode,
} from './protocol.ts';

/** How long a clip waits for the app to open or unlock, or to save it, before the extension stops waiting. */
const WAIT_MS = 10 * 60_000;
/** How long, at most, between answers while a clip is sent, the app opening included (60 s). */
const SEND_MS = 2 * 60_000;
/** How long the helper waits for an app it opens to listen (clip-host's `appWait`). */
const START_MS = 60_000;
/** How long a capture other than a link waits for the tab's page to load. */
const LOAD_MS = 30_000;
/** How long the toolbar button shows its check after a save. */
const CHECK_MS = 4_000;
/**
 * How long after the overlay's own limit (`CHOOSE_MS`) an area it took
 * may still come: its wait for the page to be drawn again, and a sleeping
 * background's wake. The overlay holds the person to its limit; this one
 * is for an overlay that can no longer say.
 */
const LATE_MS = 30_000;

/** The app found last, which searches and shows go to. */
let found: Found | null = null;
/** When `open` was sent, and to which app, until the app is heard from, or didn't open. */
let openSent: { host: HostKey; at: number } | null = null;
/** How the last clip went, as `storage.session` keeps it too. */
let current: ClipView | null = null;
let sending = false;
/** The app the clip being sent goes to, once found. */
let sendingTo: HostKey | null = null;
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

/**
 * Take `at` as how the app is now. A helper started after `open` was sent
 * can't tell that the app is on its way, and answers `closed` until it
 * listens: for as long as the helper that opened it waits, that's
 * `starting`. A clip waiting in the app waits for what it does now: to
 * start, or to be unlocked.
 */
function learn(at: Found | null): Found | null {
  if (at && openSent?.host === at.host) {
    if (at.status.app === 'closed' && Date.now() - openSent.at < START_MS) {
      at = { host: at.host, status: { type: 'status', app: 'starting' } };
    } else if (at.status.app !== 'starting') {
      openSent = null;
    }
  }
  found = at;
  if (at && at.host === sendingTo && current?.phase === 'waiting') {
    const { app } = at.status;
    const waits = app === 'locked' ? 'unlock' : app === 'starting' ? 'starting' : null;
    if (waits && waits !== current.waits) setClip({ phase: 'waiting', waits });
  }
  return at;
}

async function status(): Promise<View> {
  return viewOf(learn(await find(await pin())));
}

/** Open the app, or bring it forward, saying how it is as that changes, until it's ready. */
async function open(signal: AbortSignal): Promise<Calls['open']['result']> {
  if (!found) await status();
  if (!found) return { view: viewOf(null), failed: null };
  const { host } = found;
  const message = envelope({ type: 'open' });
  let failed: string | null = null;
  openSent = { host, at: Date.now() };
  try {
    await converse(
      HOSTS[host],
      [message],
      (answer) => {
        if (answer.id !== message.id) return false;
        if (answer.type === 'error') {
          openSent = null;
          failed = answer.message ?? 'WikiStow didn’t open.';
          return true;
        }
        if (answer.type !== 'status') return false;
        push({ push: 'view', view: viewOf(learn({ host, status: answer })) });
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

/**
 * The tab's address and title, and its selection, or null where no script
 * may run, as on the browser's own pages. The selection is what capture
 * takes (`selectedText` in capture.ts): Chromium's `toString` gives the
 * text selected in a text box, though no range of the page is selected.
 * It runs at once, not once the page has loaded, as a slow page may take a
 * while to. The title is the page's own where a script runs: a tab's is its
 * address until the page's title has come.
 */
async function probe(tabId: number): Promise<Calls['probe']['result']> {
  const tab = await api.tabs.get(tabId);
  let selection: string | null;
  let title = tab.title ?? '';
  try {
    const [ran] = await api.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: () => {
        const chosen = getSelection();
        return {
          selection: chosen && !chosen.isCollapsed ? chosen.toString() : '',
          title: document.title,
        };
      },
    });
    const got = ran?.result as { selection?: unknown; title?: unknown } | undefined;
    selection = typeof got?.selection === 'string' ? got.selection : '';
    title = typeof got?.title === 'string' ? got.title : '';
  } catch {
    selection = null;
  }
  return { url: tab.url ?? '', title, selection };
}

/** A page that hasn't loaded in `LOAD_MS`, as one that never finishes doesn't. */
class StillLoading extends Error {}

/**
 * Capture the tab in `mode`, once its page has loaded, waiting `LOAD_MS`
 * at most; a link, which needs only its address and selection, at once.
 */
async function capture(tabId: number, mode: TextMode): Promise<Captured> {
  const injectImmediately = mode === 'link';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loading = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StillLoading('The page is still loading')), LOAD_MS);
  });
  try {
    await Promise.race([
      api.scripting.executeScript({ target: { tabId }, injectImmediately, files: ['capture.js'] }),
      loading,
    ]);
    const [ran] = await Promise.race([
      api.scripting.executeScript({
        target: { tabId },
        injectImmediately,
        func: (mode: TextMode) => globalThis.wikistowCapture!(mode),
        args: [mode],
      }),
      loading,
    ]);
    if (!ran?.result) throw new Error('Nothing captured');
    return ran.result as Captured;
  } finally {
    clearTimeout(timer);
  }
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
/** Show `text` on the toolbar button: a check for a while, `!` until the popup opens. */
function badge(text: '' | '✓' | '!') {
  clearTimeout(unbadge);
  void api.action.setBadgeText({ text });
  if (text) {
    void api.action.setBadgeBackgroundColor({ color: text === '✓' ? '#1f7a45' : '#b3261e' });
  }
  if (text === '✓')
    unbadge = setTimeout(() => void api.action.setBadgeText({ text: '' }), CHECK_MS);
}

/**
 * Show `!` for a while, for a quick clip that wasn't sent as one is still
 * on its way, then what the button showed for that one.
 */
function flashBusy() {
  badge('!');
  unbadge = setTimeout(() => badge(current?.phase === 'failed' ? '!' : ''), CHECK_MS);
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

const NO_SHOT = 'WikiStow can’t take a screenshot of this page.';

/**
 * The browser's own screenshot of the tab's visible area, as a PNG data
 * URL, which `activeTab` allows for the tab the person clicked in.
 */
async function visibleArea(tab: chrome.tabs.Tab): Promise<string> {
  if (!tab.active) throw new NoShot('capture', 'Switch to that tab, then try again.');
  const url = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => '');
  if (!url.startsWith('data:image/png;base64,')) throw new NoShot('capture', NO_SHOT);
  return url;
}

/** An area dragged out in a tab of `view`'s size, and the screenshot taken as the drag started, if it's kept. */
type Part = { area: Area; view: ViewSize; shot: string | null };

/**
 * The tab as shown, as PNG base64, or the part of it under `part`, cut
 * here from the screenshot taken as the drag started, or from one taken
 * now if that one's gone.
 */
async function screenshot(tab: chrome.tabs.Tab, part: Part | null): Promise<string> {
  let png = dataBytes(part?.shot ?? (await visibleArea(tab)), 'image/png');
  if (!png) throw new NoShot('capture', NO_SHOT);
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

/**
 * The screenshot taken as the person started dragging, for the choice
 * `nonce`, in a tab of `view`'s size. Held only while the background is
 * awake, which the drag's messages keep it: one that slept meanwhile takes
 * another once the area is chosen.
 */
let areaShot: { nonce: string; url: string; view: ViewSize } | null = null;

/** Forget the area being chosen, and its screenshot. */
async function forgetChoice() {
  areaShot = null;
  await api.storage.session.remove('choosing');
}

/** Take the overlay for `nonce` off `tabId`, if it's still there, once the page is drawn again without it. */
async function stopOverlay(tabId: number, nonce: string) {
  await api.scripting
    .executeScript({
      target: { tabId },
      func: (nonce: string) => globalThis.wikistowAreaStop?.(nonce),
      args: [nonce],
    })
    .catch(() => {});
}

/** Stop choosing an area, taking the overlay off its page, which is drawn again without it once this is done. */
async function stopChoosing() {
  const was = await choosing();
  if (!was) return;
  await forgetChoice();
  await stopOverlay(was.tabId, was.nonce);
}

/**
 * Put the overlay on the tab, for the person to drag out an area. It asks
 * for the screenshot as the drag starts (`shootArea`), and names `nonce`
 * once the area's dragged out (`areaChosen`).
 */
async function choose(tabId: number, form: Form) {
  await stopChoosing();
  const nonce = crypto.randomUUID();
  const next: Choosing = { nonce, tabId, form, until: Date.now() + CHOOSE_MS + LATE_MS };
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
  if (started === 'choosing') {
    // Settled meanwhile by the overlay's own message, or a newer clip took
    // over, whose state stands: an overlay left on the page goes.
    if ((await choosing())?.nonce !== nonce) return stopOverlay(tabId, nonce);
    return setClip({ phase: 'choosing' });
  }
  if ((await choosing())?.nonce !== nonce) return;
  await forgetChoice();
  if (started === 'zoomed') {
    return fail('capture', 'Pinch the page back to its usual size, then choose an area.');
  }
  fail('capture', NO_SHOT);
}

/** The tab the overlay's message came from: its page's top frame, never one of the extension's own. */
function overlayTab(sender: chrome.runtime.MessageSender): number | null {
  if (sender.id !== api.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined) {
    return null;
  }
  if (!sender.url || sender.url.startsWith(api.runtime.getURL(''))) return null;
  return sender.tab.id;
}

/**
 * The overlay asks, as the person starts dragging, with nothing of its own
 * shown: the visible area's screenshot, kept for the area to be cut from.
 * Done once it's taken, or couldn't be: then one's taken after the drag.
 */
async function shootArea(message: ShotMessage, tabId: number) {
  const was = await choosing();
  if (!was || was.nonce !== message.nonce || was.tabId !== tabId) return;
  let url: string;
  try {
    url = await visibleArea(await api.tabs.get(tabId));
  } catch {
    return;
  }
  // Still this choice: one stopped meanwhile keeps no screenshot.
  if ((await choosing())?.nonce !== message.nonce) return;
  areaShot = { nonce: message.nonce, url, view: message.view };
}

/**
 * The overlay's message: the area the person dragged out, or that they
 * stopped, or that the page did. Done once the clip shows how it goes: the
 * sending itself goes on after.
 */
async function areaChosen(message: AreaMessage, tabId: number) {
  const was = await choosing();
  if (!was || was.nonce !== message.nonce || was.tabId !== tabId) return;
  const kept = areaShot?.nonce === was.nonce ? areaShot : null;
  await forgetChoice();
  if (message.blocked) {
    return fail('capture', 'This page stopped Choose an area from working. Try Visible area.');
  }
  if (!message.area || Date.now() > was.until) return clearClip();
  // Cut from a screenshot of a tab the same size only: one resized since
  // is laid out anew, so the area is cut from one taken now.
  const same = kept?.view.width === message.view.width && kept.view.height === message.view.height;
  void send(was.tabId, was.form, {
    area: message.area,
    view: message.view,
    shot: same ? kept.url : null,
  });
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
 * screenshot is taken as the overlay opens (`choose`), and cut and sent
 * here once the person has dragged it out (`part`).
 */
async function send(tabId: number, form: Form, part: Part | null = null) {
  // The clip on its way stays the one shown, which the popup waits on.
  if (sending) return flashBusy();
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
      } catch (error) {
        // A link needs no script: the browser's own pages, or one too busy
        // to answer, can still be linked.
        if (form.mode !== 'link') {
          return fail(
            'capture',
            error instanceof StillLoading
              ? 'This page is still loading. Try again once it has, or try Link.'
              : 'WikiStow can’t clip this page. Try Link.',
          );
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
    sendingTo = at?.host ?? null;
    push({ push: 'view', view: viewOf(learn(at)) });
    if (!at) return fail('missing', 'Clipping needs the WikiStow desktop app on this computer.');
    if (!speaks(at.status)) return fail('version', 'Update WikiStow or the extension to clip.');
    if (at.status.app === 'signed-out') return fail('signed-out', 'Sign in to WikiStow first.');
    const opening = at.status.app === 'closed' ? envelope({ type: 'open' }) : null;
    if (opening) {
      openSent = { host: at.host, at: Date.now() };
      setClip({ phase: 'waiting', waits: 'starting' });
    }

    let accepted = false;
    try {
      await converse(
        HOSTS[at.host],
        opening ? [opening, message] : [message],
        (answer, conversation) => {
          if (opening && answer.id === opening.id) {
            if (answer.type === 'status') {
              push({ push: 'view', view: viewOf(learn({ host: at.host, status: answer })) });
            } else if (answer.type === 'error') {
              openSent = null;
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
              openSent = null;
              fail('closed', 'WikiStow didn’t open. Open it, then try again.');
              return true;
            default:
              return false;
          }
        },
        { ms: SEND_MS },
      );
    } catch (error) {
      if (error instanceof TimedOut && accepted) {
        const waits = current?.phase === 'waiting' ? current.waits : null;
        return setClip({ phase: 'still-waiting', waits });
      }
      if (error instanceof HostGone && !error.answered) {
        return fail('missing', 'Clipping needs the WikiStow desktop app on this computer.');
      }
      return fail('failed', 'The connection to WikiStow closed before the clip was saved.');
    }
  } catch {
    fail('failed', 'WikiStow couldn’t save the clip.');
  } finally {
    sending = false;
    sendingTo = null;
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

/** A message from the area overlay, the only one the background takes. */
async function fromOverlay(message: unknown, sender: chrome.runtime.MessageSender) {
  const tabId = overlayTab(sender);
  if (tabId === null) return;
  if (isShotMessage(message)) return shootArea(message, tabId);
  if (isAreaMessage(message)) return areaChosen(message, tabId);
}

api.runtime.onMessage.addListener((message, sender, respond) => {
  // Answered once taken: the overlay draws its box once its screenshot is,
  // and counts as shown until its area is (`overlayShown`).
  const answered = () => respond(null);
  void fromOverlay(message, sender).then(answered, answered);
  return true;
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
    // Read first: a clip started meanwhile, as the shortcut can as the popup opens, stands.
    const kept = (await session()).clip ?? null;
    current ??= kept;
    // An overlay that went with its page, or gave up, leaves nothing to
    // wait for, unless its message has settled the choice meanwhile.
    if (current?.phase === 'choosing') {
      const was = await choosing();
      if (!was || Date.now() > was.until || !(await overlayShown(was.tabId))) {
        const still = await choosing();
        if (still?.nonce === was?.nonce && current?.phase === 'choosing') {
          await forgetChoice();
          clearClip();
        }
      }
    }
    // A failure's `!` has been seen once the popup opens.
    if (current?.phase === 'failed') badge('');
    port.postMessage({ push: 'clip', clip: current });
  })();
});

/**
 * Firefox opens the popup only while it handles the person's click or key,
 * before anything is awaited. Chrome opens it after a wait too.
 */
const OPENS_POPUP_AT_ONCE = browserName() === 'firefox';

/**
 * Send without the popup, from the context menu or the shortcut, to the
 * folder the last clip went to. Before there is one, open the popup. On
 * Firefox it's asked at once when the folder isn't known yet: when there's
 * none, or when the background has just woken for this and not yet read it
 * from `storage.session`. With one read then, the clip goes too, and the
 * popup shows it going.
 */
async function quick(tab: chrome.tabs.Tab | undefined, mode: 'link' | 'either') {
  const opened =
    lastFolder === null || (lastFolder === undefined && OPENS_POPUP_AT_ONCE)
      ? api.action.openPopup()
      : null;
  opened?.catch(() => {});
  const noFolder = () =>
    fail('no-folder', 'Choose a folder here first. Then the menu and the shortcut send to it.');
  if (lastFolder === null) return opened!.catch(noFolder);
  const tabId = tab?.id ?? (await api.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  lastFolder ??= (await session()).lastFolder ?? null;
  if (!lastFolder) return (opened ?? api.action.openPopup()).catch(noFolder);
  if (tabId === undefined) return;
  let chosen: TextMode = 'link';
  if (mode === 'either') chosen = (await probe(tabId)).selection?.trim() ? 'selection' : 'link';
  await send(tabId, { mode: chosen, title: '', note: '', tags: [], folder: lastFolder });
}

const MENU = { link: 'send-link', selection: 'send-selection' } as const;

function menuClicked(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  if (info.menuItemId === MENU.link) return quick(tab, 'link');
  // The browser offers it for text selected in a text box too, which
  // isn't a selection of the page to capture: then the link goes.
  if (info.menuItemId === MENU.selection) return quick(tab, 'either');
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
// so the last folder is read by then, and a click sends without the popup.
// A shortcut has no such warning: pressed while Firefox's background
// sleeps, it opens the popup, as `quick` says. Chrome has no `onShown`.
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

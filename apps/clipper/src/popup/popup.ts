// The toolbar button's popup (ADR 0017, decisions 6 and 7; ui-design.md,
// Web clipper): the mode, the title, a note for a link, tags and the
// folder, then Save to WikiStow. It asks the background for everything,
// which talks to the app; folder names it hears stay in this page, and the
// last folder only in `storage.session`. What the person typed survives
// the popup closing only in `storage.session`, which goes with the browser.
import { api } from '../api.ts';
import {
  POPUP_PORT,
  type Call,
  type CallName,
  type Calls,
  type ClipView,
  type Draft,
  type FromBackground,
  type LocalState,
  type Probe,
  type SessionState,
  type View,
} from '../messages.ts';
import { parseTags, type ClipMode, type Folder } from '../protocol.ts';

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const notice = element('notice');
const noticeText = element('notice-text');
const noticeAction = element<HTMLButtonElement>('notice-action');
const install = element('install');
const result = element('result');
const resultText = element('result-text');
const resultDetail = element('result-detail');
const openDraft = element<HTMLButtonElement>('open-draft');
const form = element<HTMLFormElement>('form');
const titleInput = element<HTMLInputElement>('title');
const noteField = element('note-field');
const noteInput = element<HTMLTextAreaElement>('note');
const tagsInput = element<HTMLInputElement>('tags');
const search = element<HTMLInputElement>('folder-search');
const list = element('folders');
const folderNote = element('folder-note');
const save = element<HTMLButtonElement>('save');
const modes = [...form.querySelectorAll<HTMLInputElement>('input[name=mode]')];
const hosts = [...document.querySelectorAll<HTMLInputElement>('input[name=host]')];

let nextId = 1;
/** Calls waiting for their answer, each with what it sent. */
const pending = new Map<number, { resolve: (result: unknown) => void; sent: Call }>();
let port: chrome.runtime.Port | null = null;

/**
 * The port to the background, opened again if it closed: Chrome stops an
 * idle service worker even while a popup's port is open, which closes it.
 * Calls still unanswered go again on the new one, save a `save`, which
 * the background answers as it starts and mustn't send twice.
 */
function background(): chrome.runtime.Port {
  if (port) return port;
  const opened = api.runtime.connect({ name: POPUP_PORT });
  port = opened;
  opened.onMessage.addListener(heard);
  opened.onDisconnect.addListener(() => {
    if (port === opened) port = null;
    for (const [id, { resolve, sent }] of pending) {
      if (sent.call !== 'save') {
        background().postMessage(sent);
        continue;
      }
      pending.delete(id);
      resolve(null);
    }
  });
  return opened;
}

/** Ask the background, and take its answer. */
function call<K extends CallName>(name: K, args: Calls[K]['args']): Promise<Calls[K]['result']> {
  const id = nextId++;
  const sent = { id, call: name, ...args } as Call;
  return new Promise((resolve) => {
    pending.set(id, { resolve: resolve as (result: unknown) => void, sent });
    background().postMessage(sent);
  });
}

let tabId: number | undefined;
let probed: Probe = { url: '', title: '', selection: null };
let view: View | null = null;
let clip: ClipView | null = null;
/** The folder the clip goes to, and those offered for the search typed. */
let chosen: Folder | null = null;
let offered: Folder[] = [];
let searchError: string | null = null;
let openFailed: string | null = null;

const inFlight = () => clip?.phase === 'sending' || clip?.phase === 'waiting';
const mode = (): ClipMode =>
  (modes.find((input) => input.checked)?.value as ClipMode | undefined) ?? 'link';
const samePlace = (a: Folder, b: Folder) => a.spaceId === b.spaceId && a.folderId === b.folderId;

function showNotice(text: string, action: string | null = null) {
  notice.hidden = false;
  noticeText.textContent = text;
  noticeAction.hidden = action === null;
  noticeAction.textContent = action ?? '';
}

/** What the popup says about the app, and what it offers, as the app is. */
function render() {
  install.hidden = true;
  notice.hidden = true;
  if (!view) return showNotice('Looking for WikiStow…');
  if (view.app === 'missing') {
    form.hidden = true;
    showNotice('Clipping needs the WikiStow desktop app on this computer.');
    install.hidden = false;
    return;
  }
  if (view.app === 'version') {
    form.hidden = true;
    return showNotice(
      view.update === 'app'
        ? 'This WikiStow is too old for the extension. Update WikiStow to clip.'
        : 'This WikiStow is newer than the extension. Update the extension to clip.',
    );
  }
  form.hidden = tabId === undefined;
  if (view.app === 'closed') showNotice(openFailed ?? 'WikiStow is closed.', 'Open WikiStow');
  else if (view.app === 'starting') showNotice('Opening WikiStow…');
  else if (view.app === 'signed-out')
    showNotice('Sign in to WikiStow first.', 'Switch to WikiStow');
  else if (view.app === 'locked') {
    showNotice(
      chosen ? 'Switch to WikiStow to unlock.' : 'Unlock WikiStow to choose a folder.',
      'Switch to WikiStow',
    );
  } else if (view.offline) showNotice('Offline: saved once WikiStow is back online.');
  renderFolders();
  renderForm();
}

function renderForm() {
  const selection = probed.selection?.trim() ?? '';
  for (const input of modes) {
    input.disabled =
      (input.value === 'selection' && !selection) ||
      (input.value !== 'link' && probed.selection === null);
  }
  if (modes.find((input) => input.checked)?.disabled) {
    modes.find((input) => input.value === 'link')!.checked = true;
  }
  noteField.hidden = mode() !== 'link';
  const app = view && 'host' in view ? view.app : null;
  save.disabled =
    !chosen || inFlight() || app === null || app === 'signed-out' || tabId === undefined;
}

function renderFolders() {
  const ready = view?.app === 'ready';
  search.disabled = !ready;
  const shown = ready ? [...offered] : [];
  if (chosen && !shown.some((one) => samePlace(one, chosen!))) shown.unshift(chosen);
  list.replaceChildren(
    ...shown.map((folder) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'folder';
      input.checked = chosen !== null && samePlace(folder, chosen);
      input.addEventListener('change', () => {
        chosen = folder;
        render();
      });
      const path = document.createElement('span');
      // Text only: a folder's name is the person's, never markup.
      path.textContent = folder.path || 'The space’s top';
      label.append(input, path);
      return label;
    }),
  );
  let note: string | null = null;
  if (!ready && !chosen) {
    note =
      view?.app === 'signed-out'
        ? 'Sign in to WikiStow to choose a folder.'
        : view?.app === 'locked'
          ? null
          : 'Open WikiStow to choose a folder.';
  } else if (ready && searchError) note = searchError;
  else if (ready && shown.length === 0) {
    note = search.value.trim()
      ? 'No folder you can add pages to matches.'
      : 'Type to find a folder.';
  }
  folderNote.hidden = note === null;
  folderNote.textContent = note ?? '';
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

function renderClip() {
  result.hidden = clip === null;
  openDraft.hidden = true;
  resultDetail.hidden = true;
  result.dataset['tone'] = clip?.phase ?? '';
  if (!clip) return;
  switch (clip.phase) {
    case 'sending':
      resultText.textContent = 'Sending to WikiStow…';
      break;
    case 'waiting':
      resultText.textContent =
        clip.waits === 'starting'
          ? 'Opening WikiStow… The clip saves once it’s open.'
          : 'Switch to WikiStow to unlock. The clip saves once it’s unlocked.';
      break;
    case 'still-waiting':
      resultText.textContent = 'Still waiting in WikiStow. It saves the clip once it’s unlocked.';
      break;
    case 'saved': {
      const { saved } = clip;
      resultText.textContent = saved.path ? `Saved to ${saved.path}` : 'Saved to WikiStow';
      openDraft.hidden = false;
      const details: string[] = [];
      if (!saved.faithful)
        details.push('Some of it may look different from the site. Check the draft.');
      if (saved.images.skipped > 0) {
        const count = saved.images.skipped;
        details.push(
          `${count} ${plural(count, 'image', 'images')} couldn’t be saved, and ${plural(count, 'links', 'link')} to the site instead.`,
        );
      }
      resultDetail.hidden = details.length === 0;
      resultDetail.textContent = details.join(' ');
      break;
    }
    case 'failed':
      resultText.textContent = clip.message;
      break;
  }
}

/** Keep what the person typed for this page, for this browser session. */
function keepDraft() {
  if (!probed.url) return;
  const draft: Draft = {
    url: probed.url,
    mode: mode(),
    title: titleInput.value,
    note: noteInput.value,
    tags: tagsInput.value,
  };
  void api.storage.session.set({ draft });
}

let searched = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
async function findFolders(query: string) {
  const asked = ++searched;
  const found = await call('folders', { query });
  if (asked !== searched) return;
  if ('error' in found) {
    offered = [];
    searchError =
      found.error === 'locked'
        ? 'Unlock WikiStow to choose a folder.'
        : found.error === 'busy'
          ? 'That’s a lot of searches. Wait a moment, then type again.'
          : 'WikiStow didn’t answer. Try again.';
  } else {
    searchError = null;
    offered = query.trim() ? found.matches : found.recent;
    chosen ??= found.recent[0] ?? null;
  }
  render();
}

let polling: ReturnType<typeof setTimeout> | undefined;
/** Show how the app is; while it's on its way to ready, look again every few seconds. */
function showView(next: View) {
  const wasReady = view?.app === 'ready';
  view = next;
  if (next.app === 'ready' && !wasReady) void findFolders(search.value);
  clearTimeout(polling);
  if (next.app === 'locked' || next.app === 'signed-out' || next.app === 'starting') {
    polling = setTimeout(() => void call('status', {}).then(showView), 2_000);
  }
  render();
}

function heard(message: FromBackground) {
  if ('id' in message) {
    pending.get(message.id)?.resolve(message.result);
    pending.delete(message.id);
  } else if (message.push === 'view') {
    showView(message.view);
  } else {
    clip = message.clip;
    renderClip();
    renderForm();
  }
}

noticeAction.addEventListener('click', async () => {
  noticeAction.disabled = true;
  openFailed = null;
  const opened = await call('open', {});
  noticeAction.disabled = false;
  openFailed = opened.failed;
  showView(opened.view);
});

openDraft.addEventListener('click', async () => {
  if (clip?.phase !== 'saved') return;
  const { shown } = await call('show', { spaceId: clip.saved.spaceId, pageId: clip.saved.pageId });
  if (shown) return window.close();
  resultDetail.hidden = false;
  resultDetail.textContent = 'WikiStow can open only a page clipped since it opened.';
});

search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void findFolders(search.value), 200);
});

for (const input of [titleInput, noteInput, tagsInput]) input.addEventListener('input', keepDraft);
for (const input of modes) {
  input.addEventListener('change', () => {
    keepDraft();
    renderForm();
  });
}

for (const input of hosts) {
  input.addEventListener('change', async () => {
    const host = input.value as NonNullable<LocalState['host']>;
    await api.storage.local.set({ host } satisfies LocalState);
    view = null;
    render();
    showView(await call('status', {}));
  });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!chosen || tabId === undefined || save.disabled) return;
  void call('save', {
    tabId,
    form: {
      mode: mode(),
      title: titleInput.value,
      note: mode() === 'link' ? noteInput.value : '',
      tags: parseTags(tagsInput.value),
      folder: chosen,
    },
  });
});

async function start() {
  // A tab named in the address, as the tests open this page in a tab of
  // its own; otherwise the tab the toolbar button was clicked in.
  const named = Number(new URLSearchParams(location.search).get('tab'));
  if (Number.isInteger(named) && named > 0) tabId = named;
  else tabId = (await api.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  const [kept, local] = await Promise.all([
    api.storage.session.get(['draft', 'lastFolder']) as Promise<SessionState>,
    api.storage.local.get('host') as Promise<LocalState>,
  ]);
  for (const input of hosts) input.checked = input.value === (local.host ?? 'auto');
  chosen = kept.lastFolder ?? null;
  if (tabId !== undefined) probed = await call('probe', { tabId });
  const draft = kept.draft?.url === probed.url ? kept.draft : null;
  titleInput.value = draft?.title ?? probed.title;
  noteInput.value = draft?.note ?? '';
  tagsInput.value = draft?.tags ?? '';
  const first: ClipMode =
    draft?.mode ??
    (probed.selection?.trim() ? 'selection' : probed.selection === null ? 'link' : 'article');
  for (const input of modes) input.checked = input.value === first;
  render();
  showView(await call('status', {}));
}

void start();

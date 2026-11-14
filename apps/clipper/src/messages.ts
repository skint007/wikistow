// What the popup and the background say to each other, over the port the
// popup opens (`api.runtime.connect({ name: POPUP_PORT })`). The popup
// calls; the background answers each call by its `id`, and tells every
// open popup how the app and the clip are as they change.
import type { AppState, ClipMode, ErrorCode, Folder, HostKey, Saved } from './protocol.ts';

export const POPUP_PORT = 'popup';

/** How the app is, as the popup shows it (ADR 0017, decision 7). */
export type View =
  | { app: 'missing' }
  | { app: 'version'; update: 'app' | 'extension' }
  | { app: AppState; offline: boolean; host: HostKey };

/** Why a clip wasn't saved: the app's codes, and the extension's own. */
export type Failure = ErrorCode | 'too-long' | 'capture' | 'missing' | 'closed';

/** How the clip last sent is going. */
export type ClipView =
  | { phase: 'sending' }
  | { phase: 'waiting'; waits: 'starting' | 'unlock' }
  | { phase: 'still-waiting' }
  | { phase: 'saved'; saved: Saved }
  | { phase: 'failed'; code: Failure; message: string };

/** What the person filled in. */
export type Form = {
  mode: ClipMode;
  title: string;
  note: string;
  tags: string[];
  folder: Folder;
};

/** The tab, as the popup offers to clip it. `selection` is null where no script may run. */
export type Probe = { url: string; title: string; selection: string | null };

export type Folders =
  | { recent: Folder[]; matches: Folder[] }
  | { error: ErrorCode | 'missing' | 'closed' };

/** Each call: what it takes, and its answer. */
export type Calls = {
  status: { args: object; result: View };
  /**
   * Open the app, or bring it forward; `view` pushes follow as it changes.
   * `failed` says why it couldn't be opened.
   */
  open: { args: object; result: { view: View; failed: string | null } };
  folders: { args: { query: string }; result: Folders };
  probe: { args: { tabId: number }; result: Probe };
  /** Answered once sent; how it goes comes as `clip` pushes. */
  save: { args: { tabId: number; form: Form }; result: null };
  show: { args: { spaceId: string; pageId: string }; result: { shown: boolean } };
};
export type CallName = keyof Calls;

export type Call = {
  [K in CallName]: { id: number; call: K } & Calls[K]['args'];
}[CallName];

export type FromBackground =
  | { id: number; result: unknown }
  | { push: 'view'; view: View }
  | { push: 'clip'; clip: ClipView | null };

/** What the extension keeps in `storage.session`: memory only, gone when the browser closes. */
export type SessionState = {
  /** The folder the last clip went to, which the context menu and shortcut send to. */
  lastFolder?: Folder;
  /** How the last clip went, for a popup opened afterwards. */
  clip?: ClipView;
  /** What the person typed for a page, kept if the popup closes before it's sent. */
  draft?: Draft;
};

export type Draft = { url: string; mode: ClipMode; title: string; note: string; tags: string };

/** What it keeps in `storage.local`, on disk: settings only, never a folder's name. */
export type LocalState = { host?: HostKey | 'auto' };

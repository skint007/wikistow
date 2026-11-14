// What the extension and the desktop app say to each other through
// wikistow-clip-host (ADR 0017, decision 4). The app checks every message
// against its own schemas (apps/desktop/src/clip/protocol.ts); these are
// the extension's side of them. Each message has `v`, an `id` its answers
// repeat, and a `type`.

/** The protocol version this extension speaks. */
export const PROTOCOL = 1;

/** The native messaging hosts, stable first: one extension serves both apps. */
export const HOSTS = {
  stable: 'io.github.skint007.wikistow',
  beta: 'io.github.skint007.wikistow_beta',
} as const;
export type HostKey = keyof typeof HOSTS;

/** The most a `clip` may be as JSON, which the app takes; larger is refused here, before sending. */
export const MAX_MESSAGE_BYTES = 48 * 1024 * 1024;
/** At most this much HTML, or text, in a clip. */
export const MAX_CLIP_CHARS = 16 * 1024 * 1024;
/** A screenshot's base64, at most: 24 MiB of image (ADR 0017, decision 4). */
export const MAX_SCREENSHOT_CHARS = 32 * 1024 * 1024;
export const MAX_TITLE = 500;
/** A byline or a site's name, at most. */
export const MAX_NAME = 500;
/** A tab's address, at most. */
export const MAX_URL = 32 * 1024;
export const MAX_NOTE = 10_000;
export const MAX_TAGS = 20;
export const MAX_TAG = 100;
export const MAX_QUERY = 200;

export type AppState = 'closed' | 'starting' | 'signed-out' | 'locked' | 'ready';

export type Status = {
  type: 'status';
  app: AppState;
  /** Only from the app itself; the helper says `closed` and `starting` alone. */
  offline?: boolean;
  appVersion?: string;
  protocols?: { min: number; max: number };
};

/** A folder the app offers: its path is the app's to show, kept only for this session. */
export type Folder = { spaceId: string; folderId: string | null; path: string };

export type ErrorCode =
  | 'version'
  | 'invalid'
  | 'too-large'
  | 'signed-out'
  | 'locked'
  | 'no-folder'
  | 'not-allowed'
  | 'busy'
  | 'failed';

/** The modes the content script captures as HTML or text. */
export type TextMode = 'link' | 'selection' | 'article' | 'page';
export type ClipMode = TextMode | 'screenshot';

export type Saved = {
  type: 'saved';
  spaceId: string;
  pageId: string;
  title: string;
  path: string;
  images: { saved: number; skipped: number };
  faithful: boolean;
};

/** Any answer, from the app or the helper. */
export type Answer = { v: number; id?: string } & (
  | Status
  | { type: 'folders'; recent: Folder[]; matches: Folder[] }
  | { type: 'accepted'; waits: null | 'starting' | 'unlock' }
  | Saved
  | { type: 'shown' }
  | { type: 'error'; code: ErrorCode; message?: string; min?: number; max?: number }
);

/** What a clip carries, as the app's schema takes it. */
export type Clip = {
  mode: ClipMode;
  url: string;
  title: string;
  note: string;
  tags: string[];
  html: string;
  text: string;
  byline: string | null;
  siteName: string | null;
  folder: { spaceId: string; folderId: string | null };
  /** A screenshot's PNG as base64, in `screenshot` mode alone, which has no HTML or text. */
  screenshot?: string;
};

export type Request =
  | { type: 'hello'; extension: string; browser: string }
  | { type: 'open' }
  | { type: 'folders'; query: string }
  | ({ type: 'clip' } & Clip)
  | { type: 'show'; spaceId: string; pageId: string };

/** A message to send: the request with its version and a fresh ID. */
export const envelope = <R extends Request>(request: R) => ({
  v: PROTOCOL,
  id: crypto.randomUUID(),
  ...request,
});

/** The tags the person typed, split at commas, each once, within the app's limits. */
export function parseTags(typed: string): string[] {
  const tags = typed
    .split(',')
    .map((tag) => tag.trim().slice(0, MAX_TAG))
    .filter(Boolean);
  return [...new Set(tags)].slice(0, MAX_TAGS);
}

/** Whether the app takes this extension's protocol version. */
export const speaks = (status: Status) =>
  !status.protocols || (status.protocols.min <= PROTOCOL && PROTOCOL <= status.protocols.max);

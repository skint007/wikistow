// What main does with the extension's clips, folder searches and shows
// (ADR 0017, step 4), between the socket and the page. Main holds each
// clip in memory until the page says how saving it went, so a reload or a
// lock in between loses nothing, and never writes one to disk. It knows
// the vault's state only as the page tells it (`setPageState`), and asks
// the page for folders and drafts, as the keys are there. Clips, searches
// and images are limited here, whatever the page does.
import {
  DESKTOP_CHANNELS,
  FolderId,
  PageId,
  SpaceId,
  type ClipFolders,
  type ClipImage,
  type ClipOutcome,
  type ClippedPage,
  type ClipPageState,
  type ClipRequest,
  type DesktopClip,
} from '@wikistow/contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AddressKind } from './addresses.ts';
import { MAX_IMAGE_BYTES, type imageFetcher } from './images.ts';
import type { ClipConnection } from './listener.ts';
import type { ClipAppState, ClipMessage, ErrorCode, Message } from './protocol.ts';

/** Clips accepted in a minute, at most (ADR 0017, decision 3). */
export const CLIPS_PER_MINUTE = 30;
/** Folder searches answered in a minute, at most. */
export const SEARCHES_PER_MINUTE = 60;
/** Images fetched in a minute, at most, across clips. */
export const IMAGES_PER_MINUTE = 200;
/** Images one clip may ask for, and their bytes in all. */
export const IMAGES_PER_CLIP = 50;
export const IMAGE_BYTES_PER_CLIP = 100 * 1024 * 1024;
/** How long a clip's images may take in all, from its first, so a slow site can't hold the one clip. */
export const IMAGES_MS = 2 * 60_000;
/** Answers to the extension name at most this many folders, paths cut this short. */
const RECENT_FOLDERS = 5;
const MATCHED_FOLDERS = 50;
const PATH_CHARS = 200;
/** How long the page has to answer a folder search. */
const SEARCH_MS = 5_000;
/** Settings lists this session's last ten clips. */
const RECENT_CLIPS = 10;
const MINUTE = 60_000;

/** The window's page, as main reaches it: Electron's `webContents`. */
export type PageContents = {
  send(channel: string, ...args: unknown[]): void;
  on(event: 'did-navigate' | 'render-process-gone' | 'destroyed', listener: () => void): unknown;
};

export type DeskOptions = {
  /** What main knows itself: the page is loading, or there's a session or none. */
  session: () => 'starting' | 'signed-out' | 'signed-in';
  /** Bring the window forward. */
  show: () => void;
  fetcher: ReturnType<typeof imageFetcher>;
  now?: () => number;
  searchMs?: number;
};

type Held = {
  clip: DesktopClip;
  /** The extension's ID for it, and its connection, while that's open. */
  messageId: string;
  connection: ClipConnection;
  images: number;
  bytes: number;
  allowed: Promise<Set<AddressKind>> | null;
  /** When its images must be fetched by, once one was asked for. */
  imagesBy: number | null;
  /** Its image fetches, one after another, so its bytes are counted before the next. */
  fetching: Promise<unknown>;
  /** Ends its image fetches once it's done. */
  done: AbortController;
};

const Folder = z.strictObject({
  spaceId: SpaceId,
  folderId: FolderId.nullable(),
  path: z.string().max(100_000),
});
const Folders = z.strictObject({ recent: z.array(Folder), matches: z.array(Folder) });
const Outcome = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    spaceId: SpaceId,
    pageId: PageId,
    title: z.string().max(10_000),
    path: z.string().max(100_000),
    images: z.strictObject({
      saved: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
    faithful: z.boolean(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['too-large', 'no-folder', 'not-allowed', 'failed']),
    message: z.string().max(1_000),
  }),
]);
const Made = z.strictObject({ spaceId: SpaceId, pageId: PageId, path: z.string().max(100_000) });
export const PageState = z.strictObject({
  vault: z.enum(['locked', 'unlocked']),
  offline: z.boolean(),
});

/** `text` cut to `chars`, ending with an ellipsis where it was cut. */
const cut = (text: string, chars: number) =>
  text.length > chars ? `${text.slice(0, chars - 1)}…` : text;

/** A rate limit over the last minute: `take` counts one, if there's room. */
function perMinute(max: number, now: () => number) {
  const times: number[] = [];
  return {
    take(): boolean {
      const since = now() - MINUTE;
      while (times.length > 0 && times[0]! <= since) times.shift();
      if (times.length >= max) return false;
      times.push(now());
      return true;
    },
  };
}

export function clipDesk(options: DeskOptions) {
  const now = options.now ?? Date.now;
  const clips = perMinute(CLIPS_PER_MINUTE, now);
  const searchLimit = perMinute(SEARCHES_PER_MINUTE, now);
  const imageLimit = perMinute(IMAGES_PER_MINUTE, now);
  let contents: PageContents | null = null;
  /** What the page said, since it last loaded. */
  let page: ClipPageState | null = null;
  const held = new Map<string, Held>();
  const searches = new Map<string, (folders: ClipFolders | null) => void>();
  const recent: ClippedPage[] = [];
  /** Drafts clipped this session, which `show` opens and no others. */
  const clipped = new Set<string>();

  function state(): ClipAppState {
    const session = options.session();
    if (session !== 'signed-in') return session;
    if (!page) return 'starting';
    return page.vault === 'unlocked' ? 'ready' : 'locked';
  }

  const ask = (request: ClipRequest) => contents?.send(DESKTOP_CHANNELS.onClipRequest, request);

  const refuse = (connection: ClipConnection, id: string, code: ErrorCode, message: string) =>
    connection.reply({ id, type: 'error', code, message });

  function clip(message: ClipMessage, connection: ClipConnection) {
    const at = state();
    if (at === 'signed-out') {
      return refuse(connection, message.id, 'signed-out', 'Sign in to WikiStow first.');
    }
    if (held.size > 0) {
      return refuse(connection, message.id, 'busy', 'WikiStow is still saving another clip.');
    }
    if (!clips.take()) {
      return refuse(
        connection,
        message.id,
        'busy',
        'That’s a lot of clips. Wait a minute and try again.',
      );
    }
    const waits = at === 'ready' ? null : at === 'starting' ? 'starting' : 'unlock';
    const desk: DesktopClip = {
      id: randomUUID(),
      mode: message.mode,
      url: message.url,
      title: message.title,
      note: message.note,
      tags: message.tags,
      html: message.html,
      text: message.text,
      byline: message.byline,
      folder: { spaceId: message.folder.spaceId, folderId: message.folder.folderId },
      waited: waits !== null,
      made: null,
    };
    held.set(desk.id, {
      clip: desk,
      messageId: message.id,
      connection,
      images: 0,
      bytes: 0,
      allowed: null,
      imagesBy: null,
      fetching: Promise.resolve(),
      done: new AbortController(),
    });
    connection.reply({ id: message.id, type: 'accepted', waits });
    if (waits === 'unlock') options.show();
    ask({ kind: 'clip', clip: desk });
  }

  async function folders(id: string, query: string, connection: ClipConnection) {
    const at = state();
    if (at === 'signed-out')
      return refuse(connection, id, 'signed-out', 'Sign in to WikiStow first.');
    if (at !== 'ready' || !contents) {
      return refuse(connection, id, 'locked', 'Unlock WikiStow to choose a folder.');
    }
    if (!searchLimit.take()) {
      return refuse(connection, id, 'busy', 'Too many searches. Wait a minute and try again.');
    }
    const requestId = randomUUID();
    const answer = await new Promise<ClipFolders | null | 'late'>((resolve) => {
      const timer = setTimeout(() => resolve('late'), options.searchMs ?? SEARCH_MS);
      searches.set(requestId, (found) => {
        clearTimeout(timer);
        resolve(found);
      });
      ask({ kind: 'folders', id: requestId, query });
    });
    searches.delete(requestId);
    if (answer === 'late') return refuse(connection, id, 'failed', 'WikiStow didn’t answer.');
    if (!answer) return refuse(connection, id, 'locked', 'Unlock WikiStow to choose a folder.');
    const shown = (folder: ClipFolders['recent'][number]) => ({
      spaceId: folder.spaceId,
      folderId: folder.folderId,
      path: cut(folder.path, PATH_CHARS),
    });
    connection.reply({
      id,
      type: 'folders',
      recent: answer.recent.slice(0, RECENT_FOLDERS).map(shown),
      matches: answer.matches.slice(0, MATCHED_FOLDERS).map(shown),
    });
  }

  function show(id: string, spaceId: SpaceId, pageId: PageId, connection: ClipConnection) {
    if (!clipped.has(`${spaceId}/${pageId}`)) {
      return refuse(
        connection,
        id,
        'not-allowed',
        'Only a page clipped since WikiStow opened can be shown.',
      );
    }
    options.show();
    ask({ kind: 'show', spaceId, pageId });
    connection.reply({ id, type: 'shown' });
  }

  async function fetchFor(one: Held, url: string): Promise<ClipImage> {
    if (one.done.signal.aborted) return { ok: false, reason: 'refused' };
    one.imagesBy ??= now() + IMAGES_MS;
    const left = IMAGE_BYTES_PER_CLIP - one.bytes;
    const time = one.imagesBy - now();
    if (one.images >= IMAGES_PER_CLIP || left <= 0 || time <= 0 || !imageLimit.take()) {
      return { ok: false, reason: 'limit' };
    }
    one.images += 1;
    one.allowed ??= options.fetcher.allowedFor(one.clip.url);
    const maxBytes = Math.min(MAX_IMAGE_BYTES, left);
    const answer = await options.fetcher.fetchImage(url, {
      allowed: await one.allowed,
      page: one.clip.url,
      maxBytes,
      signal: AbortSignal.any([one.done.signal, AbortSignal.timeout(time)]),
    });
    if (answer.ok) one.bytes += answer.bytes.length;
    // Past what's left of the clip's, not the image's own.
    if (!answer.ok && answer.reason === 'too-large' && maxBytes < MAX_IMAGE_BYTES) {
      return { ok: false, reason: 'limit' };
    }
    return answer;
  }

  /** End a held clip, telling the extension if it's still there. */
  function finish(one: Held, answer: Record<string, unknown>) {
    held.delete(one.clip.id);
    one.done.abort();
    if (!one.connection.closed.aborted) one.connection.reply({ id: one.messageId, ...answer });
  }

  return {
    state,
    offline: () => page?.offline ?? false,

    /** Answer the extension's `clip`, `folders` and `show`. */
    answer(
      message: Extract<Message, { type: 'clip' | 'folders' | 'show' }>,
      connection: ClipConnection,
    ) {
      if (message.type === 'clip') return clip(message, connection);
      if (message.type === 'folders') return void folders(message.id, message.query, connection);
      return show(message.id, message.spaceId, message.pageId, connection);
    },

    /** The window's page, each time the window opens. */
    attach(next: PageContents) {
      contents = next;
      page = null;
      // A new document, as a reload: what it says comes once it loads. Not
      // `did-start-loading`, which a frame in the page loading fires too.
      next.on('did-navigate', () => {
        if (contents === next) page = null;
      });
      next.on('render-process-gone', () => {
        if (contents === next) page = null;
      });
      next.on('destroyed', () => {
        if (contents !== next) return;
        contents = null;
        page = null;
      });
    },

    /** The page says the vault's state. */
    setPageState(input: unknown) {
      const next = PageState.parse(input);
      const first = page === null;
      page = next;
      // A clip that came while the app started now waits for the unlock.
      if (first && next.vault === 'locked' && held.size > 0) options.show();
    },

    waiting: (): DesktopClip[] => [...held.values()].map((one) => one.clip),

    /** The clips waiting or being saved, which closing asks about. */
    holding: () => [...held.keys()],

    done(clipId: unknown, input: unknown) {
      const one = typeof clipId === 'string' ? held.get(clipId) : undefined;
      if (!one) return;
      const outcome: ClipOutcome = Outcome.parse(input);
      if (!outcome.ok) {
        return finish(one, { type: 'error', code: outcome.code, message: outcome.message });
      }
      const { spaceId, pageId, title, path, images, faithful } = outcome;
      clipped.add(`${spaceId}/${pageId}`);
      recent.unshift({ spaceId, pageId, title, path });
      recent.splice(RECENT_CLIPS);
      finish(one, {
        type: 'saved',
        spaceId,
        pageId,
        title: cut(title, 500),
        path: cut(path, PATH_CHARS),
        images,
        faithful,
      });
    },

    /** The page made the held clip `clipId`'s page, which a reload then doesn't make again. */
    made(clipId: unknown, input: unknown) {
      const one = typeof clipId === 'string' ? held.get(clipId) : undefined;
      if (one) one.clip = { ...one.clip, made: Made.parse(input) };
    },

    /** The person signed out: the clips held can't be saved as them. */
    signedOut() {
      for (const one of [...held.values()]) {
        finish(one, { type: 'error', code: 'signed-out', message: 'You signed out of WikiStow.' });
      }
    },

    answerFolders(requestId: unknown, input: unknown) {
      const answered = typeof requestId === 'string' ? searches.get(requestId) : undefined;
      if (answered) answered(input === null ? null : Folders.parse(input));
    },

    /**
     * Fetch an image the held clip `clipId` names, within its limits: one
     * at a time for a clip, however many the page asks for at once.
     */
    image(clipId: unknown, url: unknown): Promise<ClipImage> {
      const one = typeof clipId === 'string' ? held.get(clipId) : undefined;
      if (!one || typeof url !== 'string' || url.length > 16 * 1024 * 1024) {
        return Promise.resolve({ ok: false, reason: 'refused' });
      }
      const run = one.fetching.then(() => fetchFor(one, url));
      one.fetching = run.catch(() => {});
      return run;
    },

    /** This session's last clips, newest first. */
    recent: () => [...recent],
  };
}

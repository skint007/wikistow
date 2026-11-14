// What an app sends and fetches to take part in a page's live session
// (protocol section 5.10, ADR 0015 decision 13): the access a session is
// checked against, starting one with its first snapshot, fetching one, and
// its stream, read line by line with section 3.3's rules.
import {
  ApiErrorBody,
  liveRoutes,
  type JoinId,
  type LiveMessage,
  type LiveSessionId,
  type PageId,
  type RevisionId,
  type SpaceId,
} from '@wikistow/contracts';
import { ApiError, outcomeUnknown, type Fetch } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { parseJsonText } from '../json.ts';
import { openRevisionOf, renamedLinks, saveDraft } from '../operations/pages.ts';
import { keyTargetFor, treeTarget, withFreshKeys } from '../operations/records.ts';
import { spaceKeys } from '../operations/keys.ts';
import type { ClientContext } from '../operations/session.ts';
import type { PagePayload } from '../payload.ts';
import { OWNER_REGION, type Region } from '../regions.ts';
import type { LiveDocument } from './document.ts';
import { liveClientId } from './messages.ts';
import type { ParticipantPorts } from './participant.ts';
import {
  liveBinding,
  openLiveSession,
  requireLiveAccess,
  startLiveSession,
  type LiveAccess,
  type OpenedLiveSession,
} from './session.ts';
import { firstSnapshot } from './snapshot.ts';

/**
 * What this app knows of access to a page now, which a session must be no
 * older than (`requireLiveAccess`): the space's accepted owners, the keys
 * it holds, its No going back marks, read again first from what other tabs
 * kept, and the page's draft region as it knows it.
 */
export async function liveAccess(
  ctx: ClientContext,
  spaceId: SpaceId,
  draftRegion: Region,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<LiveAccess> {
  await ctx.marks.refresh?.();
  const keys = await spaceKeys(ctx, spaceId, { refresh });
  return { owners: keys.owners, keyring: ctx.keyring, marks: ctx.marks, draftRegion };
}

/** A session this app started: opened as anyone opens it, with its first document. */
export type StartedSession = {
  opened: OpenedLiveSession;
  joinId: JoinId;
  /** The starter's document, under its own join's client. */
  document: LiveDocument;
  /** The first snapshot, `seq` 1 of the starter's join. */
  first: LiveMessage;
  /** The first snapshot's position. */
  position: number;
};

/**
 * Start the page's session from the draft `revisionId`, opened in `region`
 * (section 5.10, **Writing the record**): a fresh record, opened here as
 * anyone opens it before anything is sent under its key, and its first
 * snapshot. A start whose answer was lost is sent again byte for byte; one
 * the server refused is made afresh, with a new session ID and key, once
 * (`key-version`, `permission-version`, `recipients-mismatch` and the
 * like); `stale-head` and `duplicate` (a session already open) are thrown
 * for the caller, who then fetches.
 */
export async function startPageSession(
  ctx: ClientContext,
  {
    page,
    revisionId,
    payload,
    region,
  }: {
    page: { spaceId: SpaceId; pageId: PageId };
    revisionId: RevisionId;
    payload: PagePayload;
    region: Region;
  },
): Promise<StartedSession> {
  if (ctx.agent) throw new CryptoError('malformed', 'Agents don’t join live sessions');
  return withFreshKeys(ctx, page.spaceId, async (keys) => {
    const { share, permissionVersion } = await treeTarget(ctx, page.spaceId, page.pageId);
    const target = keyTargetFor(ctx, keys, region, share);
    const started = startLiveSession({
      author: ctx.identity,
      installationId: ctx.installationId,
      spaceId: page.spaceId,
      pageId: page.pageId,
      revisionId,
      ...(target.share ? { share: target.share } : { owners: target.recipients }),
    });
    const access: LiveAccess = {
      owners: keys.owners,
      keyring: ctx.keyring,
      marks: ctx.marks,
      draftRegion: region,
    };
    const opened = openLiveSession({
      reader: ctx.identity,
      trust: ctx.trust,
      installationId: ctx.installationId,
      sealed: {
        record: started.sealed,
        wrap: started.wrap,
        envelopes: started.envelopes,
      },
      expected: { spaceId: page.spaceId, pageId: page.pageId, sessionId: started.sessionId },
      access,
    });
    try {
      const clientId = liveClientId({
        installationId: ctx.installationId,
        sessionId: started.sessionId,
        senderId: ctx.identity.public.id,
        senderKeyVersion: ctx.identity.public.keyVersion,
        joinId: started.joinId,
      });
      const { document, message } = firstSnapshot({
        sender: ctx.identity,
        binding: liveBinding(opened),
        joinId: started.joinId,
        clientId,
        revisionId,
        payload,
      });
      const body = {
        sessionId: started.sessionId,
        joinId: started.joinId,
        revisionId,
        metadata: started.sealed,
        wrap: started.wrap,
        envelopes: started.envelopes,
        snapshot: message,
        permissionVersion,
      };
      // A lost answer: the same start again, byte for byte.
      let answer: { position: number } | null = null;
      for (let tries = 0; answer === null; tries++) {
        try {
          answer = await ctx.api.call(liveRoutes.startLive, {
            params: { pageId: page.pageId },
            body,
          });
        } catch (error) {
          if (!outcomeUnknown(error) || tries >= 2) throw error;
          // Sent before and taken: the session is ours.
        }
      }
      return {
        opened,
        joinId: started.joinId,
        document,
        first: message,
        position: answer.position,
      };
    } catch (error) {
      opened.key.fill(0);
      throw error;
    }
  });
}

/** The page's open session and any ended one kept, as served to this person; or none, from an older server. */
export const fetchPageSession = (ctx: ClientContext, pageId: PageId) =>
  ctx.api.call(liveRoutes.getLive, { params: { pageId } });

/**
 * Open a served session's record for this app (section 5.10, **Opening the
 * record**), against `access`.
 */
export function openServedSession(
  ctx: ClientContext,
  served: liveRoutes.ServedSession,
  page: { spaceId: SpaceId; pageId: PageId },
  access: LiveAccess,
): OpenedLiveSession {
  return openLiveSession({
    reader: ctx.identity,
    trust: ctx.trust,
    installationId: ctx.installationId,
    sealed: { record: served.record, wrap: served.wrap, envelopes: served.envelopes },
    expected: { ...page, sessionId: served.sessionId },
    access,
  });
}

/** Where streams and leaving go: the API's base URL and fetch, as the app's other streams take them. */
export type LiveFetch = { baseUrl?: string; fetch?: Fetch };

/** The server's answers to what one join sends. */
export type LiveTransport = {
  send(body: {
    joinId: JoinId;
    messages: { message: LiveMessage; covers?: number }[];
    parent?: JoinId;
    /** A fold grant to ask for, from a main join, or to place, from a further join (section 5.10). */
    fold?: RevisionId;
  }): Promise<{ positions: (number | null)[]; grant?: liveRoutes.Grant | null }>;
  snapshot(body: {
    joinId: JoinId;
    parent?: JoinId;
    message: LiveMessage;
    covers: number;
    revisionId: RevisionId;
  }): Promise<{ position: number | null }>;
  leave(joinId: JoinId): Promise<void>;
  end(): Promise<void>;
  /** The stream's lines, opened at `after` as `joinId`, until it ends or `signal` aborts. */
  stream(
    query: { after: number; joinId: JoinId; kept?: number },
    signal: AbortSignal,
  ): AsyncGenerator<liveRoutes.StreamLine>;
};

/** The routes of one session, for `ctx`'s person. */
export function liveTransport(
  ctx: ClientContext,
  sessionId: LiveSessionId,
  { baseUrl = '', fetch: send = (url, init) => globalThis.fetch(url, init) }: LiveFetch = {},
): LiveTransport {
  const params = { sessionId };
  return {
    send: (body) => ctx.api.call(liveRoutes.sendMessages, { params, body }),
    snapshot: (body) => ctx.api.call(liveRoutes.postSnapshot, { params, body }),
    async leave(joinId) {
      // As the page closes, too: `keepalive` lets it outlive the page.
      await send(`${baseUrl}/api/live/${encodeURIComponent(sessionId)}/leave`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ joinId }),
        keepalive: true,
      }).then(
        (response) => void response.body?.cancel().catch(() => {}),
        () => {},
      );
    },
    async end() {
      await ctx.api.call(liveRoutes.end, { params });
    },
    async *stream({ after, joinId, kept }, signal) {
      const query = new URLSearchParams({ after: String(after), joinId });
      if (kept !== undefined) query.set('kept', String(kept));
      let response: Response;
      try {
        response = await send(
          `${baseUrl}/api/live/${encodeURIComponent(sessionId)}/stream?${query}`,
          {
            method: 'GET',
            credentials: 'same-origin',
            headers: { accept: 'application/x-ndjson' },
            signal,
          },
        );
      } catch (cause) {
        throw new ApiError(0, 'network', 'No answer from the live stream', {}, { cause });
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const code = (() => {
          try {
            const { value } = parseJsonText(text);
            const parsed = ApiErrorBody.safeParse(value);
            return parsed.success ? parsed.data.error.code : 'unreadable-response';
          } catch {
            return 'unreadable-response';
          }
        })();
        throw new ApiError(response.status, code, `The live stream was refused (${code})`);
      }
      yield* streamLines(response, signal);
    },
  };
}

// The server sends a blank line every 15 s; three missed mean the
// connection is gone, as for the tree's stream.
const QUIET_MS = 45_000;

/**
 * A stream's lines, each read from its raw text with section 3.3's rules
 * (`parseJsonText`): a line with a defect `JSON.parse` would hide, such as
 * a duplicate member name or `1.0`, or that isn't a line of the stream,
 * ends it with `unreadable-response`.
 */
export async function* streamLines(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<liveRoutes.StreamLine> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const quiet = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ApiError(0, 'network', 'The live stream went quiet')),
          QUIET_MS,
        );
      });
      const chunk = await Promise.race([reader.read(), quiet]).finally(() => clearTimeout(timer));
      if (chunk.done || signal.aborted) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim() === '') continue;
        yield readLine(line);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function readLine(line: string): liveRoutes.StreamLine {
  let read: ReturnType<typeof parseJsonText>;
  try {
    read = parseJsonText(line);
  } catch {
    throw new ApiError(200, 'unreadable-response', 'A live stream line isn’t JSON');
  }
  const parsed = liveRoutes.StreamLine.safeParse(read.value);
  if (read.defects.length > 0 || !parsed.success) {
    throw new ApiError(200, 'unreadable-response', 'A live stream line isn’t one');
  }
  return parsed.data;
}

export { requireLiveAccess };

/**
 * The ports a participant takes, as an app or a test has them: drafts
 * opened fresh, saved as any draft save is but renaming no link (a rename
 * would make the draft differ from what everyone's document holds), sent
 * again unchanged after a lost answer, and access read as `liveAccess`
 * reads it, in `region`, the page's draft region as this app knows it.
 */
export function participantPorts(
  ctx: ClientContext,
  page: { spaceId: SpaceId; pageId: PageId },
  region: () => Region,
  {
    live,
    read,
    visible = () => true,
    editor = () => 'source',
    onSaved,
  }: {
    live?: LiveFetch;
    /** A save of the session landed, as the app hears of every draft save. */
    onSaved?: (saved: {
      revisionId: RevisionId;
      basedOn: RevisionId;
      payload: PagePayload;
    }) => void;
    read?: Parameters<typeof saveDraft>[1]['read'];
    visible?: () => boolean;
    editor?: () => 'source' | 'visual';
  } = {},
): ParticipantPorts {
  return {
    ctx,
    page,
    ...(live && { live }),
    async openDraft(revisionId) {
      const opened = await openRevisionOf(ctx, page, 'draft', revisionId);
      if (opened.opened.kind !== 'current') {
        throw new CryptoError('unsupported-format', 'Update the app to edit with others');
      }
      return {
        revisionId,
        payload: opened.opened.payload,
        authorId: opened.record.authorId,
        basedOn: opened.record.basedOn,
        region: opened.region,
        keyVersion: opened.keyVersion,
      };
    },
    async saveDraft({ basedOn, revisionId, payload, linkChoices }) {
      const input = {
        page,
        basedOn,
        revisionId,
        payload,
        linkChoices,
        renames: false,
        ...(read && { read }),
      };
      for (let tries = 0; ; tries++) {
        try {
          const written = await saveDraft(ctx, input);
          onSaved?.({ revisionId: written.revisionId, basedOn, payload: written.payload });
          return { revisionId: written.revisionId, payload: written.payload };
        } catch (error) {
          if (tries < 2 && outcomeUnknown(error)) continue;
          // Sent before and taken: open what landed.
          if (tries > 0 && error instanceof ApiError && error.code === 'duplicate') {
            const opened = await openRevisionOf(ctx, page, 'draft', revisionId, { fresh: true });
            if (opened.opened.kind !== 'current') throw error;
            onSaved?.({ revisionId, basedOn, payload: opened.opened.payload });
            return { revisionId, payload: opened.opened.payload };
          }
          throw error;
        }
      }
    },
    renamed: (payload, basedOn) =>
      renamedLinks(ctx, { page, basedOn, payload, ...(read && { read }) }),
    access: (refresh) => liveAccess(ctx, page.spaceId, region(), { refresh }),
    visible,
    editor,
  };
}

/**
 * The page's draft region as the server's tree puts it now, which a
 * session's key material must stay in: read again after a move's hold
 * lifts, since a lost answer leaves no sign of where the page went.
 */
export async function pageRegionNow(
  ctx: ClientContext,
  page: { spaceId: SpaceId; pageId: PageId },
): Promise<Region> {
  const { share } = await treeTarget(ctx, page.spaceId, page.pageId);
  return share ? { kind: 'share', spaceId: share.spaceId, shareId: share.shareId } : OWNER_REGION;
}

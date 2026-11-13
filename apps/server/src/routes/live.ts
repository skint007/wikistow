// Live sessions' routes and their relay (protocol section 5.10, ADR 0015).
// Messages fan out in memory, in this one server process: once a request's
// transaction commits, each open stream of its session hears of what it
// stored, relayed and granted. The database names each session that ends or
// goes, and each page whose draft head moves (`listenForTreeChanges`'s
// `onLive`), and a tick reads every followed session again, so a stream
// hears of joins that come and go, lapsed grants and anything a notice missed.
import { liveRoutes } from '@wikistow/contracts';
import {
  canStillEdit,
  checkLiveEditor,
  endLive,
  getLive,
  humanActor,
  joinLive,
  leaveLive,
  liveState,
  postSnapshot,
  schema,
  sendLive,
  startLive,
  storedAfter,
  streamClosed,
  type Actor,
  type Database,
  type Relay,
  type ReportUnreadable,
} from '@wikistow/server';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { Log } from '../http/logger.ts';
import type { EarlyCaller, Routes } from '../http/mount.ts';
import { toApiError } from './content.ts';

/**
 * Requests a person may make a minute to every live route together, the
 * stream's opening included: a request every 100 ms from each of four tabs
 * typing at once, with room for snapshots and a save's own join (ADR 0015,
 * decision 13).
 */
const LIVE_LIMIT = { windowSeconds: 60, max: 3000 };
const SHARED = { rateLimit: LIVE_LIMIT, rateLimitKey: 'live' };

/** How often followed sessions are read again, and every how many ticks streams' access is. */
const TICK_MS = 2000;
const ACCESS_TICKS = 5;
/** Lines a stream may have waiting before it is closed, for a reader that stopped reading. */
const MAX_QUEUED = 5000;

type LiveMessage = liveRoutes.LiveMessage;
type Line = z.input<typeof liveRoutes.StreamLine>;
type Queued = { stored: liveRoutes.StoredMessage } | { line: Omit<Line, 'draftHead'> };

type Stream = {
  accountId: string;
  authSessionId: string;
  identityId: string;
  joinId: string;
  /** The last stored position sent, and the highest known stored. */
  sent: number;
  known: number;
  queue: Queued[];
  final: Line | null;
  closed: boolean;
  /** Ended without telling the database its join's stream broke: a newer one replaced it. */
  replaced: boolean;
  wake: (() => void) | null;
};

type Followed = {
  pageId: string;
  streams: Set<Stream>;
  /** Each present main join's latest presence, by `identityId joinId`. */
  presence: Map<string, LiveMessage>;
  draftHead: string | null;
  joins: string;
  grants: Map<string, string>;
  snapshotCovers: number;
};

const joinKey = (identityId: string, joinId: string) => `${identityId} ${joinId}`;

export function mountLiveRoutes(
  routes: Routes,
  { db, log, storageBytes }: { db: Database; log: Log; storageBytes: number },
) {
  const report: ReportUnreadable = ({ table, id }) =>
    log({ level: 'warn', event: 'unreadable-row', table, rowId: id });
  const followed = new Map<string, Followed>();
  const closing = new AbortController();
  let ticks = 0;

  function failed(error: unknown) {
    log({
      level: 'error',
      event: 'live-relay-failed',
      name: error instanceof Error ? error.name : 'unknown',
    });
  }

  function push(stream: Stream, item: Queued) {
    if (stream.closed) return;
    if ('stored' in item) stream.known = Math.max(stream.known, item.stored.position);
    stream.queue.push(item);
    if (stream.queue.length > MAX_QUEUED) close(stream);
    stream.wake?.();
  }

  function close(stream: Stream, final: Line | null = null) {
    if (stream.closed) return;
    stream.final = final;
    stream.closed = true;
    stream.wake?.();
  }

  function pushAll(session: Followed, line: Omit<Line, 'draftHead'>) {
    for (const stream of session.streams) push(stream, { line });
  }

  /** Every stream of a session that ended or went gets that as its last line. */
  function endAll(session: Followed, reason: 'access' | 'ended' | 'deleted') {
    for (const stream of session.streams) {
      close(stream, { ended: reason, draftHead: session.draftHead as Line['draftHead'] });
    }
    session.presence.clear();
  }

  // A session read again: what changed goes to its streams.
  async function refresh(sessionId: string) {
    const session = followed.get(sessionId);
    if (!session) return;
    const state = await liveState(db, sessionId);
    if (!state) {
      endAll(session, 'deleted');
      followed.delete(sessionId);
      return;
    }
    if (state.draftHead !== session.draftHead) {
      session.draftHead = state.draftHead;
      pushAll(session, {});
    }
    session.snapshotCovers = state.snapshotCovers;
    const joins = JSON.stringify(state.joins);
    if (joins !== session.joins) {
      session.joins = joins;
      pushAll(session, { joins: state.joins });
      const present = new Set(
        state.joins.filter((j) => j.present).map((j) => joinKey(j.senderId, j.joinId)),
      );
      for (const key of session.presence.keys()) {
        if (!present.has(key)) session.presence.delete(key);
      }
      // A stream whose join went is closed; its app joins afresh.
      for (const stream of session.streams) {
        if (!present.has(joinKey(stream.identityId, stream.joinId))) close(stream);
      }
    }
    for (const grant of state.grants) {
      const key = `${grant.subject} ${grant.holder.senderId} ${grant.holder.joinId} ${grant.grantedAt}`;
      const json = JSON.stringify(grant);
      if (session.grants.get(key) === json) continue;
      session.grants.set(key, json);
      pushAll(session, { grant });
    }
    for (const stream of session.streams) {
      if (state.lastPosition > stream.known) {
        stream.known = state.lastPosition;
        stream.wake?.();
      }
    }
    if (state.ended) endAll(session, state.ended);
    if (session.streams.size === 0 && session.presence.size === 0) followed.delete(sessionId);
  }

  // People whose sign-in ended, or who can no longer edit the page, stop hearing.
  async function checkAccess() {
    for (const [sessionId, session] of followed) {
      for (const stream of session.streams) {
        const signedIn = await stillSignedIn(stream.authSessionId);
        if (!signedIn || !(await canStillEdit(db, humanActor(stream.accountId), sessionId))) {
          close(stream);
        }
      }
    }
  }

  async function stillSignedIn(authSessionId: string) {
    const { sessions, users } = schema;
    const [row] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, authSessionId),
          gt(sessions.expiresAt, new Date()),
          isNull(users.suspendedAt),
        ),
      );
    return row !== undefined;
  }

  let ticking = false;
  const timer = setInterval(() => {
    if (ticking || followed.size === 0) return;
    ticking = true;
    ticks++;
    (async () => {
      for (const sessionId of [...followed.keys()]) await refresh(sessionId);
      if (ticks % ACCESS_TICKS === 0) await checkAccess();
    })()
      .catch(failed)
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);
  timer.unref();

  /** What a committed request changed, to its session's streams. */
  function relay(change: Relay) {
    const session = followed.get(change.sessionId);
    if (!session) return;
    if (change.draftHead !== session.draftHead) {
      session.draftHead = change.draftHead;
      pushAll(session, {});
    }
    for (const stored of change.stored) {
      if (stored.message.kind === 'snapshot' && stored.covers !== null) {
        session.snapshotCovers = Math.max(session.snapshotCovers, stored.covers);
      }
      for (const stream of session.streams) push(stream, { stored });
    }
    for (const presence of change.presence) {
      session.presence.set(joinKey(presence.senderId, presence.joinId), presence);
      pushAll(session, { presence });
    }
    for (const grant of change.grants) {
      const key = `${grant.subject} ${grant.holder.senderId} ${grant.holder.joinId} ${grant.grantedAt}`;
      session.grants.set(key, JSON.stringify(grant));
      pushAll(session, { grant });
    }
    if (change.deleted) {
      endAll(session, 'deleted');
      followed.delete(change.sessionId);
    } else if (change.joinsChanged) {
      refresh(change.sessionId).catch(failed);
    }
  }

  const asActor = (caller: EarlyCaller): Actor => ({
    accountId: caller.accountId,
    agentId: caller.agentId ?? null,
  });

  routes.content(
    liveRoutes.getLive,
    async ({ params }, { actor }) => getLive(db, actor, params.pageId, report).catch(toApiError),
    SHARED,
  );

  routes.content(
    liveRoutes.startLive,
    async ({ params, body }, { actor }) =>
      startLive(db, {
        actor,
        pageId: params.pageId,
        storageBytes,
        storedBytesPerMinute: liveRoutes.STORED_BYTES_PER_MINUTE,
        ...body,
      }).catch(toApiError),
    {
      ...SHARED,
      bodyLimit: liveRoutes.SNAPSHOT_BODY_BYTES,
      bodyPool: 'live',
      beforeBody: async (params, caller) => {
        await checkLiveEditor(db, asActor(caller), { pageId: String(params['pageId']) }).catch(
          toApiError,
        );
      },
    },
  );

  routes.content(
    liveRoutes.sendMessages,
    async ({ params, body }, { actor }) => {
      const {
        positions,
        grant,
        relay: change,
      } = await sendLive(db, {
        actor,
        sessionId: params.sessionId,
        storageBytes,
        storedBytesPerMinute: liveRoutes.STORED_BYTES_PER_MINUTE,
        ...body,
      }).catch(toApiError);
      relay(change);
      return { positions, grant };
    },
    SHARED,
  );

  routes.content(
    liveRoutes.postSnapshot,
    async ({ params, body }, { actor }) => {
      const { position, relay: change } = await postSnapshot(db, {
        actor,
        sessionId: params.sessionId,
        storageBytes,
        storedBytesPerMinute: liveRoutes.STORED_BYTES_PER_MINUTE,
        ...body,
      }).catch(toApiError);
      if (change) relay(change);
      return { position };
    },
    {
      ...SHARED,
      bodyLimit: liveRoutes.SNAPSHOT_BODY_BYTES,
      bodyPool: 'live',
      beforeBody: async (params, caller) => {
        await checkLiveEditor(db, asActor(caller), {
          sessionId: String(params['sessionId']),
        }).catch(toApiError);
      },
    },
  );

  routes.content(
    liveRoutes.leave,
    async ({ params, body }, { actor }) => {
      const { left } = await leaveLive(db, {
        actor,
        sessionId: params.sessionId,
        joinId: body.joinId,
      }).catch(toApiError);
      if (left) refresh(params.sessionId).catch(failed);
      return { ok: true as const };
    },
    SHARED,
  );

  routes.content(
    liveRoutes.end,
    async ({ params }, { actor }) => {
      const { ended } = await endLive(db, { actor, sessionId: params.sessionId }).catch(toApiError);
      if (ended) refresh(params.sessionId).catch(failed);
      return { ok: true as const };
    },
    SHARED,
  );

  routes.stream(
    liveRoutes.stream,
    async (_body, { principal, signal, input }) => {
      const { sessionId } = input.params;
      const { joinId, after } = input.query;
      const joined = await joinLive(db, {
        actor: humanActor(principal.accountId),
        sessionId,
        joinId,
        after,
      }).catch(toApiError);
      const draftHead = joined.draftHead as Line['draftHead'];
      if (joined.ended !== null) {
        const reason = joined.ended;
        return (async function* () {
          yield { ended: reason, draftHead } satisfies Line;
        })();
      }
      let session = followed.get(sessionId);
      if (!session) {
        session = {
          pageId: joined.pageId,
          streams: new Set(),
          presence: new Map(),
          draftHead: joined.draftHead,
          joins: JSON.stringify(joined.joins),
          grants: new Map(),
          snapshotCovers: 0,
        };
        followed.set(sessionId, session);
      }
      const here = session;
      // A newer stream of a join replaces the older one.
      for (const other of here.streams) {
        if (other.identityId === joined.identityId && other.joinId === joined.joinId) {
          other.replaced = true;
          close(other);
        }
      }
      const stream: Stream = {
        accountId: principal.accountId,
        authSessionId: principal.sessionId,
        identityId: joined.identityId,
        joinId: joined.joinId,
        sent: after,
        known: joined.lastPosition,
        queue: [],
        final: null,
        closed: false,
        replaced: false,
        wake: null,
      };
      const ended = AbortSignal.any([signal, closing.signal]);
      const stop = () => close(stream);
      ended.addEventListener('abort', stop, { once: true });
      here.streams.add(stream);
      // Others hear of the join; the tick reads the session soon in any case.
      refresh(sessionId).catch(failed);

      const head = () => here.draftHead as Line['draftHead'];
      const finish = () => {
        ended.removeEventListener('abort', stop);
        here.streams.delete(stream);
        if (here.streams.size === 0 && here.presence.size === 0) followed.delete(sessionId);
        if (!stream.replaced) {
          streamClosed(db, {
            sessionId,
            identityId: stream.identityId,
            joinId: stream.joinId,
          })
            .then(() => refresh(sessionId))
            .catch(failed);
        }
      };

      // Stored messages after `sent` up to `upTo`, from the database, in order.
      async function* catchUp(upTo: number) {
        while (stream.sent < upTo && !stream.closed) {
          // Messages a later snapshot covered are gone: the app joins afresh.
          if (stream.sent < here.snapshotCovers) {
            close(stream);
            return;
          }
          const batch = await storedAfter(db, sessionId, stream.sent, { upTo });
          if (batch.length === 0) return;
          for (const stored of batch) {
            stream.sent = stored.position;
            yield { message: stored, draftHead: head() } satisfies Line;
          }
        }
      }

      return (async function* () {
        try {
          yield { joins: joined.joins, draftHead: head() } satisfies Line;
          for (const presence of here.presence.values()) {
            yield { presence, draftHead: head() } satisfies Line;
          }
          for (;;) {
            yield* catchUp(stream.known);
            const item = stream.queue.shift();
            if (item) {
              if ('stored' in item) {
                yield* catchUp(item.stored.position - 1);
                if (item.stored.position > stream.sent) {
                  stream.sent = item.stored.position;
                  yield { message: item.stored, draftHead: head() } satisfies Line;
                }
              } else {
                yield { ...item.line, draftHead: head() } as Line;
              }
              continue;
            }
            if (stream.closed) {
              if (stream.final) yield stream.final;
              return;
            }
            await new Promise<void>((resolve) => (stream.wake = resolve));
            stream.wake = null;
          }
        } finally {
          finish();
        }
      })();
    },
    { ...SHARED, agentsNotFound: true },
  );

  return {
    /** A notice from the database (`wikistow_live`): a session ended or went, or a page's head moved. */
    notified(payload: string) {
      const [what, id] = payload.split(' ');
      if (!id) return;
      if (what === 'ended' || what === 'gone') {
        refresh(id).catch(failed);
        return;
      }
      if (what === 'head') {
        for (const [sessionId, session] of followed) {
          if (session.pageId === id) refresh(sessionId).catch(failed);
        }
      }
    },
    /** Read every followed session again now, as the tick does. */
    refreshAll: async () => {
      for (const sessionId of [...followed.keys()]) await refresh(sessionId);
    },
    close: () => {
      clearInterval(timer);
      closing.abort();
      for (const session of followed.values()) {
        for (const stream of session.streams) close(stream);
      }
    },
  };
}

export type LiveRelay = ReturnType<typeof mountLiveRoutes>;

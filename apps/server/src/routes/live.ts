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
import { ApiError } from '../http/errors.ts';
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

/** How often followed sessions are read again, and streams' access checked. */
const TICK_MS = 2000;
const ACCESS_MS = 10_000;
/**
 * Bytes of lines a stream may have waiting before it is closed, its queue
 * dropped, for a reader that stopped reading; it joins again from where it got.
 */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
/** Streams one person may have open at once, every session together (`rate-limited`). */
const MAX_STREAMS_PER_ACCOUNT = 16;

type LiveMessage = liveRoutes.LiveMessage;
type Line = z.input<typeof liveRoutes.StreamLine>;
// A line without its draft head, which goes on as the line is sent.
type Without<L> = L extends unknown ? Omit<L, 'draftHead'> : never;
type Bare = Without<Line>;
type Queued = { stored: liveRoutes.StoredMessage } | { line: Bare };

type Stream = {
  accountId: string;
  authSessionId: string;
  identityId: string;
  joinId: string;
  /** The last stored position sent, and the highest known stored. */
  sent: number;
  known: number;
  queue: Queued[];
  queuedBytes: number;
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
  /** The page's draft head, and how many drafts it had then, which only grows. */
  draftHead: string | null;
  draftCount: number;
  joins: string;
  grants: Map<string, string>;
  snapshotCovers: number;
};

const joinKey = (identityId: string, joinId: string) => `${identityId} ${joinId}`;
const grantKey = (grant: liveRoutes.Grant) =>
  `${grant.subject} ${grant.holder.senderId} ${grant.holder.joinId} ${grant.grantedAt}`;

// About what a queued line takes, counting its ciphertext.
function sizeOf(item: Queued) {
  if ('stored' in item) return item.stored.message.sealed.ciphertext.length + 512;
  const { line } = item;
  if ('presence' in line) return line.presence.sealed.ciphertext.length + 512;
  if ('joins' in line) return line.joins.length * 256 + 512;
  return 512;
}

export function mountLiveRoutes(
  routes: Routes,
  { db, log, storageBytes }: { db: Database; log: Log; storageBytes: number },
) {
  const report: ReportUnreadable = ({ table, id }) =>
    log({ level: 'warn', event: 'unreadable-row', table, rowId: id });
  const followed = new Map<string, Followed>();
  const closing = new AbortController();
  // People with a fetch of a session in hand: one at a time each, since one can be large.
  const fetching = new Set<string>();

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
    stream.queuedBytes += sizeOf(item);
    if (stream.queuedBytes > MAX_QUEUED_BYTES) close(stream, null, { drop: true });
    stream.wake?.();
  }

  /**
   * Close a stream once what is queued has gone, with `final` last, or at
   * once with `drop`, sending nothing more.
   */
  function close(stream: Stream, final: Line | null = null, { drop = false } = {}) {
    if (drop) {
      stream.queue = [];
      stream.queuedBytes = 0;
      stream.final = null;
    }
    if (stream.closed) {
      stream.wake?.();
      return;
    }
    stream.final = drop ? null : final;
    stream.closed = true;
    stream.wake?.();
  }

  function pushAll(session: Followed, line: Bare) {
    for (const stream of session.streams) push(stream, { line });
  }

  // A draft head heard of, applied only if newer than the one streams carry.
  function setHead(session: Followed, draftHead: string | null, draftCount: number) {
    if (draftCount < session.draftCount) return;
    if (draftCount === session.draftCount && draftHead === session.draftHead) return;
    session.draftHead = draftHead;
    session.draftCount = draftCount;
    pushAll(session, {});
  }

  /** Every stream of a session that ended or went gets that as its last line. */
  function endAll(session: Followed, reason: 'access' | 'ended' | 'deleted') {
    for (const stream of session.streams) {
      close(stream, { ended: reason, draftHead: session.draftHead as Line['draftHead'] });
    }
    session.presence.clear();
  }

  // Forget a session nobody follows, unless a newer entry took its place meanwhile.
  function forget(sessionId: string, session: Followed) {
    if (followed.get(sessionId) !== session) return;
    if (session.streams.size === 0) followed.delete(sessionId);
  }

  // A session read again: what changed goes to its streams.
  async function refresh(sessionId: string) {
    const session = followed.get(sessionId);
    if (!session) return;
    const state = await liveState(db, sessionId);
    if (!state) {
      endAll(session, 'deleted');
      forget(sessionId, session);
      return;
    }
    setHead(session, state.draftHead, state.draftCount);
    session.snapshotCovers = Math.max(session.snapshotCovers, state.snapshotCovers);
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
      const json = JSON.stringify(grant);
      if (session.grants.get(grantKey(grant)) === json) continue;
      session.grants.set(grantKey(grant), json);
      pushAll(session, { grant });
    }
    for (const stream of session.streams) {
      if (state.lastPosition > stream.known) {
        stream.known = state.lastPosition;
        stream.wake?.();
      }
    }
    if (state.ended) endAll(session, state.ended);
    forget(sessionId, session);
  }

  // People whose sign-in ended, or who can no longer edit the page, stop
  // hearing at once, with nothing queued sent.
  async function checkAccess() {
    for (const [sessionId, session] of followed) {
      for (const stream of session.streams) {
        const signedIn = await stillSignedIn(stream.authSessionId);
        if (!signedIn || !(await canStillEdit(db, humanActor(stream.accountId), sessionId))) {
          close(stream, null, { drop: true });
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

  // Each on its own timer, so many sessions to read again never delay access checks.
  const every = (ms: number, run: () => Promise<void>) => {
    let running = false;
    const timer = setInterval(() => {
      if (running || followed.size === 0) return;
      running = true;
      run()
        .catch(failed)
        .finally(() => {
          running = false;
        });
    }, ms);
    timer.unref();
    return timer;
  };
  const timers = [
    every(TICK_MS, async () => {
      for (const sessionId of [...followed.keys()]) await refresh(sessionId);
    }),
    every(ACCESS_MS, checkAccess),
  ];

  /**
   * What a committed request changed, to its session's streams. An ended
   * session's streams hear nothing more but that it ended: a `saved` sent
   * to it after a removal isn't relayed, even to those who can still edit.
   */
  function relay(change: Relay) {
    const session = followed.get(change.sessionId);
    if (!session) return;
    if (change.deleted) {
      endAll(session, 'deleted');
      forget(change.sessionId, session);
      return;
    }
    if (change.ended) {
      refresh(change.sessionId).catch(failed);
      return;
    }
    setHead(session, change.draftHead, change.draftCount);
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
      session.grants.set(grantKey(grant), JSON.stringify(grant));
      pushAll(session, { grant });
    }
    if (change.joinsChanged) refresh(change.sessionId).catch(failed);
  }

  const asActor = (caller: EarlyCaller): Actor => ({
    accountId: caller.accountId,
    agentId: caller.agentId ?? null,
  });

  routes.content(
    liveRoutes.getLive,
    async ({ params }, { actor }) => {
      if (fetching.has(actor.accountId)) {
        throw new ApiError('rate-limited', 'Fetching a session already; try again shortly');
      }
      fetching.add(actor.accountId);
      try {
        return await getLive(db, actor, params.pageId, report).catch(toApiError);
      } finally {
        fetching.delete(actor.accountId);
      }
    },
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
      const open = [...followed.values()]
        .flatMap((s) => [...s.streams])
        .filter((s) => s.accountId === principal.accountId && !s.closed && s.joinId !== joinId);
      if (open.length >= MAX_STREAMS_PER_ACCOUNT) {
        throw new ApiError('rate-limited', 'Too many sessions open at once');
      }
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
          draftCount: joined.draftCount,
          joins: JSON.stringify(joined.joins),
          grants: new Map(),
          snapshotCovers: joined.snapshotCovers,
        };
        followed.set(sessionId, session);
      }
      const here = session;
      setHead(here, joined.draftHead, joined.draftCount);
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
        queuedBytes: 0,
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
        forget(sessionId, here);
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
              stream.queuedBytes -= sizeOf(item);
              if ('stored' in item) {
                // Once closed it fetches nothing, so it stops at a gap rather than skip one.
                if (stream.closed && item.stored.position > stream.sent + 1) {
                  stream.queue = [];
                  continue;
                }
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
      for (const timer of timers) clearInterval(timer);
      closing.abort();
      for (const session of followed.values()) {
        for (const stream of session.streams) close(stream);
      }
    },
  };
}

export type LiveRelay = ReturnType<typeof mountLiveRoutes>;

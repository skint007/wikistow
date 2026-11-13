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
  consumeRateLimit,
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
const ACCESS_AT_ONCE = 4;
/**
 * Bytes of lines a stream may have waiting before it is closed, its queue
 * dropped, for a reader that stopped reading; it joins again from where it got.
 */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
/**
 * Streams one person may have open at once, every session together,
 * counted from before the join until the stream has finished
 * (`rate-limited`), and fetches of a session at once.
 */
const MAX_STREAMS_PER_ACCOUNT = 16;
const MAX_FETCHES_PER_ACCOUNT = 2;
/**
 * Fetches of a session and stream openings one person may make a minute,
 * together: each can read megabytes, which the requests limit alone, made
 * for typing, would let through thousands of times.
 */
const READ_LIMIT = { windowMs: 60_000, max: 120 };

/**
 * Live writes one person may have in hand at once, so a burst waits on
 * their own requests, never on every connection the server has.
 */
const MAX_WRITES_PER_ACCOUNT = 8;
/** How long a closed stream has to send what it had queued before it is cut off. */
const DRAIN_MS = 5000;

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
  /** When it opened, and what the latest snapshot covered then. */
  openedAt: number;
  openCovers: number;
  /** End its response now, read or not. */
  stop: () => void;
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
  {
    db,
    log,
    storageBytes,
    rateLimit,
  }: { db: Database; log: Log; storageBytes: number; rateLimit: boolean },
) {
  const report: ReportUnreadable = ({ table, id }) =>
    log({ level: 'warn', event: 'unreadable-row', table, rowId: id });
  const followed = new Map<string, Followed>();
  const closing = new AbortController();
  // Each person's fetches of a session in hand, and streams from before their join until done.
  const fetching = new Map<string, number>();
  const streaming = new Map<string, number>();
  const count = (counts: Map<string, number>, key: string, by: number) => {
    const next = (counts.get(key) ?? 0) + by;
    if (next > 0) counts.set(key, next);
    else counts.delete(key);
  };
  // Each session's reads one after another, so an older one never lands after a newer.
  const reading = new Map<string, Promise<void>>();

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
    // A reader that doesn't read never lets it finish: cut it off.
    setTimeout(() => stream.stop(), drop ? 0 : DRAIN_MS).unref();
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

  // A grant as it stands, told only when it moved on: placed, or lapsed,
  // never back, whichever of a read and a request comes first.
  function heardGrant(session: Followed, grant: liveRoutes.Grant) {
    const known = session.grants.get(grantKey(grant));
    if (known) {
      const before = JSON.parse(known) as liveRoutes.Grant;
      if (JSON.stringify(before) === JSON.stringify(grant)) return;
      if (before.position !== null && grant.position === null) return;
      if (before.lapsed && !grant.lapsed) return;
    }
    session.grants.set(grantKey(grant), JSON.stringify(grant));
    pushAll(session, { grant });
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

  // A session read again, after any read of it already going.
  function refresh(sessionId: string): Promise<void> {
    // A read that failed doesn't stop the one queued behind it.
    const next = (reading.get(sessionId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => readAgain(sessionId))
      .finally(() => {
        if (reading.get(sessionId) === next) reading.delete(sessionId);
      });
    reading.set(sessionId, next);
    return next;
  }

  // What changed goes to its streams.
  async function readAgain(sessionId: string) {
    const session = followed.get(sessionId);
    if (!session) return;
    const startedAt = Date.now();
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
      // A stream whose join went is closed; its app joins afresh. One opened
      // since the read began may not be in it yet.
      for (const stream of session.streams) {
        if (stream.openedAt >= startedAt) continue;
        if (!present.has(joinKey(stream.identityId, stream.joinId))) close(stream);
      }
    }
    for (const grant of state.grants) heardGrant(session, grant);
    // Only what a newcomer is served is kept in mind.
    const listed = new Set(state.grants.map(grantKey));
    for (const key of session.grants.keys()) if (!listed.has(key)) session.grants.delete(key);
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
  // hearing within `ACCESS_MS`, with nothing queued sent.
  async function checkAccess() {
    const checks = [...followed].flatMap(([sessionId, session]) =>
      [...session.streams].map((stream) => async () => {
        const signedIn = await stillSignedIn(stream.authSessionId);
        if (!signedIn || !(await canStillEdit(db, humanActor(stream.accountId), sessionId))) {
          close(stream, null, { drop: true });
        }
      }),
    );
    // A few at a time, so the checks never take every connection.
    const runners = Array.from({ length: ACCESS_AT_ONCE }, async () => {
      for (let check = checks.shift(); check; check = checks.shift()) await check();
    });
    await Promise.all(runners);
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
      // One session failing to read doesn't stop the others.
      for (const sessionId of [...followed.keys()]) await refresh(sessionId).catch(failed);
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
    // In the order the request sent them, presence among the rest.
    for (const item of change.sent) {
      if ('stored' in item) {
        const { stored } = item;
        if (stored.message.kind === 'snapshot' && stored.covers !== null) {
          session.snapshotCovers = Math.max(session.snapshotCovers, stored.covers);
        }
        for (const stream of session.streams) push(stream, { stored });
      } else {
        const { presence } = item;
        session.presence.set(joinKey(presence.senderId, presence.joinId), presence);
        pushAll(session, { presence });
      }
    }
    for (const grant of change.grants) heardGrant(session, grant);
    if (change.joinsChanged) refresh(change.sessionId).catch(failed);
  }

  // A fetch or a stream's opening, counted against the person's `READ_LIMIT`.
  async function countRead(accountId: string) {
    if (!rateLimit) return;
    const { allowed } = await consumeRateLimit(db, `live-read account:${accountId}`, READ_LIMIT);
    if (!allowed)
      throw new ApiError('rate-limited', 'Too many fetches of sessions; try again shortly');
  }

  const writes = new Map<string, number>();
  // A write of `actor`'s, one of at most `MAX_WRITES_PER_ACCOUNT` at once.
  async function writing<T>(actor: Actor, run: () => Promise<T>): Promise<T> {
    if (actor.agentId !== null) throw new ApiError('not-found', 'Not found');
    if ((writes.get(actor.accountId) ?? 0) >= MAX_WRITES_PER_ACCOUNT) {
      throw new ApiError('rate-limited', 'Too many live requests at once; try again shortly');
    }
    count(writes, actor.accountId, 1);
    try {
      return await run();
    } finally {
      count(writes, actor.accountId, -1);
    }
  }

  const asActor = (caller: EarlyCaller): Actor => ({
    accountId: caller.accountId,
    agentId: caller.agentId ?? null,
  });

  routes.content(
    liveRoutes.getLive,
    async ({ params }, { actor }) => {
      // Agents are refused before they take any of their person's fetches.
      if (actor.agentId !== null) throw new ApiError('not-found', 'Not found');
      if ((fetching.get(actor.accountId) ?? 0) >= MAX_FETCHES_PER_ACCOUNT) {
        throw new ApiError('rate-limited', 'Fetching sessions already; try again shortly');
      }
      // Taken before anything is awaited, so fetches sent at once can't all pass.
      count(fetching, actor.accountId, 1);
      try {
        await countRead(actor.accountId);
        return await getLive(db, actor, params.pageId, report).catch(toApiError);
      } finally {
        count(fetching, actor.accountId, -1);
      }
    },
    SHARED,
  );

  routes.content(
    liveRoutes.startLive,
    async ({ params, body }, { actor }) =>
      writing(actor, () =>
        startLive(db, {
          actor,
          pageId: params.pageId,
          storageBytes,
          storedBytesPerMinute: liveRoutes.STORED_BYTES_PER_MINUTE,
          ...body,
        }).catch(toApiError),
      ),
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
      } = await writing(actor, () =>
        sendLive(db, {
          actor,
          sessionId: params.sessionId,
          storageBytes,
          storedBytesPerMinute: liveRoutes.STORED_BYTES_PER_MINUTE,
          ...body,
        }).catch(toApiError),
      );
      relay(change);
      return { positions, grant };
    },
    SHARED,
  );

  routes.content(
    liveRoutes.postSnapshot,
    async ({ params, body }, { actor }) => {
      const { position, relay: change } = await writing(actor, () =>
        postSnapshot(db, {
          actor,
          sessionId: params.sessionId,
          storageBytes,
          storedBytesPerMinute: liveRoutes.STORED_BYTES_PER_MINUTE,
          ...body,
        }).catch(toApiError),
      );
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
      const { left } = await writing(actor, () =>
        leaveLive(db, { actor, sessionId: params.sessionId, joinId: body.joinId }).catch(
          toApiError,
        ),
      );
      if (left) refresh(params.sessionId).catch(failed);
      return { ok: true as const };
    },
    SHARED,
  );

  routes.content(
    liveRoutes.end,
    async ({ params }, { actor }) => {
      const { ended } = await writing(actor, () =>
        endLive(db, { actor, sessionId: params.sessionId }).catch(toApiError),
      );
      if (ended) refresh(params.sessionId).catch(failed);
      return { ok: true as const };
    },
    SHARED,
  );

  routes.stream(
    liveRoutes.stream,
    async (_body, { c, principal, signal, input, stop }) => {
      const { sessionId } = input.params;
      const { joinId, after, kept } = input.query;
      // A GET that joins: never from another site, nor a navigation, which
      // asks for a page and can't ask for this stream's lines.
      const site = c.req.header('sec-fetch-site');
      const accept = c.req.header('accept') ?? '';
      if (
        (site !== undefined && site !== 'same-origin' && site !== 'none') ||
        c.req.header('sec-fetch-mode') === 'navigate' ||
        accept.includes('text/html')
      ) {
        throw new ApiError('forbidden', 'Cross-origin request refused');
      }
      const account = principal.accountId;
      await countRead(account);
      const replacing = [...(followed.get(sessionId)?.streams ?? [])].some(
        (s) => s.accountId === account && s.joinId === joinId,
      );
      // A stream replacing one of the same join still counts until that one finishes.
      if ((streaming.get(account) ?? 0) - (replacing ? 1 : 0) >= MAX_STREAMS_PER_ACCOUNT) {
        throw new ApiError('rate-limited', 'Too many sessions open at once');
      }
      // Counted from now until the stream has finished, its join included.
      count(streaming, account, 1);
      let counted = true;
      const release = () => {
        if (counted) count(streaming, account, -1);
        counted = false;
      };
      let joined: Awaited<ReturnType<typeof joinLive>>;
      try {
        joined = await joinLive(db, {
          actor: humanActor(account),
          sessionId,
          joinId,
          after,
          kept,
        });
      } catch (error) {
        release();
        return toApiError(error);
      }
      const draftHead = joined.draftHead as Line['draftHead'];
      if (joined.ended !== null) {
        // Read, not joined: what it keeps after `after`, then the end.
        const reason = joined.ended;
        const upTo = joined.lastPosition;
        return (async function* () {
          try {
            let sent = after;
            while (sent < upTo && !signal.aborted) {
              const { messages } = await storedAfter(db, sessionId, sent, { upTo });
              if (messages.length === 0) break;
              for (const message of messages) {
                sent = message.position;
                yield { message, draftHead } satisfies Line;
              }
            }
            // Cut short, as when it went meanwhile: no end, so its app reads again.
            if (sent >= upTo) yield { ended: reason, draftHead } satisfies Line;
          } finally {
            release();
          }
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
      // A newer stream of a join replaces the older one, which sends nothing more.
      for (const other of here.streams) {
        if (other.identityId === joined.identityId && other.joinId === joined.joinId) {
          other.replaced = true;
          close(other, null, { drop: true });
        }
      }
      const stream: Stream = {
        accountId: account,
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
        openedAt: Date.now(),
        openCovers: kept ?? joined.snapshotCovers,
        stop,
      };
      const ended = AbortSignal.any([signal, closing.signal]);
      const abort = () => close(stream);
      ended.addEventListener('abort', abort, { once: true });
      here.streams.add(stream);
      // Others hear of the join; the tick reads the session soon in any case.
      refresh(sessionId).catch(failed);

      const head = () => here.draftHead as Line['draftHead'];
      const finish = () => {
        ended.removeEventListener('abort', abort);
        here.streams.delete(stream);
        release();
        forget(sessionId, here);
        if (!stream.replaced) {
          streamClosed(db, {
            sessionId,
            identityId: stream.identityId,
            joinId: stream.joinId,
            token: joined.token,
          })
            .then(() => refresh(sessionId))
            .catch(failed);
        }
      };

      // Stored messages after `sent` up to `upTo`, from the database, in
      // order. A snapshot that deleted some of them since the stream opened
      // leaves it short: it closes, and its app opens it again from `sent`.
      async function* catchUp(upTo: number) {
        while (stream.sent < upTo && !stream.closed) {
          const { messages, snapshotCovers } = await storedAfter(db, sessionId, stream.sent, {
            upTo,
          });
          here.snapshotCovers = Math.max(here.snapshotCovers, snapshotCovers);
          if (snapshotCovers > Math.max(stream.sent, stream.openCovers)) {
            close(stream, null, { drop: true });
            return;
          }
          if (messages.length === 0) return;
          for (const stored of messages) {
            if (stream.closed) return;
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
          for (const grant of joined.grants) {
            heardGrant(here, grant);
            yield { grant, draftHead: head() } satisfies Line;
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
              // A stream left short of what was stored gets no end, so its app opens it again.
              if (stream.final && stream.sent >= stream.known) yield stream.final;
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

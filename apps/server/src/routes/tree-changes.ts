import { structureRoutes } from '@wikistow/contracts';
import { schema, treesSeenBy, type Database } from '@wikistow/server';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Log } from '../http/logger.ts';
import type { Routes } from '../http/mount.ts';

/**
 * How long changes to a space gather before anyone hears of them: a second
 * after a quiet spell, and longer while they keep coming. An agent making
 * fifty pages then costs an app a tree load every few seconds, not fifty,
 * and a person's other devices stay well inside their fetch limit. Other
 * spaces keep the quick pace meanwhile.
 */
const GATHER_MS = 1000;
const BUSY_GATHER_MS = 3000;

/**
 * One open stream. `seen` holds the spaces its person sees some of, as of
 * the last change to each, so someone a change shuts out still hears of
 * it, and their sidebar drops what they lost.
 */
type Listener = {
  accountId: string;
  sessionId: string;
  seen: Set<string>;
  hear: (spaceIds: readonly string[]) => void;
  end: () => void;
};

/**
 * The tree changes stream (`structureRoutes.treeChanges`). `changed` takes
 * a space whose tree changed, as the database names it
 * (`listenForTreeChanges`). Soon after, every open stream whose person
 * sees some of that space, or did until this change, hears of it, with the
 * others that changed meanwhile. `close` ends every stream, so the server
 * can stop.
 */
export function mountTreeChangeRoutes(routes: Routes, { db, log }: { db: Database; log: Log }) {
  const listeners = new Set<Listener>();
  const closing = new AbortController();
  // When each space was last told of, while that is recent.
  const lastTold = new Map<string, number>();
  const quick = gathering(GATHER_MS);
  const busy = gathering(BUSY_GATHER_MS);

  // Spaces gathered for `ms`, then told of together.
  function gathering(ms: number) {
    let gathered = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    return {
      has: (spaceId: string) => gathered.has(spaceId),
      add(spaceId: string) {
        gathered.add(spaceId);
        timer ??= setTimeout(() => {
          const spaceIds = [...gathered];
          gathered = new Set();
          timer = null;
          tell(spaceIds).catch((error: unknown) =>
            log({
              level: 'error',
              event: 'tree-changes-failed',
              name: error instanceof Error ? error.name : 'unknown',
            }),
          );
        }, ms);
      },
      stop: () => timer && clearTimeout(timer),
    };
  }

  // Each person's streams hear of the spaces they see, or saw.
  async function tell(spaceIds: string[]) {
    const now = Date.now();
    for (const [id, at] of lastTold) if (now - at >= BUSY_GATHER_MS) lastTold.delete(id);
    for (const id of spaceIds) lastTold.set(id, now);
    // A stream lasts only as long as its session: one signed out, revoked
    // or suspended since it opened ends here, before it hears anything.
    const live = await liveSessions([...listeners].map((listener) => listener.sessionId));
    for (const listener of listeners) if (!live.has(listener.sessionId)) listener.end();
    const accounts = new Set([...listeners].map((listener) => listener.accountId));
    await Promise.all(
      [...accounts].map(async (accountId) => {
        const seen = await treesSeenBy(db, accountId, spaceIds);
        for (const listener of listeners) {
          if (listener.accountId !== accountId) continue;
          const told = spaceIds.filter((id) => seen.has(id) || listener.seen.has(id));
          for (const id of spaceIds) {
            if (seen.has(id)) listener.seen.add(id);
            else listener.seen.delete(id);
          }
          if (told.length > 0) listener.hear(told);
        }
      }),
    );
  }

  // Which of `sessionIds` are current, for an account that isn't suspended.
  async function liveSessions(sessionIds: string[]) {
    if (sessionIds.length === 0) return new Set<string>();
    const { sessions, users } = schema;
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          inArray(sessions.id, sessionIds),
          gt(sessions.expiresAt, new Date()),
          isNull(users.suspendedAt),
        ),
      );
    return new Set(rows.map((row) => row.id));
  }

  routes.stream(structureRoutes.treeChanges, async (_body, { principal, signal }) => {
    const left = new AbortController();
    const ended = AbortSignal.any([signal, closing.signal, left.signal]);
    let heard = new Set<string>();
    let wake: (() => void) | null = null;
    const listener: Listener = {
      accountId: principal.accountId,
      sessionId: principal.sessionId,
      seen: await treesSeenBy(db, principal.accountId),
      hear(spaceIds) {
        for (const spaceId of spaceIds) heard.add(spaceId);
        wake?.();
      },
      end: () => left.abort(),
    };
    // Listening already as the answer starts, until the person leaves or
    // the server stops.
    if (!ended.aborted) {
      listeners.add(listener);
      ended.addEventListener(
        'abort',
        () => {
          listeners.delete(listener);
          wake?.();
        },
        { once: true },
      );
    }
    return (async function* () {
      while (!ended.aborted) {
        if (heard.size === 0) {
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
          continue;
        }
        const spaceIds = [...heard];
        heard = new Set();
        yield { spaceIds };
      }
    })();
  });

  return {
    changed: (spaceId: string) => {
      if (listeners.size === 0) return;
      // Busy while waiting in the slow batch too, which ends a little after
      // its first change, not three seconds after the last notice.
      const told = lastTold.get(spaceId);
      const recent = told !== undefined && Date.now() - told < BUSY_GATHER_MS;
      (recent || busy.has(spaceId) ? busy : quick).add(spaceId);
    },
    close: () => {
      quick.stop();
      busy.stop();
      closing.abort();
    },
  };
}

export type TreeChanges = ReturnType<typeof mountTreeChangeRoutes>;

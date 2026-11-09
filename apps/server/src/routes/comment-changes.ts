import { commentRoutes } from '@wikistow/contracts';
import { commentChangesSeenBy, schema, type CommentChange, type Database } from '@wikistow/server';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Log } from '../http/logger.ts';
import type { Routes } from '../http/mount.ts';

/** How long comment changes gather before anyone hears of them, as the tree's do. */
const GATHER_MS = 1000;

type Listener = {
  accountId: string;
  sessionId: string;
  hear: (pageIds: readonly string[]) => void;
  end: () => void;
};

/**
 * The comment changes stream (`commentRoutes.commentChanges`, decision 8).
 * `changed` takes a change to a comment as the database names it (see
 * `listenForTreeChanges`). Soon after, each open stream whose person can
 * read the changed comment now, by its audience and, for readers, the
 * reader history it was made in, hears of its page, with the others that
 * changed meanwhile. Nobody hears of a comment they can't read. `close`
 * ends every stream, so the server can stop.
 */
export function mountCommentChangeRoutes(routes: Routes, { db, log }: { db: Database; log: Log }) {
  const listeners = new Set<Listener>();
  const closing = new AbortController();
  let gathered = new Map<string, CommentChange>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function failed(error: unknown) {
    log({
      level: 'error',
      event: 'comment-changes-failed',
      name: error instanceof Error ? error.name : 'unknown',
    });
  }

  async function tell(changes: CommentChange[]) {
    // A stream lasts only as long as its session, as the tree's does.
    const open = [...listeners];
    const live = await liveSessions(open.map((listener) => listener.sessionId));
    for (const listener of open) if (!live.has(listener.sessionId)) listener.end();
    const accounts = new Set([...listeners].map((listener) => listener.accountId));
    await Promise.all(
      [...accounts].map(async (accountId) => {
        const pageIds = [...(await commentChangesSeenBy(db, accountId, changes))];
        if (pageIds.length === 0) return;
        for (const listener of listeners) {
          if (listener.accountId === accountId) listener.hear(pageIds);
        }
      }),
    );
  }

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

  routes.stream(commentRoutes.commentChanges, async (_body, { principal, signal }) => {
    const left = new AbortController();
    const ended = AbortSignal.any([signal, closing.signal, left.signal]);
    let heard = new Set<string>();
    let wake: (() => void) | null = null;
    const listener: Listener = {
      accountId: principal.accountId,
      sessionId: principal.sessionId,
      hear(pageIds) {
        for (const pageId of pageIds) heard.add(pageId);
        wake?.();
      },
      end: () => left.abort(),
    };
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
        const pageIds = [...heard];
        heard = new Set();
        yield { pageIds };
      }
    })();
  });

  return {
    changed: (change: CommentChange) => {
      if (listeners.size === 0) return;
      gathered.set(`${change.pageId} ${change.audience} ${change.readerHistoryFrom}`, change);
      timer ??= setTimeout(() => {
        const changes = [...gathered.values()];
        gathered = new Map();
        timer = null;
        tell(changes).catch(failed);
      }, GATHER_MS);
    },
    close: () => {
      if (timer) clearTimeout(timer);
      closing.abort();
    },
  };
}

export type CommentChanges = ReturnType<typeof mountCommentChangeRoutes>;

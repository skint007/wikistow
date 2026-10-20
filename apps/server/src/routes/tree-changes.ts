import { structureRoutes } from '@wikistow/contracts';
import { treesSeenBy, type Database } from '@wikistow/server';
import type { Log } from '../http/logger.ts';
import type { Routes } from '../http/mount.ts';

/**
 * How long changes gather before anyone hears of them. An agent making
 * fifty pages then costs an app one tree load a second, not fifty.
 */
const GATHER_MS = 1000;

type Listener = { accountId: string; hear: (spaceIds: readonly string[]) => void };

/**
 * The tree changes stream (`structureRoutes.treeChanges`). `changed` takes
 * a space whose tree changed, as the database names it
 * (`listenForTreeChanges`). A second later, every open stream whose person
 * sees some of that space hears of it, with the others that changed
 * meanwhile. `close` ends every stream, so the server can stop.
 */
export function mountTreeChangeRoutes(routes: Routes, { db, log }: { db: Database; log: Log }) {
  const listeners = new Set<Listener>();
  const closing = new AbortController();
  let gathered = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Each person's streams hear of the gathered spaces they see.
  async function tell() {
    const spaceIds = [...gathered];
    gathered = new Set();
    timer = null;
    const accounts = new Set([...listeners].map((listener) => listener.accountId));
    await Promise.all(
      [...accounts].map(async (accountId) => {
        const seen = [...(await treesSeenBy(db, accountId, spaceIds))];
        if (seen.length === 0) return;
        for (const listener of listeners) if (listener.accountId === accountId) listener.hear(seen);
      }),
    );
  }

  routes.stream(structureRoutes.treeChanges, (_body, { principal, signal }) => {
    const ended = AbortSignal.any([signal, closing.signal]);
    let heard = new Set<string>();
    let wake: (() => void) | null = null;
    const listener: Listener = {
      accountId: principal.accountId,
      hear(spaceIds) {
        for (const spaceId of spaceIds) heard.add(spaceId);
        wake?.();
      },
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
      gathered.add(spaceId);
      timer ??= setTimeout(() => {
        tell().catch((error: unknown) =>
          log({
            level: 'error',
            event: 'tree-changes-failed',
            name: error instanceof Error ? error.name : 'unknown',
          }),
        );
      }, GATHER_MS);
    },
    close: () => {
      if (timer) clearTimeout(timer);
      closing.abort();
    },
  };
}

export type TreeChanges = ReturnType<typeof mountTreeChangeRoutes>;

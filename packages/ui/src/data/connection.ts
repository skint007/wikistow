import { keptOperations, type ClientContext, type SpaceId } from '@wikistow/client';
import { noAnswer } from '@wikistow/client/api';
import { useMemo, useSyncExternalStore } from 'react';

/**
 * Whether the server answers (ADR 0009, decision 4). Offline, `heardAt` is
 * when it last did, if it ever did in this page's life.
 */
export type Connection = { online: true } | { online: false; heardAt: Date | null };

/** How often an offline app asks the server whether it is back. */
export const PROBE_MS = 30_000;

export { noAnswer };

let state: Connection = { online: true };
let heardAt: Date | null = null;
const listeners = new Set<() => void>();
// Asks the server whether it answers; true if it did. Set by the API client.
let probe: (() => Promise<boolean>) | null = null;
let stopProbing: (() => void) | null = null;

function set(next: Connection) {
  state = next;
  for (const listener of listeners) listener();
}

/**
 * The app's connection: offline from the first request that gets no
 * answer, online again at the first answer. While offline, requests go
 * nowhere (`api`), and the app asks `GET /api/installation` every 30
 * seconds, when the browser says it is online again, and when the tab or
 * window is shown again.
 */
export const connection = {
  get: (): Connection => state,

  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** The server answered, so the app is online. */
  heard() {
    heardAt = new Date();
    if (state.online) return;
    stopProbing?.();
    stopProbing = null;
    set({ online: true });
  },

  /** A request got no answer: the app is offline until one does. */
  lost() {
    if (!state.online) return;
    set({ online: false, heardAt });
    stopProbing = startProbing();
  },

  /**
   * Offline, ask the server now whether it answers, as when the person asks
   * to try again, rather than waiting for the next check.
   */
  async check(): Promise<void> {
    if (state.online || !probe) return;
    if (await probe()) connection.heard();
  },

  /** How to ask the server whether it answers, set once by the API client. */
  setProbe(ask: () => Promise<boolean>) {
    probe = ask;
  },
};

function startProbing(): () => void {
  let asking = false;
  const ask = () => {
    if (asking || !probe) return;
    asking = true;
    void probe()
      .then((answered) => answered && connection.heard())
      .finally(() => {
        asking = false;
      });
  };
  const timer = setInterval(ask, PROBE_MS);
  const shown = () => {
    if (document.visibilityState === 'visible') ask();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', ask);
    document.addEventListener('visibilitychange', shown);
  }
  return () => {
    clearInterval(timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', ask);
      document.removeEventListener('visibilitychange', shown);
    }
  };
}

/** The connection, kept current. */
export const useConnection = () => useSyncExternalStore(connection.subscribe, connection.get);

/** Whether the app is offline, kept current. */
export const useOffline = () => !useConnection().online;

/**
 * Offline, the pages of `spaceId` this device lists but doesn't keep, which
 * links read as not kept rather than missing (ADR 0009, decision 4);
 * undefined online.
 */
export function useNotKept(ctx: ClientContext, spaceId: SpaceId): ReadonlySet<string> | undefined {
  const offline = useOffline();
  return useMemo(
    () => (offline ? keptOperations.notKeptIn(ctx, spaceId) : undefined),
    [offline, ctx, spaceId],
  );
}

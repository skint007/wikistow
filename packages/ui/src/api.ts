import { ApiError, createApiClient } from '@wikistow/client/api';
import {
  accountRoutes,
  contactsRoutes,
  pageRoutes,
  systemRoutes,
  vaultRoutes,
} from '@wikistow/contracts';
import { queryOptions } from '@tanstack/react-query';
import { connection, noAnswer } from './data/connection';
import { forgetKeptMe, keepMe, keptMe } from './data/kept-store';

// How long a read waits for the answer's headers before it counts as no
// answer (ADR 0009, decision 4): a home server that's down often drops
// packets, and the system then waits a minute or more. The reads before
// the vault opens, and the probe, wait less. Writes, and downloads of
// attachments, keep no deadline here.
const READ_MS = 10_000;
const BEFORE_VAULT_MS = 5_000;
const BEFORE_VAULT = new Set<string>([
  accountRoutes.me.path,
  vaultRoutes.getVault.path,
  systemRoutes.installation.path,
  contactsRoutes.getContacts.path,
]);
const BLOBS = pageRoutes.BLOB_DOWNLOAD_PATH.replace(':hash', '');
// Reads sent as POST, for the many versions they ask for.
const BATCH_READS = new Set<string>([
  pageRoutes.fetchRevisions.path,
  pageRoutes.trashRevisions.path,
]);

/** Whether a request only reads: a GET, or one of the batch reads. */
const reads = (path: string, init: RequestInit) =>
  (init.method ?? 'GET') === 'GET' || BATCH_READS.has(path);

// Writes waiting for an answer, which going offline gives up, as lost answers.
const writes = new Set<AbortController>();
connection.subscribe(() => {
  if (connection.get().online) return;
  for (const write of writes) write.abort();
  writes.clear();
});

/** `fetch`, giving up on a read with no answer in time, and on a write once offline. */
async function withDeadline(url: string, init: RequestInit): Promise<Response> {
  const path = new URL(url, 'http://app').pathname;
  const reading = reads(path, init);
  const deadline = !reading
    ? null
    : BEFORE_VAULT.has(path)
      ? BEFORE_VAULT_MS
      : path.startsWith(BLOBS)
        ? null
        : READ_MS;
  const stop = new AbortController();
  const timer = deadline === null ? undefined : setTimeout(() => stop.abort(), deadline);
  if (!reading) writes.add(stop);
  try {
    return await fetch(url, { ...init, signal: stop.signal });
  } finally {
    clearTimeout(timer);
    writes.delete(stop);
  }
}

/**
 * `withDeadline`, telling `connection` whether the server answered. While
 * offline no read is sent: reads come from what's kept, without trying the
 * server for each, and the probe finds out when it is back. A write, which
 * the person just asked for (Try again on a save, say), asks the server
 * first, so one that answers again after a moment's outage takes it.
 */
async function connected(url: string, init: RequestInit): Promise<Response> {
  if (!connection.get().online && !reads(new URL(url, 'http://app').pathname, init)) {
    await connection.check();
  }
  if (!connection.get().online) throw new TypeError('Offline');
  let response: Response;
  try {
    response = await withDeadline(url, init);
  } catch (error) {
    connection.lost();
    throw error;
  }
  // A 5xx that isn't WikiStow's JSON is a proxy's: the server behind it is down.
  const json = response.headers.get('content-type')?.includes('application/json') ?? false;
  if (response.status >= 500 && !json) connection.lost();
  else connection.heard();
  return response;
}

/** The typed API client. The browser sends the session cookie itself. */
export const api = createApiClient({ fetch: connected });

// Offline, the app asks the installation's public facts to learn when the server is back.
const probing = createApiClient({ fetch: withDeadline });
connection.setProbe(() =>
  probing.call(systemRoutes.installation).then(
    () => true,
    (error: unknown) => !noAnswer(error),
  ),
);

/**
 * Why a request to the server failed, when it's the server's doing (#257):
 * no answer at all, an answer that isn't WikiStow's (a proxy's 404 for a
 * server that moved, or a page that isn't the API's JSON), or a server
 * failing for now (5xx). Null for anything else.
 */
export type ServerTrouble = 'unreachable' | 'not-wikistow' | 'failing';

export function serverTrouble(error: unknown): ServerTrouble | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'network') return 'unreachable';
  if (error.status >= 500) return 'failing';
  // A proxy's 404 page is unreadable too; WikiStow's own 404 names a code.
  if (error.code === 'unreadable-response') return 'not-wikistow';
  return null;
}

/**
 * The signed-in account, or null when there is no usable session (signed
 * out, suspended, or email unverified). With no answer from the server, the
 * answer this device kept, so the app goes on offline (ADR 0009, decision
 * 5). Any other failure, or no answer and none kept, throws, which `/_app`
 * shows as `SessionError`.
 */
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async () => {
    try {
      const me = await api.call(accountRoutes.me);
      await keepMe(me);
      return me;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        await forgetKeptMe();
        return null;
      }
      const kept = noAnswer(error) ? await keptMe() : null;
      if (kept) return kept;
      throw error;
    }
  },
  staleTime: 30_000,
});

/** Public facts about the installation, such as whether anyone may register. */
export const installationQuery = queryOptions({
  queryKey: ['installation'],
  queryFn: () => api.call(systemRoutes.installation),
});

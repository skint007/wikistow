import { ApiError, createApiClient } from '@wikistow/client/api';
import { accountRoutes, systemRoutes } from '@wikistow/contracts';
import { queryOptions } from '@tanstack/react-query';

/** The typed API client. The browser sends the session cookie itself. */
export const api = createApiClient();

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
 * out, suspended, or email unverified). Any other failure throws, which
 * `/_app` shows as `SessionError`.
 */
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async () => {
    try {
      return await api.call(accountRoutes.me);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return null;
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

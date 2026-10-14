import { ApiError, createApiClient } from '@wikistow/client/api';
import { accountRoutes, systemRoutes } from '@wikistow/contracts';
import { queryOptions } from '@tanstack/react-query';

/** The typed API client. The browser sends the session cookie itself. */
export const api = createApiClient();

/**
 * The signed-in account, or null when there is no usable session (signed
 * out, suspended, or email unverified).
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

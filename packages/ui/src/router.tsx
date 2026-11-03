import { MutationCache, onlineManager, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from '@wikistow/client/api';
import { meQuery } from './api';
import { connection } from './data/connection';
import { vaultStore } from './vault/store';
import { pluginRuntime } from './plugins/runtime';
import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export type RouterContext = { queryClient: QueryClient };

/** The app's router, given a history (browser in the web app, memory in tests). */
export function createAppRouter({ history }: { history: RouterHistory }) {
  // A request refused for lack of a session (signed out elsewhere, suspended)
  // re-checks who is signed in, which sends this tab back to sign-in.
  const sessionLost = (error: unknown) => {
    if (error instanceof ApiError && (error.status === 401 || error.code === 'account-suspended'))
      void queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
  };
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: sessionLost }),
    mutationCache: new MutationCache({ onError: sessionLost }),
    // Never paused for the browser's idea of offline: offline, queries read
    // what's kept (ADR 0009, decision 4), and the app has its own idea of it.
    defaultOptions: {
      // `refetchOnReconnect` is off by default with `networkMode: 'always'`.
      queries: {
        retry: false,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        networkMode: 'always',
      },
      mutations: { networkMode: 'always' },
    },
  });
  // Back online, what's shown loads again from the server (`refetchOnReconnect`).
  onlineManager.setEventListener((setOnline) =>
    connection.subscribe(() => setOnline(connection.get().online)),
  );
  vaultStore.attach(queryClient);
  pluginRuntime.start(queryClient);
  return createRouter({
    routeTree,
    history,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

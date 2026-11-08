import { MutationCache, onlineManager, QueryCache, QueryClient } from '@tanstack/react-query';
import { FolderId, PageId, SpaceId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { PluginError, type AppLocation } from '@wikistow/plugin-sdk';
import { meQuery } from './api';
import { connection } from './data/connection';
import { vaultStore } from './vault/store';
import { startAppPlugins, type AppPlugins } from './plugins/app-plugins';
import type { Place } from './plugins/location';
import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { z } from 'zod';

export type RouterContext = { queryClient: QueryClient; plugins: AppPlugins };

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
  const plugins = startAppPlugins(queryClient);
  const router = createRouter({
    routeTree,
    history,
    context: { queryClient, plugins },
    defaultPreload: 'intent',
    scrollRestoration: true,
  });
  // Plugins are told where the person is from here, whatever the app draws there.
  router.subscribe('onResolved', () => plugins.location.routed(locationOf(router)));
  plugins.location.navigateWith((to) => navigateTo(router, to));
  return router;
}

export type AppRouter = ReturnType<typeof createAppRouter>;

/** Where `router` is, as plugins see it. */
function locationOf(router: AppRouter): AppLocation {
  const match = router.state.matches.at(-1);
  switch (match?.routeId) {
    case '/_app/_vault/s/$spaceId/':
      return { kind: 'space', spaceId: match.params.spaceId };
    case '/_app/_vault/s/$spaceId/f/$folderId':
      return { kind: 'folder', spaceId: match.params.spaceId, folderId: match.params.folderId };
    case '/_app/_vault/s/$spaceId/p/$pageId':
      return { kind: 'page', spaceId: match.params.spaceId, pageId: match.params.pageId };
    case '/_app/_vault/plugin/$pluginId/$viewId':
      return { kind: 'plugin', pluginId: match.params.pluginId, viewId: match.params.viewId };
    case '/_app/_vault/s/$spaceId/members':
    case '/_app/_vault/s/$spaceId/groups/':
    case '/_app/_vault/s/$spaceId/groups/$groupId':
      return { kind: 'other', spaceId: match.params.spaceId };
    default:
      return { kind: 'other' };
  }
}

/** Go where a plugin asked, as a link there would. */
async function navigateTo(router: AppRouter, to: Place): Promise<void> {
  switch (to.kind) {
    case 'space':
      return router.navigate({ to: '/s/$spaceId', params: { spaceId: SpaceId.parse(to.spaceId) } });
    case 'folder':
      return router.navigate({
        to: '/s/$spaceId/f/$folderId',
        params: { spaceId: SpaceId.parse(to.spaceId), folderId: FolderId.parse(to.folderId) },
      });
    case 'page':
      return router.navigate({
        to: '/s/$spaceId/p/$pageId',
        params: { spaceId: SpaceId.parse(to.spaceId), pageId: PageId.parse(to.pageId) },
        search: to.version ? { view: to.version } : {},
      });
    case 'plugin':
      return router.navigate({
        to: '/plugin/$pluginId/$viewId',
        params: { pluginId: to.pluginId, viewId: z.string().min(1).parse(to.viewId) },
      });
    case 'settings':
      return router.navigate({ to: '/settings/plugins', search: { plugin: to.pluginId } });
    default:
      // A plugin's code isn't checked by its types.
      throw new PluginError('invalid', 'No such place to go');
  }
}

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

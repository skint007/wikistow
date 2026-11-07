import { searchOperations } from '@wikistow/client';
import { PageId, SpaceId } from '@wikistow/contracts';
import type { PageRef } from '@wikistow/plugin-sdk';
import type { FetchQueryOptions, QueryClient, QueryKey } from '@tanstack/react-query';
import { createContext, use } from 'react';
import { contentChanged } from '../data/content-changed';
import { spacesQuery, treeQuery } from '../data/queries';
import { desktop } from '../desktop';
import { PLAIN, vaultStore } from '../vault/store';
import { desktopStore } from './desktop-store';
import { editorDrafts } from './drafts';
import { browserStore } from './library';
import { createLocation } from './location';
import { createMarkdownDrawings } from './markdown-drawings';
import { pagesFor, session } from './pages';
import { createRuntime, type OpenDraft, type PluginSession } from './runtime';
import { isSafeModeKey, tabSafeMode } from './safe-mode';
import type { AppPluginStore } from './store';

/** The vault's session, as the app's plugins and the workshop's preview run in it. */
export const vaultSession: PluginSession = {
  get() {
    const vault = vaultStore.get();
    return vault.status === 'unlocked' ? vault.ctx : null;
  },
  subscribe: vaultStore.subscribe,
};

/**
 * Start the app's own plugins, once, as the app starts: the store of the
 * person's plugins and choices, and the runtime running them in the app's
 * page. In the desktop app the store holds those installed on this
 * computer and the library plugins it keeps copies of, in the browser the
 * library plugins the person approved. Settings → Plugins changes them only
 * through `store`. What plugins change shows afresh through `queryClient`.
 * `location` is where the person is, which the router and the page route
 * keep current (`router.tsx`). `markdown` holds what plugins draw with
 * the app's reader, which the shell draws (`RenderedMarkdown`).
 */
export function startAppPlugins(queryClient: QueryClient) {
  const drafts = editorDrafts();
  // Not `location`, which names the window's here.
  const where = createLocation();
  const markdown = createMarkdownDrawings();
  const store: AppPluginStore = desktop ? desktopStore(desktop) : browserStore();
  /**
   * What `query` holds, read again only once a change marked it (as
   * `contentChanged` and the tree's changes from the server do), or
   * joining a read already running: data nothing shows is never reloaded
   * by itself, and a plugin reading just after its own change gets it.
   */
  const latest = <T, K extends QueryKey>(query: FetchQueryOptions<T, Error, T, K>) =>
    queryClient.fetchQuery({ ...query, staleTime: Infinity });
  const own = createRuntime(store, {
    session: vaultSession,
    pages: (caller) =>
      pagesFor({
        ...caller,
        open: (page, base, change) => drafts.through(caller, page, base, change),
        // The sidebar's own tree, read again once a change marked it,
        // whether or not anything shows it (`latest`).
        tree: (ctx, spaceId) => latest(treeQuery(ctx, spaceId)),
      }),
    handle: (caller, shown) => drafts.handle(caller, shown),
    changed(spaceIdText, page) {
      const vault = vaultStore.get();
      if (vault.status !== 'unlocked') return;
      const spaceId = SpaceId.parse(spaceIdText);
      // Pages it moved show their new place.
      if (!page) void queryClient.invalidateQueries({ queryKey: [PLAIN, 'page'] });
      void contentChanged(queryClient, vault.ctx, {
        spaceId,
        pageId: page ? PageId.parse(page.pageId) : null,
      });
    },
    location: where,
    renderMarkdown: markdown.draw,
    async spaces(caller) {
      if (caller.access === 'none') return [];
      const granted = new Set(caller.scopes().map((scope) => scope.spaceId));
      // The rail's own listing, as `tree` reads the sidebar's: a plugin may draw the rail instead.
      const spaces = await latest(spacesQuery(session()));
      return spaces
        .filter((space) => granted.has(space.id))
        .map(({ id, metadata }) => ({
          spaceId: id,
          name: searchOperations.nameOf(metadata),
          icon: (metadata?.opened.kind === 'current' && metadata.opened.metadata.emoji) || null,
        }));
    },
  });
  const runtime = {
    ...own,
    /**
     * Turn safe mode on or off. The desktop app restarts its window. A browser
     * tab reloads to turn it on, so nothing a plugin left in the page stays,
     * and lists again to turn it off.
     */
    async setSafeMode(on: boolean) {
      if (desktop) return desktop.setSafeMode(on);
      tabSafeMode.set(on);
      if (on && own.get().plugins.some(({ plugin }) => plugin.enabled)) location.reload();
      else await own.refresh();
    },
    /** The draft view opened `page` in the editor; plugins change it through `draft` until the returned function runs. */
    openDraft: (page: PageRef, draft: OpenDraft) => drafts.open(page, draft),
    /** The editor saved a draft: told to every plugin but one it saved for. */
    editorSaved: (page: PageRef, revision: string) =>
      own.deliver({ event: 'draft.saved', payload: { page, revision } }, drafts.savedFor(page)),
  };
  own.start();
  // In a browser tab, Ctrl+Shift+Alt+P turns on safe mode; the desktop's main catches it there.
  // Captured before anything a plugin adds can stop it.
  if (!desktop) {
    window.addEventListener(
      'keydown',
      (event) => {
        if (!isSafeModeKey(event)) return;
        event.preventDefault();
        void runtime.setSafeMode(true);
      },
      { capture: true },
    );
  }
  return { store, runtime, location: where, markdown };
}

/**
 * The app's own plugins: the store of them, the runtime running them,
 * where the person is, and what they draw with the app's reader.
 */
export type AppPlugins = ReturnType<typeof startAppPlugins>;

export const AppPluginsContext = createContext<AppPlugins | null>(null);

/** The app's own plugins, which Settings and the shell always use, in the workshop's preview too. */
export function useAppPlugins(): AppPlugins {
  const plugins = use(AppPluginsContext);
  if (!plugins) throw new Error('The app’s plugins haven’t started');
  return plugins;
}

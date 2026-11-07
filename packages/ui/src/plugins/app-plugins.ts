import { PageId, SpaceId } from '@wikistow/contracts';
import type { PageRef } from '@wikistow/plugin-sdk';
import type { QueryClient } from '@tanstack/react-query';
import { createContext, use } from 'react';
import { pageQuery, searchIndexChanged, treeQuery } from '../data/queries';
import { desktop } from '../desktop';
import { PLAIN, vaultStore } from '../vault/store';
import { desktopStore } from './desktop-store';
import { editorDrafts } from './drafts';
import { browserStore } from './library';
import { pagesFor } from './pages';
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
 */
export function startAppPlugins(queryClient: QueryClient) {
  const drafts = editorDrafts();
  const store: AppPluginStore = desktop ? desktopStore(desktop) : browserStore();
  const own = createRuntime(store, {
    session: vaultSession,
    pages: (caller) =>
      pagesFor({
        ...caller,
        open: (page, base, change) => drafts.through(caller, page, base, change),
      }),
    handle: (caller, shown) => drafts.handle(caller, shown),
    changed(spaceIdText, page) {
      const vault = vaultStore.get();
      if (vault.status !== 'unlocked') return;
      const spaceId = SpaceId.parse(spaceIdText);
      if (page) {
        const pageId = PageId.parse(page.pageId);
        void queryClient.invalidateQueries({ queryKey: pageQuery(vault.ctx, pageId).queryKey });
      } else {
        // Pages it moved show their new place.
        void queryClient.invalidateQueries({ queryKey: [PLAIN, 'page'] });
      }
      void queryClient.invalidateQueries({ queryKey: treeQuery(vault.ctx, spaceId).queryKey });
      searchIndexChanged(queryClient, { spaceIds: [spaceId] });
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
  return { store, runtime };
}

/** The app's own plugins: the store of them, and the runtime running them. */
export type AppPlugins = ReturnType<typeof startAppPlugins>;

export const AppPluginsContext = createContext<AppPlugins | null>(null);

/** The app's own plugins, which Settings and the shell always use, in the workshop's preview too. */
export function useAppPlugins(): AppPlugins {
  const plugins = use(AppPluginsContext);
  if (!plugins) throw new Error('The app’s plugins haven’t started');
  return plugins;
}

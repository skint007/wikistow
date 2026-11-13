import { linkablePages, patient, searchOperations, trashOperations } from '@wikistow/client';
import { PageId, pageRoutes, SpaceId } from '@wikistow/contracts';
import { PluginError, type PageRef } from '@wikistow/plugin-sdk';
import {
  QueryObserver,
  type FetchQueryOptions,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { createContext, use } from 'react';
import { contentChanged } from '../data/content-changed';
import { pageWriter } from '../data/offline-changes';
import { queueOf, searchIndexQuery, spacesQuery, trashQuery, treeQuery } from '../data/queries';
import { showNotice } from '../page/undo-notice';
import { pageTitle } from '../shell/sidebar';
import { desktop } from '../desktop';
import { PLAIN, vaultStore } from '../vault/store';
import { desktopStore } from './desktop-store';
import { editorDrafts } from './drafts';
import { browserStore } from './library';
import { createLocation } from './location';
import { createMarkdownDrawings } from './markdown-drawings';
import { indexChanges } from './page-rows';
import { batchTurn, pagesFor, pluginError, session, type Caller } from './pages';
import { createRuntime, type OpenDraft, type PluginSession } from './runtime';
import { isSafeModeKey, tabSafeMode } from './safe-mode';
import { pluginTrashPrompts } from './trash-prompts';
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

  /**
   * The search index followed, as a query table follows it while shown:
   * built if it isn't, updated after each change, and each new index told
   * to the runtime as what changed since the one before.
   */
  const followIndex = () => {
    const vault = vaultStore.get();
    if (vault.status !== 'unlocked') return () => {};
    const observer = new QueryObserver(queryClient, searchIndexQuery(vault.ctx, queryClient));
    let told = observer.getCurrentResult().data;
    return observer.subscribe(({ data }) => {
      if (!data || data === told) return;
      const changes = indexChanges(told, data);
      told = data;
      own.indexChanged(changes);
    });
  };
  // Followed while any plugin listens for `index.changed`.
  let watchers = 0;
  let unfollow = () => {};
  const watchIndex = () => {
    watchers += 1;
    if (watchers === 1) unfollow = followIndex();
    return () => {
      watchers -= 1;
      if (watchers === 0) unfollow();
    };
  };
  /**
   * Move `pages` to the trash for `caller`, once the person agrees in one
   * prompt listing them all, as the app's own Delete does: one at a time,
   * at the batches' pace, waiting out the server's limits. Then the trees
   * show them gone, and a notice offers Undo, as for a page deleted in the
   * app. Only a space's owners delete there, which is checked before
   * anything is asked.
   */
  const trash = async (
    caller: Caller,
    ctx: ReturnType<typeof session>,
    pages: readonly PageRef[],
    mayStill: (page: { spaceId: SpaceId; pageId: PageId }) => Promise<void>,
  ): Promise<boolean> => {
    const spaceIds = [...new Set(pages.map(({ spaceId }) => SpaceId.parse(spaceId)))];
    const spaces = await latest(spacesQuery(ctx));
    if (!spaceIds.every((id) => spaces.find((space) => space.id === id)?.role === 'owner'))
      throw new PluginError('forbidden', 'Only a space’s owners move its pages to the trash');
    const titles = new Map<string, { title: string | null; folders: readonly string[] }>();
    for (const spaceId of spaceIds) {
      for (const { id, title, folders } of linkablePages(await latest(treeQuery(ctx, spaceId))))
        titles.set(id, { title, folders });
    }
    // A page only: a folder's ID would take everything in it, which the prompt wouldn't list.
    if (!pages.every(({ pageId }) => titles.has(pageId)))
      throw new PluginError('not-found', 'There is no such page');
    // One with changes waiting on this device would go for good if made
    // here, or after them: once they are sent, it goes as any other.
    const queue = queueOf(ctx);
    for (const { pageId } of pages) {
      if (await queue?.entry(PageId.parse(pageId)).catch(() => null))
        throw new PluginError(
          'unsupported',
          'A page has changes saved on this device only. Try again once they are sent.',
        );
    }
    const named = pages.map((page) => ({
      ...page,
      title: titles.get(page.pageId)?.title ?? null,
      folders: titles.get(page.pageId)?.folders ?? [],
    }));
    const agreed = await pluginTrashPrompts.ask(
      { plugin: caller.name, pages: named.map(({ title, folders }) => ({ title, folders })) },
      caller.signal,
    );
    if (!agreed || !caller.live()) return false;
    const unloaded = () => new PluginError('unloaded', 'The plugin was turned off');
    const writer = pageWriter(patient(ctx, unloaded, caller.signal));
    const trashed: PageId[] = [];
    // Offline, a delete waits on this device, to go once back online.
    let waiting = 0;
    try {
      for (const { spaceId, pageId, title } of named) {
        // Turned off meanwhile: the rest stay, as the batches stop.
        if (!caller.live()) throw unloaded();
        const nodeId = PageId.parse(pageId);
        const done = await batchTurn(async () => {
          await mayStill({ spaceId: SpaceId.parse(spaceId), pageId: nodeId });
          // What is typed in it here goes with it, as its draft.
          await drafts.flush(caller, { spaceId, pageId });
          return writer.deleteNode({
            spaceId: SpaceId.parse(spaceId),
            nodeId,
            node: 'page',
            name: pageTitle(title),
          });
        });
        if (done === 'trashed') trashed.push(nodeId);
        else waiting += 1;
        // Off it at once if shown, trashed or waiting to be, as the app's own
        // Delete goes to the space, so nothing is typed into it.
        const shown = where.shown()?.page;
        if (shown?.pageId === pageId)
          void where.navigate({ kind: 'space', spaceId: shown.spaceId });
      }
    } catch (error) {
      // Those before it went: the plugin is told how many, and the notice offers Undo.
      const { code, message } = pluginError(error);
      throw new PluginError(
        code,
        trashed.length === 0
          ? message
          : `${message} ${trashed.length} of ${named.length} pages went to the trash first.`,
      );
    } finally {
      for (const spaceId of spaceIds) void contentChanged(queryClient, ctx, { spaceId });
      for (const pageId of trashed) {
        const spaceId = SpaceId.parse(named.find((page) => page.pageId === pageId)?.spaceId);
        void contentChanged(queryClient, ctx, { spaceId, pageId });
      }
      void queryClient.invalidateQueries({ queryKey: trashQuery(ctx).queryKey });
      const pagesOf = (n: number) => (n === 1 ? 'a page' : `${n} pages`);
      const later = waiting === 0 ? '' : ` ${pagesOf(waiting)} go once you’re back online.`;
      if (trashed.length === 0 && waiting > 0)
        showNotice({ ctx, message: `${caller.name}: ${later.trim()}` });
      if (trashed.length > 0) {
        showNotice({
          ctx,
          message: `${caller.name} moved ${pagesOf(trashed.length)} to the trash.${later}`,
          // Back at the batches' pace too, the trash listed once.
          undo: async () => {
            const waiting = patient(ctx, unloaded);
            const { items } = await waiting.api.call(pageRoutes.listTrash);
            const back = new Set<string>(trashed);
            for (const { trashId, nodeId } of items) {
              if (back.has(nodeId))
                await batchTurn(() => trashOperations.restoreTrash(waiting, trashId));
            }
            for (const spaceId of spaceIds) await contentChanged(queryClient, ctx, { spaceId });
            await queryClient.invalidateQueries({ queryKey: trashQuery(ctx).queryKey });
          },
        });
      }
    }
    return true;
  };

  const own = createRuntime(store, {
    session: vaultSession,
    pages: (caller) =>
      pagesFor({
        ...caller,
        open: (page, base, change) => drafts.through(caller, page, base, change),
        // The sidebar's own tree, read again once a change marked it,
        // whether or not anything shows it (`latest`).
        tree: (ctx, spaceId) => latest(treeQuery(ctx, spaceId)),
        // The index query tables read, as up to date as `tree`.
        index: (ctx) => latest(searchIndexQuery(ctx, queryClient)),
        flush: (page) => drafts.flush(caller, page),
        trash: (ctx, pages, mayStill) =>
          trash(caller, ctx, pages, mayStill).catch((error: unknown) => {
            throw pluginError(error);
          }),
      }),
    watchIndex,
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

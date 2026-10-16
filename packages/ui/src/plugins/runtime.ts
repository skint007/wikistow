import type { PayloadChanges } from '@wikistow/client';
import { PageId, SpaceId, type InstalledPlugin, type PluginScope } from '@wikistow/contracts';
import {
  blockLanguage,
  isRegion,
  PLUGIN_API,
  PluginError,
  type AppHost,
  type AppPlugin,
  type Block,
  type BlockProps,
  type Command,
  type Disposer,
  type PageHandle,
  type PageRef,
  type Pages,
  type PageVersion,
  type PageViewProps,
  type PluginEvent,
  type PluginEvents,
  type Regions,
  type View,
} from '@wikistow/plugin-sdk';
import type { QueryClient } from '@tanstack/react-query';
import { createContext, use, useSyncExternalStore } from 'react';
import { pageQuery, searchIndexChanged, treeQuery } from '../data/queries';
import { desktop } from '../desktop';
import { PLAIN, vaultStore } from '../vault/store';
import { pagesFor, pluginError, writeLimit, type Caller } from './pages';
import type { BlockSpec, OutputResult } from '@wikistow/plugin-sdk/protocol';
import { formView, readFields, type ReadField } from './block-form';
import { editorDrafts } from './drafts';
import { librarySource } from './library';
import { isSafeModeKey, tabSafeMode } from './safe-mode';
import { inFrame } from './script-frame';
import { inWorker, ScriptWorker } from './script-worker';

/** The page a command runs on or a panel shows, as the page view knows it. */
export type ShownPage = {
  page: PageRef;
  version: PageVersion['version'];
  revision: string;
  /** In the draft view: the open editor, which plugins change the draft through. */
  draft: OpenDraft | null;
};

/** A draft open in this window's editor. */
export type OpenDraft = {
  /** The editor is open: until then nothing is typed, and the draft is the one the view opened. */
  ready: () => boolean;
  /** Save what is typed; fails while the editor is still opening. */
  flush: () => Promise<void>;
  /** The draft revision everything shown is saved in, or null while some of it isn't. */
  saved: () => string | null;
  /** Throw `PageTooLarge` if the draft with `changes` couldn't be saved. */
  fits: (changes: PayloadChanges) => void;
  /** Change the draft as the person's own edit, which the editor shows and saves. */
  revise: (changes: PayloadChanges) => void;
};

export type PluginCommand = { pluginId: string; id: string; title: string };
/** What a plugin registered in a region, with the plugin's ID. */
export type Contribution<R extends keyof Regions> = Regions[R] & { pluginId: string };
export type PluginPanel = Contribution<'page.panel'>;
/** A theme an enabled plugin adds to the theme picker. */
export type PluginThemeOption = {
  pluginId: string;
  /** The plugin's name, to tell two themes of the same name apart. */
  pluginName: string;
  id: string;
  name: string;
  base: 'light' | 'dark';
  /** Its stylesheet, served from the app's own origin. */
  href: string;
};
export type PluginBlock = { pluginId: string; type: string; view: View<BlockProps> };
export type PluginStatus = { plugin: InstalledPlugin; problem: string | null };

export type PluginsSnapshot = {
  /**
   * What is installed is known: false as the desktop app starts, until it
   * answers, and in the browser while the vault is locked, since the
   * approvals are encrypted, or until the library is first listed.
   */
  listed: boolean;
  safeMode: boolean;
  plugins: PluginStatus[];
  commands: PluginCommand[];
  /** What running plugins put in each region, in plugin order, then registration order. */
  regions: { [R in keyof Regions]: Contribution<R>[] };
  /** Enabled plugins' themes, whether or not the vault is open: themes are styles. */
  themes: PluginThemeOption[];
  /** Each block type a running plugin draws, by its fence's info string. */
  blocks: ReadonlyMap<string, PluginBlock>;
};

/** A region's registrations, by their IDs. */
type Registered = { [R in keyof Regions]: Map<string, Regions[R]> };

const noneRegistered = (): Registered => ({
  'page.panel': new Map(),
  'page.toolbar': new Map(),
  'page.header': new Map(),
  'page.footer': new Map(),
  'page.aside': new Map(),
  'app.view': new Map(),
  rail: new Map(),
  'settings.section': new Map(),
});

type Handlers = {
  [E in keyof PluginEvents]: Set<(event: PluginEvents[E]) => void | Promise<void>>;
};

/** One enabled plugin's activation, from unlock to lock or unload. */
type Active = {
  controller: AbortController;
  caller: Caller;
  disposers: Set<Disposer>;
  commands: Map<string, Command>;
  regions: Registered;
  blocks: Map<string, Block>;
  handlers: Handlers;
  app: AppPlugin | null;
  worker: ScriptWorker | null;
  /** The script's commands, by ID with their titles. */
  scriptCommands: ReadonlyMap<string, string>;
  /** The blocks the script fills in, by type, each with the form drawn for it. */
  scriptBlocks: ReadonlyMap<string, { spec: BlockSpec; view: View<BlockProps> }>;
  /** Each event and page whose handler runs now, with the latest that arrived meanwhile. */
  running: Map<string, { next: PluginEvent | null }>;
};

type Loaded = {
  plugin: InstalledPlugin;
  links: HTMLLinkElement[];
  active: Active | null;
  /** Its latest activation, settled once its app code's `activate` has. */
  starting: Promise<void>;
  /** What went wrong with its app code, and with its script, until it activates again. */
  problems: { app: string | null; script: string | null };
};

const fileUrl = ({ manifest, key }: InstalledPlugin, file: string) =>
  `/plugins/${manifest.id}/${key}/${file}`;

/** What `entries` registered in each region, in their order. */
function contributions(entries: Loaded[]): PluginsSnapshot['regions'] {
  const of = <R extends keyof Regions>(region: R): Contribution<R>[] =>
    entries.flatMap(({ plugin, active }) =>
      active
        ? [...active.regions[region].values()].map((item) => ({
            ...item,
            pluginId: plugin.manifest.id,
          }))
        : [],
    );
  return {
    'page.panel': of('page.panel'),
    'page.toolbar': of('page.toolbar'),
    'page.header': of('page.header'),
    'page.footer': of('page.footer'),
    'page.aside': of('page.aside'),
    'app.view': of('app.view'),
    rail: of('rail'),
    'settings.section': of('settings.section'),
  };
}

const isAppPlugin = (value: unknown): value is AppPlugin =>
  typeof value === 'object' &&
  value !== null &&
  'activate' in value &&
  typeof value.activate === 'function';

/**
 * Empty the origin's IndexedDB and Cache Storage. Scripts' workers share
 * the app's origin and can keep data there, and the desktop app itself
 * keeps nothing there (a browser tab's kept unlock, `tab-unlock.ts`, isn't
 * used in it), so whatever is there is a plugin's: page text it cached
 * mustn't outlive the vault's lock. If the desktop app ever stores
 * anything there, scripts need an origin of their own first (ADR 0001).
 */
async function clearScriptStorage() {
  try {
    for (const { name } of await indexedDB.databases()) if (name) indexedDB.deleteDatabase(name);
    for (const key of await caches.keys()) await caches.delete(key);
  } catch {
    // Storage the browser won't list, as in a private window, holds nothing.
  }
}

const fire = <E extends keyof PluginEvents>(set: Handlers[E], payload: PluginEvents[E]) =>
  Promise.all([...set].map(async (handler) => handler(payload)));

/** Where a runtime's plugins come from, and what they reach. */
export type RuntimeSource = {
  /**
   * The plugins here, enabled or not, and whether safe mode is on. Plugins
   * null: not known now, as the browser's while the vault is locked. The
   * runtime lists again whenever the vault locks or unlocks.
   */
  list(): Promise<{ safeMode: boolean; plugins: InstalledPlugin[] | null }>;
  /** The open account's page access settings, by plugin. */
  access(): Promise<Record<string, PluginScope[]>>;
  /** Replace one plugin's page access for the open account. */
  setAccess(pluginId: string, scopes: PluginScope[]): Promise<void>;
  /** The page operations a plugin gets as `host.pages`. */
  pages(caller: Caller): Pages;
  /** The handle a command or view gets for the page shown. */
  handle(caller: Caller, shown: ShownPage): PageHandle;
  /** Turn a plugin off, from where its view failed. */
  disable(pluginId: string): Promise<void>;
  /**
   * It empties the origin's script storage as it starts. Only the app's own
   * runtime does: scripts of every runtime share that storage.
   */
  ownsStorage: boolean;
};

/**
 * The plugins `source` lists, running, and everything they registered. A
 * plugin's styles load while it is listed. Its code runs while the vault
 * is open: unlocking activates it, and locking or signing out ends its
 * worker, aborts its `signal` and drops what it registered, as disabling
 * does. In safe mode nothing loads. `pluginRuntime` runs the plugins
 * installed here (the desktop's) or approved from the library (the
 * browser's); the workshop runs one of its own (#257).
 */
export function createRuntime(source: RuntimeSource) {
  const loaded = new Map<string, Loaded>();
  /** Installed but not running: disabled, or everything in safe mode. Listed for Settings. */
  let idle: InstalledPlugin[] = [];
  /** The open account's page access settings, by plugin. */
  let access: Record<string, PluginScope[]> = {};
  let safeMode = false;
  let queryClient: QueryClient | null = null;
  const listeners = new Set<() => void>();
  let listed = false;
  let snapshot: PluginsSnapshot = {
    listed,
    safeMode: false,
    plugins: [],
    commands: [],
    regions: contributions([]),
    themes: [],
    blocks: new Map(),
  };
  // Counts unlocks and locks, so an activation that finishes after one is dropped.
  let epoch = 0;

  const emit = () => {
    const entries = [...loaded.values()];
    snapshot = {
      listed,
      safeMode,
      plugins: [
        ...entries.map(({ plugin, problems }) => ({
          plugin,
          problem: [problems.app, problems.script].filter(Boolean).join(' ') || null,
        })),
        ...idle.map((plugin) => ({ plugin, problem: null })),
      ],
      commands: entries.flatMap(({ plugin, active }) =>
        active
          ? [
              ...[...active.commands.values()].map(({ id, title }) => ({ id, title })),
              ...[...active.scriptCommands].map(([id, title]) => ({ id, title })),
            ].map((command) => ({ pluginId: plugin.manifest.id, ...command }))
          : [],
      ),
      regions: contributions(entries),
      themes: entries.flatMap(({ plugin }) =>
        plugin.manifest.themes.map(({ id, name, base, stylesheet }) => ({
          pluginId: plugin.manifest.id,
          pluginName: plugin.manifest.name,
          id,
          name,
          base,
          href: fileUrl(plugin, stylesheet),
        })),
      ),
      blocks: new Map(
        entries.flatMap(({ plugin, active }) =>
          active
            ? [
                ...[...active.scriptBlocks].map(([type, { view }]) => ({ type, view })),
                ...active.blocks.values(),
              ].map(({ type, view }): [string, PluginBlock] => [
                blockLanguage(plugin.manifest.id, type),
                { pluginId: plugin.manifest.id, type, view },
              ])
            : [],
        ),
      ),
    };
    for (const listener of listeners) listener();
  };

  const problem = (entry: Loaded, part: 'app' | 'script', message: string) => {
    entry.problems[part] = message;
    emit();
  };

  /** A plugin changed a space's tree: show it afresh. */
  const changed = (spaceId: string) => {
    const vault = vaultStore.get();
    if (!queryClient || vault.status !== 'unlocked') return;
    void queryClient.invalidateQueries({
      queryKey: treeQuery(vault.ctx, SpaceId.parse(spaceId)).queryKey,
    });
    // Pages it moved show their new place.
    void queryClient.invalidateQueries({ queryKey: [PLAIN, 'page'] });
    searchIndexChanged(queryClient);
  };

  /** A plugin's draft save: shown afresh, and told to the other plugins. */
  const wrote = (pluginId: string, page: PageRef, revision: string) => {
    const vault = vaultStore.get();
    if (queryClient && vault.status === 'unlocked') {
      const { pageId, spaceId } = {
        pageId: PageId.parse(page.pageId),
        spaceId: SpaceId.parse(page.spaceId),
      };
      void queryClient.invalidateQueries({ queryKey: pageQuery(vault.ctx, pageId).queryKey });
      void queryClient.invalidateQueries({ queryKey: treeQuery(vault.ctx, spaceId).queryKey });
      searchIndexChanged(queryClient);
    }
    deliver({ event: 'draft.saved', payload: { page, revision } }, pluginId);
  };

  function deliver(event: PluginEvent, from: string | null = null) {
    for (const [id, entry] of loaded) {
      const { active } = entry;
      if (!active || id === from) continue;
      const listens =
        active.handlers[event.event].size > 0 || active.worker?.listens(event.event) === true;
      if (!listens) continue;
      // One handler run at a time per event and page; the latest waiting replaces the rest.
      const key = `${event.event}:${event.payload.page.pageId}`;
      const running = active.running.get(key);
      if (running) {
        running.next = event;
        continue;
      }
      const slot: { next: PluginEvent | null } = { next: null };
      active.running.set(key, slot);
      void (async () => {
        for (let next: PluginEvent | null = event; next; next = slot.next) {
          slot.next = null;
          try {
            await handle(active, next);
          } catch (error) {
            if (entry.active === active) {
              const part = active.worker?.listens(next.event) ? 'script' : 'app';
              problem(
                entry,
                part,
                `Its ${next.event} handler failed: ${pluginError(error).message}`,
              );
            }
          }
        }
        active.running.delete(key);
      })();
    }
  }

  const handle = async (active: Active, event: PluginEvent) => {
    switch (event.event) {
      case 'page.shown':
        await fire(active.handlers['page.shown'], event.payload);
        break;
      case 'draft.saved':
        await fire(active.handlers['draft.saved'], event.payload);
        break;
    }
    if (active.worker?.listens(event.event)) await active.worker.deliver(event);
  };

  const unloaded = () => new PluginError('unloaded', 'The plugin was turned off');

  /** Each activation's views' last props, by view, with the page and version they are for. */
  const viewProps = new WeakMap<Active, Map<string, { key: string; props: PageViewProps }>>();

  const deactivate = (entry: Loaded) => {
    const { active } = entry;
    if (!active) return;
    entry.active = null;
    active.controller.abort();
    for (const dispose of active.disposers) {
      try {
        dispose();
      } catch {
        // Its own cleanup; the registrations go regardless.
      }
    }
    try {
      active.app?.deactivate?.();
    } catch {
      // As above.
    }
    active.worker?.stop();
  };

  async function activate(entry: Loaded) {
    if (entry.active) return;
    const { plugin } = entry;
    const { manifest } = plugin;
    const id = manifest.id;
    const run = epoch;
    // One count of writes a minute, for the page operations and page edits alike.
    const write = writeLimit();
    const caller: Caller = {
      id,
      access: manifest.access,
      scopes: () => access[id] ?? [],
      live: () => live(),
      write,
      wrote: (page, revision) => wrote(id, page, revision),
      changed,
    };
    const active: Active = {
      controller: new AbortController(),
      caller,
      disposers: new Set(),
      commands: new Map(),
      regions: noneRegistered(),
      blocks: new Map(),
      handlers: { 'page.shown': new Set(), 'draft.saved': new Set() },
      app: null,
      worker: null,
      scriptCommands: new Map(),
      scriptBlocks: new Map(),
      running: new Map(),
    };
    entry.active = active;
    entry.problems = { app: null, script: null };
    const live = () => entry.active === active && run === epoch;
    const keep = (dispose: Disposer): Disposer => {
      const once = () => {
        if (!active.disposers.delete(once)) return;
        dispose();
        if (live()) emit();
      };
      active.disposers.add(once);
      return once;
    };
    const host: AppHost = {
      api: PLUGIN_API,
      pluginId: id,
      pages: source.pages(caller),
      signal: active.controller.signal,
      commands: {
        register(command) {
          if (!live()) return () => {};
          active.commands.set(command.id, command);
          emit();
          return keep(() => {
            if (active.commands.get(command.id) === command) active.commands.delete(command.id);
          });
        },
      },
      events: {
        on(event, handler) {
          if (!live()) return () => {};
          const set: Handlers[typeof event] = active.handlers[event];
          set.add(handler);
          return keep(() => set.delete(handler));
        },
      },
      blocks: {
        register(block) {
          if (!live()) return () => {};
          if (!manifest.blocks.includes(block.type)) {
            throw new PluginError('invalid', `Its manifest claims no block ${block.type}`);
          }
          active.blocks.set(block.type, block);
          emit();
          return keep(() => {
            if (active.blocks.get(block.type) === block) active.blocks.delete(block.type);
          });
        },
      },
      ui: {
        register(region, contribution) {
          if (!live()) return () => {};
          // A plugin built for a newer app may name a region this one lacks.
          if (!isRegion(region))
            throw new PluginError('unsupported', `No region ${String(region)}`);
          const registered = active.regions[region];
          registered.set(contribution.id, contribution);
          emit();
          return keep(() => {
            if (registered.get(contribution.id) === contribution)
              registered.delete(contribution.id);
          });
        },
      },
    };
    if (manifest.script) {
      const script = fileUrl(plugin, manifest.script);
      // The desktop app runs scripts on its own origin until they move to the frame too (ADR 0002).
      const launch = desktop ? inWorker(script) : inFrame(script, manifest.id);
      active.worker = new ScriptWorker(launch, host.pages, {
        commands: (commands) => {
          active.scriptCommands = commands;
          if (live()) emit();
        },
        blocks: (specs) => {
          const next = new Map<string, { spec: BlockSpec; view: View<BlockProps> }>();
          for (const [type, spec] of specs) {
            if (!manifest.blocks.includes(type)) {
              if (live()) problem(entry, 'script', `Its manifest claims no block ${type}.`);
              continue;
            }
            // The same form as it starts again, so what is entered in it stays.
            const kept = active.scriptBlocks.get(type);
            next.set(
              type,
              kept && JSON.stringify(kept.spec) === JSON.stringify(spec)
                ? kept
                : {
                    spec,
                    view: formView(spec, (page, values) =>
                      active.worker
                        ? active.worker.calculate(type, page, values)
                        : Promise.reject(unloaded()),
                    ),
                  },
            );
          }
          active.scriptBlocks = next;
          if (live()) emit();
        },
        problem: (message) => {
          if (live()) problem(entry, 'script', message);
        },
      });
      active.worker.start();
    }
    if (manifest.ui) {
      try {
        const module: unknown = await import(/* @vite-ignore */ fileUrl(plugin, manifest.ui));
        const definition =
          typeof module === 'object' && module !== null && 'default' in module
            ? module.default
            : null;
        if (!isAppPlugin(definition))
          throw new Error('Its ui file has no definePlugin(…) default export');
        if (!live()) return;
        active.app = definition;
        await definition.activate(host);
      } catch (error) {
        if (live()) problem(entry, 'app', `It failed to start: ${pluginError(error).message}`);
      }
    }
    if (live()) emit();
  }

  const loadStyles = (plugin: InstalledPlugin) =>
    plugin.manifest.styles.map((file) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = fileUrl(plugin, file);
      link.dataset['plugin'] = plugin.manifest.id;
      document.head.append(link);
      return link;
    });

  const unload = (entry: Loaded) => {
    deactivate(entry);
    for (const link of entry.links) link.remove();
    loaded.delete(entry.plugin.manifest.id);
  };

  const unlocked = () => vaultStore.get().status === 'unlocked';

  async function readAccess() {
    access = unlocked() ? await source.access().catch(() => ({})) : {};
  }

  /**
   * Match what runs to the source's list: load what's new or changed,
   * unload the rest, and while the vault is open start what isn't running.
   */
  async function sync() {
    if (stopped) return;
    const state = await source.list();
    if (stopped) return;
    safeMode = state.safeMode;
    const plugins = state.plugins ?? [];
    const wanted = new Map(
      (safeMode ? [] : plugins.filter((plugin) => plugin.enabled)).map((plugin) => [
        plugin.manifest.id,
        plugin,
      ]),
    );
    for (const entry of [...loaded.values()]) {
      const next = wanted.get(entry.plugin.manifest.id);
      if (!next || next.key !== entry.plugin.key) unload(entry);
    }
    if (unlocked()) await readAccess();
    for (const plugin of wanted.values()) {
      const entry = loaded.get(plugin.manifest.id) ?? {
        plugin,
        links: loadStyles(plugin),
        active: null,
        starting: Promise.resolve(),
        problems: { app: null, script: null },
      };
      loaded.set(plugin.manifest.id, entry);
      if (unlocked() && !entry.active) entry.starting = activate(entry);
    }
    idle = plugins.filter((plugin) => !wanted.has(plugin.manifest.id));
    listed = state.plugins !== null;
    emit();
  }

  let watching = () => {};
  let stopped = false;

  // One at a time, in order: each Settings action asks for one.
  let syncing: Promise<void> = Promise.resolve();
  const refresh = () => (syncing = syncing.then(sync, sync));

  return {
    /** Start, once; with `client`, what plugins change shows afresh. */
    start(client: QueryClient | null) {
      queryClient = client;
      let was = vaultStore.get();
      watching = vaultStore.subscribe(() => {
        const now = vaultStore.get();
        const changed =
          now.status !== was.status ||
          (now.status === 'unlocked' && was.status === 'unlocked' && now.ctx !== was.ctx);
        was = now;
        if (!changed) return;
        epoch += 1;
        for (const entry of loaded.values()) deactivate(entry);
        emit();
        if (now.status !== 'unlocked') {
          access = {};
          if (source.ownsStorage) void clearScriptStorage();
        }
        // Listed again: the browser's plugins come and go with the account.
        void refresh();
      });
      // Left by a run that ended without locking, as when the app quits.
      if (source.ownsStorage) void clearScriptStorage().then(refresh);
      else void refresh();
    },
    /** Unload everything, for good: a workshop's preview, as the workshop ends. */
    stop() {
      stopped = true;
      watching();
      epoch += 1;
      for (const entry of [...loaded.values()]) unload(entry);
      emit();
    },
    refresh,
    access: (pluginId: string) => access[pluginId] ?? [],
    async setAccess(pluginId: string, scopes: PluginScope[]) {
      if (!unlocked()) return;
      await source.setAccess(pluginId, scopes);
      access = { ...access, [pluginId]: scopes };
      emit();
    },
    /** Tell every running plugin but `from` of `event`. */
    deliver: (event: PluginEvent, from: string | null = null) => deliver(event, from),
    disable: (pluginId: string) => source.disable(pluginId),
    /** One of a plugin's views failed where it is drawn: said beside the plugin until it starts again. */
    viewFailed(pluginId: string, error: unknown) {
      const entry = loaded.get(pluginId);
      if (entry?.active) problem(entry, 'app', `A view failed: ${pluginError(error).message}`);
    },
    /**
     * What a script's block shows for `source` on `page`: its fields as its
     * form reads them, and its outputs or why they failed. Null when no
     * running script fills in blocks of that `language`.
     */
    async blockResults(
      language: string,
      page: PageRef,
      source: string,
    ): Promise<{
      fields: Record<string, ReadField>;
      outputs: Record<string, OutputResult> | { error: string };
    } | null> {
      for (const { plugin, active } of loaded.values()) {
        const worker = active?.worker;
        if (!worker) continue;
        for (const [type, { spec }] of active.scriptBlocks) {
          if (blockLanguage(plugin.manifest.id, type) !== language) continue;
          const fields = readFields(spec, source);
          const values = Object.fromEntries(
            Object.entries(fields).flatMap(([id, { value }]) =>
              value === null ? [] : [[id, value]],
            ),
          );
          try {
            return { fields, outputs: await worker.calculate(type, page, values) };
          } catch (error) {
            return { fields, outputs: { error: pluginError(error).message } };
          }
        }
      }
      return null;
    },
    /**
     * Settled once a plugin has started: its app code's `activate` has
     * finished and its script is ready, or either failed, so what it
     * registers as it starts is in place.
     */
    async started(pluginId: string) {
      const entry = loaded.get(pluginId);
      await entry?.starting;
      await entry?.active?.worker?.started();
    },
    /** Run a plugin's command on the page shown. */
    async runCommand(pluginId: string, commandId: string, shown: ShownPage) {
      const entry = loaded.get(pluginId);
      const active = entry?.active;
      if (!entry || !active) throw new PluginError('unloaded', 'The plugin isn’t running');
      const page = source.handle(active.caller, shown);
      const command = active.commands.get(commandId);
      try {
        if (command) await command.run({ page });
        else if (active.worker && active.scriptCommands.has(commandId))
          await active.worker.runCommand(commandId, page);
        else throw new PluginError('unloaded', 'The command is gone');
      } catch (error) {
        throw pluginError(error);
      }
    },
    /**
     * What one of a plugin's views in a page's places (`view`, such as
     * `page.aside:<id>`) is given for the page shown: the same object while
     * the page, its version and the plugin's activation stay, so the view
     * isn't drawn again on every render. Each view has a handle of its own,
     * so its edits are checked against what it read.
     */
    pageViewProps(pluginId: string, view: string, shown: ShownPage): PageViewProps | null {
      const entry = loaded.get(pluginId);
      const active = entry?.active;
      if (!entry || !active) return null;
      const key = `${shown.page.spaceId}/${shown.page.pageId}/${shown.version}/${shown.revision}`;
      const views =
        viewProps.get(active) ?? new Map<string, { key: string; props: PageViewProps }>();
      viewProps.set(active, views);
      const last = views.get(view);
      if (last?.key === key) return last.props;
      const props = { page: source.handle(active.caller, shown) };
      views.set(view, { key, props });
      return props;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => snapshot,
  };
}

export type PluginRuntime = ReturnType<typeof createRuntime>;

const drafts = editorDrafts();

/** The desktop's plugins: folder and development installs on this computer, per device. */
const desktopSource = (
  bridge: NonNullable<typeof desktop>,
): Omit<RuntimeSource, 'pages' | 'handle'> => ({
  list: () => bridge.plugins(),
  async access() {
    const vault = vaultStore.get();
    if (vault.status !== 'unlocked') return {};
    return bridge.pluginAccess(vault.vault.accountId);
  },
  async setAccess(pluginId, scopes) {
    const vault = vaultStore.get();
    if (vault.status !== 'unlocked') return;
    await bridge.setPluginAccess(vault.vault.accountId, pluginId, scopes);
  },
  disable: (pluginId) => bridge.setPluginEnabled(pluginId, false),
  ownsStorage: true,
});

const ownSource = desktop ? desktopSource(desktop) : librarySource;

/**
 * The app's own plugins, running in its page: in the desktop app those
 * installed on this computer, in the browser the library plugins the
 * person approved.
 */
const ownRuntime = createRuntime({
  ...ownSource,
  pages: (caller) =>
    pagesFor({
      ...caller,
      open: (page, base, change) => drafts.through(caller, page, base, change),
    }),
  handle: (caller, shown) => drafts.handle(caller, shown),
  async disable(pluginId) {
    await ownSource.disable(pluginId);
    await pluginRuntime.refresh();
  },
});

export const pluginRuntime = {
  ...ownRuntime,
  /** Start, once. In a browser tab, Ctrl+Shift+Alt+P turns on safe mode; the desktop's main catches it there. */
  start(client: QueryClient | null) {
    ownRuntime.start(client);
    if (desktop) return;
    // Captured before anything a plugin adds can stop it.
    window.addEventListener(
      'keydown',
      (event) => {
        if (!isSafeModeKey(event)) return;
        event.preventDefault();
        void pluginRuntime.setSafeMode(true);
      },
      { capture: true },
    );
  },
  /**
   * Turn safe mode on or off. The desktop app restarts its window. A browser
   * tab reloads to turn it on, so nothing a plugin left in the page stays,
   * and lists again to turn it off.
   */
  async setSafeMode(on: boolean) {
    if (desktop) return desktop.setSafeMode(on);
    tabSafeMode.set(on);
    if (on && pluginRuntime.get().plugins.some(({ plugin }) => plugin.enabled)) location.reload();
    else await pluginRuntime.refresh();
  },
  /** The draft view opened `page` in the editor; plugins change it through `draft` until the returned function runs. */
  openDraft: (page: PageRef, draft: OpenDraft) => drafts.open(page, draft),
  /** The editor saved a draft: told to every plugin but one it saved for. */
  editorSaved(page: PageRef, revision: string) {
    pluginRuntime.deliver(
      { event: 'draft.saved', payload: { page, revision } },
      drafts.savedFor(page),
    );
  },
};

/**
 * The runtime the views inside it draw from: the app's own, or the
 * workshop's in its preview. Settings and the shell always use the app's.
 */
export const PluginsContext = createContext<PluginRuntime>(pluginRuntime);

export const usePluginRuntime = () => use(PluginsContext);

export const usePlugins = (): PluginsSnapshot => {
  const runtime = use(PluginsContext);
  return useSyncExternalStore(runtime.subscribe, runtime.get);
};

import type { PayloadChanges } from '@wikistow/client';
import type { InstalledPlugin, PluginScope } from '@wikistow/contracts';
import {
  blockLanguage,
  isRegion,
  isReplaceable,
  PLUGIN_API,
  PluginError,
  SETTINGS_LIMIT,
  type AppEvent,
  type AppHost,
  type AppLocation,
  type AppPlugin,
  type BlockProps,
  type Disposer,
  type InlineProps,
  type PageHandle,
  type PageRef,
  type PageVersion,
  type PageViewProps,
  type PluginSettings,
  type Regions,
  type Replacements,
  type Settings,
  type SettingsViewProps,
  type SpaceSummary,
  type View,
} from '@wikistow/plugin-sdk';
import {
  misfit,
  settingFits,
  settingsFit,
  settingsWithDefaults,
  SettingsValue,
} from '@wikistow/plugin-sdk/manifest';
import { createContext, use, useSyncExternalStore } from 'react';
import { formView, readFields } from './block-form';
import type { BlockProperties } from './block-properties';
import { pluginError, writeLimit, type Caller, type HostPages } from './pages';
import {
  createRegistry,
  perRegion,
  perReplaceable,
  type BlockResults,
  type HostEvent,
  type Part,
  type Registry,
} from './registry';
import type { PluginLocation } from './location';
import { MarkdownPage, type MarkdownDrawing } from './markdown-drawings';
import { inFrame } from './script-frame';
import { ScriptWorker, type LaunchScript } from './script-worker';
import { refOf, type AnyPluginStore, type PluginRef } from './store';

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
  /** What is selected where the cursor is, as Markdown, or `''`. */
  selection: () => string;
  /** Put Markdown in at the cursor as the person's own edit. */
  insert: (markdown: string) => void;
};

export type PluginCommand = { pluginId: string; id: string; title: string };
/** What a plugin registered in a region, with the plugin's ID. */
export type Contribution<R extends keyof Regions> = Regions[R] & { pluginId: string };
/** The view a plugin draws in place of a region, with the plugin's ID. */
export type Replacing<R extends keyof Replacements> = Replacements[R] & { pluginId: string };
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

/**
 * A claimed span's view as a block's, so it's drawn as blocks are
 * (`drawBlock`): its text is the block's source, and `setText` its
 * `setSource`. Made once per registration, as a new view draws afresh.
 */
const spanBlockView =
  (view: View<InlineProps>): View<BlockProps> =>
  (element, { source, page, setSource }) =>
    view(element, { text: source, page, setText: setSource });
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
  /** Plugins the source knows of but couldn't load, by ID, with why: a desktop's library plugin it couldn't install, or one whose version left the library. */
  unavailable: Readonly<Record<string, string>>;
  commands: PluginCommand[];
  /** What running plugins put in each region, in plugin order, then registration order. */
  regions: { [R in keyof Regions]: Contribution<R>[] };
  /**
   * The view drawn in place of each replaceable region: the first running
   * plugin's in plugin order that replaces it, unless the person chose the
   * app's own there (`ownParts`); null for the app's own part.
   */
  replaced: { [R in keyof Replacements]: Replacing<R> | null };
  /** Enabled plugins' themes, whether or not the vault is open: themes are styles. */
  themes: PluginThemeOption[];
  /** Each block type a running plugin draws, by its fence's info string. */
  blocks: ReadonlyMap<string, PluginBlock>;
  /**
   * Each inline code type a running plugin draws, by its span's claim
   * (`plugin:<id>/<type>`), its view drawn as a block's (`spanBlockView`).
   */
  inline: ReadonlyMap<string, PluginBlock>;
};

/** One enabled plugin's activation, from unlock to lock or unload. */
type Active = {
  controller: AbortController;
  caller: Caller;
  /** Its `host.pages`. */
  pages: HostPages;
  /** What its app code and its script registered. */
  registry: Registry;
  /** Its `host.settings`. */
  settings: PluginSettings;
  /** What its settings sections are given: the same object while it runs. */
  settingsProps: SettingsViewProps;
  app: AppPlugin | null;
  worker: ScriptWorker | null;
  /** Each event and page whose handlers run now, with the latest that arrived meanwhile. */
  running: Map<string, { next: HostEvent | null }>;
};

type Loaded = {
  plugin: InstalledPlugin;
  links: HTMLLinkElement[];
  active: Active | null;
  /** Its latest activation, settled once its app code's `activate` has. */
  starting: Promise<void>;
  /** What went wrong with its app code, and with its script, until it activates again. */
  problems: Record<Part, string | null>;
};

/** What a replacing view's plugin reaches, for what the region gives it. */
export type PluginPages = {
  pages: HostPages;
  /** The handle a view gets for the page shown, as a page's places give it. */
  handle: (shown: ShownPage) => PageHandle;
  /** The spaces it has page access in, as `host.app.spaces.list()` gives them. */
  spaces: () => Promise<SpaceSummary[]>;
  /** Whether its page access covers the whole of a space, not only some folders there. */
  readsAll: (spaceId: string) => boolean;
};

const fileUrl = ({ manifest, key }: InstalledPlugin, file: string) =>
  `/plugins/${manifest.id}/${key}/${file}`;

/** What `entries` registered in each region, in their order. */
const contributions = (entries: Loaded[]) =>
  perRegion<PluginsSnapshot['regions']>((region) =>
    entries.flatMap(({ plugin, active }) =>
      active
        ? [...active.registry.region(region)].map((item) => ({
            ...item,
            pluginId: plugin.manifest.id,
          }))
        : [],
    ),
  );

/** Each replaceable region's view, from the first of `entries` that draws it and the person lets. */
const replacedBy = (entries: Loaded[]) =>
  perReplaceable<PluginsSnapshot['replaced']>((region) => {
    for (const { plugin, active } of entries) {
      if (!active || plugin.ownParts.includes(region)) continue;
      const replacement = active.registry.replacement(region);
      if (replacement) return { ...replacement, pluginId: plugin.manifest.id };
    }
    return null;
  });

const EVENTS = {
  'page.shown': true,
  'draft.saved': true,
  'location.changed': true,
} as const satisfies {
  [E in AppEvent['event']]: true;
};
const isEvent = (name: string): name is AppEvent['event'] => Object.hasOwn(EVENTS, name);

const isAppPlugin = (value: unknown): value is AppPlugin =>
  typeof value === 'object' &&
  value !== null &&
  'activate' in value &&
  typeof value.activate === 'function';

/**
 * The vault session a runtime's plugins run in, which it watches: they run
 * while one is open, and each lock, unlock or change of account ends what runs.
 */
export type PluginSession = {
  /** The open session, or null while the vault is locked. Another value is another session. */
  get(): object | null;
  subscribe(listener: () => void): () => void;
};

/** Where a runtime gets a plugin's code. */
export type PluginCode = {
  /** Its ui file, loaded: a module whose default export is its `definePlugin(…)`. */
  app(plugin: InstalledPlugin): Promise<unknown>;
  /** What starts its script. */
  script(plugin: InstalledPlugin): LaunchScript;
};

/** The files the app serves for each plugin, with its script in the sandboxed frame. */
export const servedCode: PluginCode = {
  app: (plugin) => {
    if (!plugin.manifest.ui) return Promise.reject(new Error('It has no ui file'));
    return import(/* @vite-ignore */ fileUrl(plugin, plugin.manifest.ui));
  },
  script: (plugin) => {
    if (!plugin.manifest.script) throw new Error('It has no script');
    return inFrame(fileUrl(plugin, plugin.manifest.script), plugin.manifest.id);
  },
};

/** What a runtime's plugins run in and reach, apart from where they come from. */
export type PluginReach = {
  session: PluginSession;
  /** The page operations a plugin gets as `host.pages`. */
  pages(caller: Caller): HostPages;
  /** The handle a command or view gets for the page shown. */
  handle(caller: Caller, shown: ShownPage): PageHandle;
  /**
   * A plugin changed a space's tree (a folder made, something moved), or,
   * with `page`, saved that page's draft: what shows them, shown afresh.
   */
  changed(spaceId: string, page?: PageRef): void;
  /**
   * Where the person is, which app code reads and navigates through as
   * `host.app`: its changes are told to plugins as `location.changed`,
   * and the page it shows as `page.shown`.
   */
  location: PluginLocation;
  /** The spaces the person can open where `caller` has page access, for `host.app.spaces`. */
  spaces(caller: Caller): Promise<SpaceSummary[]>;
  /**
   * Draw Markdown into a plugin's element with the app's reader, for
   * `host.app.renderMarkdown`, where its `pages` can read the page; what undoes it.
   */
  renderMarkdown(drawing: MarkdownDrawing): Disposer;
  /** Where plugins' code comes from: `servedCode` unless given. */
  code?: PluginCode;
};

/**
 * The plugins `store` lists, running, and everything they registered,
 * reaching what `reach` gives them. A plugin's styles load while it is
 * listed. Its code runs while `reach.session` is open: opening activates
 * it, and locking or signing out ends its worker, aborts its `signal` and
 * drops what it registered, as disabling does. In safe mode nothing loads.
 * Each activation keeps what its app code and its script register in one
 * registry, which the snapshot, commands and events read without asking
 * which registered what. The app's runtime runs the plugins installed here
 * (the desktop's) or approved from the library (the browser's)
 * (`app-plugins.ts`); the workshop runs one of its own (#257). The runtime
 * lists again whenever the session opens, ends or changes.
 */
export function createRuntime(store: AnyPluginStore, reach: PluginReach) {
  const { session, code = servedCode } = reach;
  const loaded = new Map<string, Loaded>();
  /** Installed but not running: disabled, or everything in safe mode. Listed for Settings. */
  let idle: InstalledPlugin[] = [];
  /** The open account's page access settings, by plugin. */
  let access: Readonly<Record<string, readonly PluginScope[]>> = {};
  /** The open account's plugin settings, by plugin, as stored. */
  let settings: Readonly<Record<string, Settings>> = {};
  let safeMode = false;
  const listeners = new Set<() => void>();
  let listed = false;
  let unavailable: Readonly<Record<string, string>> = {};
  let snapshot: PluginsSnapshot = {
    listed,
    safeMode: false,
    plugins: [],
    unavailable,
    commands: [],
    regions: contributions([]),
    replaced: replacedBy([]),
    themes: [],
    blocks: new Map(),
    inline: new Map(),
  };
  /** The plugins' IDs in the store's order, which Settings lists them in. */
  let order: readonly string[] = [];
  const rank = (id: string) => {
    const at = order.indexOf(id);
    return at === -1 ? order.length : at;
  };
  // Counts sessions opened and ended, so an activation that finishes after one is dropped.
  let epoch = 0;

  /** The snapshot: what is loaded, and what each activation registered, in the store's order. */
  const emit = () => {
    const entries = [...loaded.values()].toSorted(
      (a, b) => rank(a.plugin.manifest.id) - rank(b.plugin.manifest.id),
    );
    const running = entries.flatMap(({ plugin, active }) =>
      active ? [{ pluginId: plugin.manifest.id, registry: active.registry }] : [],
    );
    snapshot = {
      listed,
      safeMode,
      unavailable,
      plugins: [
        ...entries.map(({ plugin, problems }) => ({
          plugin,
          problem: [problems.app, problems.script].filter(Boolean).join(' ') || null,
        })),
        ...idle.map((plugin) => ({ plugin, problem: null })),
      ].toSorted((a, b) => rank(a.plugin.manifest.id) - rank(b.plugin.manifest.id)),
      commands: running.flatMap(({ pluginId, registry }) =>
        [...registry.commands()].map(({ id, title }) => ({ pluginId, id, title })),
      ),
      regions: contributions(entries),
      replaced: replacedBy(entries),
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
        running.flatMap(({ pluginId, registry }) =>
          [...registry.blocks()].map(({ type, view }): [string, PluginBlock] => [
            blockLanguage(pluginId, type),
            { pluginId, type, view },
          ]),
        ),
      ),
      inline: new Map(
        running.flatMap(({ pluginId, registry }) =>
          [...registry.inline()].map(({ type, view }): [string, PluginBlock] => [
            blockLanguage(pluginId, type),
            { pluginId, type, view },
          ]),
        ),
      ),
    };
    for (const listener of listeners) listener();
  };

  const problem = (entry: Loaded, part: Part, message: string) => {
    entry.problems[part] = message;
    emit();
  };

  /** A plugin's draft save: shown afresh, and told to the other plugins. */
  const wrote = (pluginId: string, page: PageRef, revision: string) => {
    if (session.get()) reach.changed(page.spaceId, page);
    deliver({ event: 'draft.saved', payload: { page, revision } }, pluginId);
  };

  function deliver(event: AppEvent, from: string | null = null) {
    for (const [id, entry] of loaded) if (id !== from) tell(entry, event);
  }

  /** Run `entry`'s handlers of `event`, if it is running. */
  function tell(entry: Loaded, event: HostEvent) {
    const { active } = entry;
    if (!active || active.registry.handlersOf(event).length === 0) return;
    // One run of its handlers at a time per event and page (or for the
    // location and its settings, which name none); the latest waiting replaces the rest.
    const key =
      event.event === 'location.changed' || event.event === 'settings.changed'
        ? event.event
        : `${event.event}:${event.payload.page.pageId}`;
    const running = active.running.get(key);
    if (running) {
      running.next = event;
      return;
    }
    const slot: { next: HostEvent | null } = { next: null };
    active.running.set(key, slot);
    void (async () => {
      for (let next: HostEvent | null = event; next; next = slot.next) {
        slot.next = null;
        const told = next;
        // Its handlers run together, its app code's and its script's alike.
        await Promise.all(
          active.registry.handlersOf(told).map(async ({ part, run }) => {
            try {
              await run();
            } catch (error) {
              if (entry.active !== active) return;
              problem(
                entry,
                part,
                `Its ${told.event} handler failed: ${pluginError(error).message}`,
              );
            }
          }),
        );
      }
      active.running.delete(key);
    })();
  }

  /** The settings `plugin` reads now: what is stored, with its declared fields' defaults. */
  const settingsOf = (plugin: InstalledPlugin) =>
    settingsWithDefaults(plugin.manifest.settings, settings[plugin.manifest.id] ?? {});

  /**
   * Keep `next(stored)` as `plugin`'s settings for the open account, after
   * every change asked for before it: checked as a JSON object, against
   * `SETTINGS_LIMIT` and against its manifest's fields. What runs of the
   * plugin is told, its own change included.
   */
  function changeSettings(plugin: InstalledPlugin, next: (stored: Settings) => unknown) {
    const id = plugin.manifest.id;
    const done = syncing.then(async () => {
      if (!session.get()) throw new PluginError('locked', 'The vault is locked');
      // A value its field no longer takes (an update changed the field) reads as the
      // default, so it goes rather than failing every change after it.
      const fitting = Object.fromEntries(
        Object.entries(settings[id] ?? {}).filter(([key, value]) => {
          const field = plugin.manifest.settings?.find((declared) => declared.key === key);
          return !field || settingFits(field, value);
        }),
      );
      const read = SettingsValue.safeParse(next(fitting));
      if (!read.success) throw new PluginError('invalid', 'Settings are a JSON object');
      const value = read.data;
      if (!settingsFit(value))
        throw new PluginError('too-large', `Settings hold at most ${SETTINGS_LIMIT / 1024} KB`);
      const wrong = misfit(plugin.manifest.settings, value);
      if (wrong) throw new PluginError('invalid', `${wrong.label} can’t be that value`);
      await store.setSettings(refOf(plugin), value);
      settings = { ...settings, [id]: value };
      const entry = loaded.get(id);
      if (entry) tell(entry, { event: 'settings.changed', payload: settingsOf(entry.plugin) });
      emit();
    });
    // A listing can't come between a change and its keeping, nor a change between another's.
    syncing = done.catch(() => {});
    return done;
  }

  /** Each activation's views' last props, by view, with the page and version they are for. */
  const viewProps = new WeakMap<Active, Map<string, { key: string; props: PageViewProps }>>();

  const deactivate = (entry: Loaded) => {
    const { active } = entry;
    if (!active) return;
    entry.active = null;
    active.controller.abort();
    try {
      active.app?.deactivate?.();
    } catch {
      // Its own cleanup; what it registered goes regardless.
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
      changed: (spaceId) => {
        if (session.get()) reach.changed(spaceId);
      },
    };
    const unloaded = () => new PluginError('unloaded', 'The plugin was turned off');
    // Its settings, written as its pages are: counted against its writes a minute.
    const ownSettings: PluginSettings = {
      get: async () => {
        if (!live()) throw unloaded();
        return settingsOf(entry.plugin);
      },
      set: async (value) => {
        if (!live()) throw unloaded();
        write();
        await changeSettings(entry.plugin, () => value);
      },
      update: async (patch) => {
        if (!live()) throw unloaded();
        write();
        await changeSettings(entry.plugin, (stored) => {
          const read = SettingsValue.safeParse(patch);
          if (!read.success) throw new PluginError('invalid', 'A patch is a JSON object');
          return { ...stored, ...read.data };
        });
        return settingsOf(entry.plugin);
      },
      on(event, handler) {
        if (!live()) return () => {};
        // A plugin built for a newer app may name an event this one lacks.
        if (event !== 'changed') throw new PluginError('unsupported', `No event ${String(event)}`);
        return active.registry.addHandler('settings.changed', {
          part: 'app',
          run: async ({ payload }) => handler(payload),
        });
      },
    };
    const active: Active = {
      controller: new AbortController(),
      caller,
      pages: reach.pages(caller),
      registry: createRegistry(() => {
        if (live()) emit();
      }),
      settings: ownSettings,
      settingsProps: { settings: ownSettings },
      app: null,
      worker: null,
      running: new Map(),
    };
    const { registry } = active;
    entry.active = active;
    entry.problems = { app: null, script: null };
    const live = () => entry.active === active && run === epoch;
    /** Register, unless this activation is over. */
    const whileLive = (register: () => Disposer): Disposer => (live() ? register() : () => {});
    const claims = (type: string) => manifest.blocks.includes(type);
    const on: AppHost['events']['on'] = (event, handler) => {
      if (!live()) return () => {};
      // A plugin built for a newer app may name an event this one lacks.
      if (!isEvent(event)) throw new PluginError('unsupported', `No event ${String(event)}`);
      return registry.addHandler(event, {
        part: 'app',
        run: async ({ payload }) => handler(payload),
      });
    };
    const host: AppHost = {
      api: PLUGIN_API,
      pluginId: id,
      pages: active.pages,
      settings: ownSettings,
      signal: active.controller.signal,
      commands: {
        register: (command) =>
          whileLive(() =>
            registry.addCommand({
              id: command.id,
              title: command.title,
              part: 'app',
              run: async (page) => command.run({ page }),
            }),
          ),
      },
      events: { on },
      app: {
        location: {
          get: () => reach.location.get(),
          subscribe: (listener) => on('location.changed', listener),
        },
        navigate: async (to) => {
          if (!live()) throw new PluginError('unloaded', 'The plugin was turned off');
          try {
            // Its own pages and settings only: the plugin's ID is the runtime's to give.
            await reach.location.navigate(
              to.kind === 'plugin'
                ? { kind: 'plugin', pluginId: id, viewId: to.viewId }
                : to.kind === 'settings'
                  ? { kind: 'settings', pluginId: id }
                  : to,
            );
          } catch (error) {
            throw pluginError(error);
          }
        },
        spaces: {
          list: async () => {
            if (!live()) throw new PluginError('unloaded', 'The plugin was turned off');
            try {
              return await reach.spaces(caller);
            } catch (error) {
              throw pluginError(error);
            }
          },
        },
        renderMarkdown(element, markdown, { page }) {
          if (!live()) throw new PluginError('unloaded', 'The plugin was turned off');
          const read = MarkdownPage.safeParse(page);
          if (!(element instanceof HTMLElement) || typeof markdown !== 'string' || !read.success)
            throw new PluginError('invalid', 'Invalid arguments or ID');
          const undo = reach.renderMarkdown({
            element,
            markdown,
            page: read.data,
            pages: active.pages,
          });
          // Undone as the plugin unloads too, as what it registered is.
          active.controller.signal.addEventListener('abort', undo, { once: true });
          return () => {
            active.controller.signal.removeEventListener('abort', undo);
            undo();
          };
        },
      },
      blocks: {
        register(block) {
          if (!live()) return () => {};
          if (!claims(block.type)) {
            throw new PluginError('invalid', `Its manifest claims no block ${block.type}`);
          }
          return registry.addBlock({
            type: block.type,
            part: 'app',
            view: block.view,
            results: null,
          });
        },
      },
      inline: {
        register({ type, view }) {
          if (!live()) return () => {};
          if (!manifest.inline?.includes(type)) {
            throw new PluginError('invalid', `Its manifest claims no inline code ${type}`);
          }
          return registry.addInline({ type, view: spanBlockView(view) });
        },
      },
      ui: {
        register(region, contribution) {
          if (!live()) return () => {};
          // A plugin built for a newer app may name a region this one lacks.
          if (!isRegion(region))
            throw new PluginError('unsupported', `No region ${String(region)}`);
          return registry.addContribution(region, contribution);
        },
        replace(region, replacement) {
          if (!live()) return () => {};
          if (!isReplaceable(region))
            throw new PluginError('unsupported', `No replaceable region ${String(region)}`);
          if (!manifest.replaces?.includes(region))
            throw new PluginError('invalid', `Its manifest replaces no ${region}`);
          return registry.addReplacement(region, replacement);
        },
      },
    };
    if (manifest.script) {
      active.worker = new ScriptWorker(code.script(plugin), active.pages, ownSettings, {
        command: (commandId, title, runCommand) =>
          whileLive(() =>
            registry.addCommand({ id: commandId, title, part: 'script', run: runCommand }),
          ),
        block(spec, calculate) {
          if (!live()) return () => {};
          if (!claims(spec.type)) {
            problem(entry, 'script', `Its manifest claims no block ${spec.type}.`);
            return () => {};
          }
          return registry.addBlock({
            type: spec.type,
            part: 'script',
            view: formView(spec, calculate),
            async results(page, source, properties) {
              const fields = readFields(spec, source, properties);
              const values = Object.fromEntries(
                Object.entries(fields).flatMap(([field, { value }]) =>
                  value === null ? [] : [[field, value]],
                ),
              );
              try {
                return { fields, outputs: await calculate(page, values) };
              } catch (error) {
                return { fields, outputs: { error: pluginError(error).message } };
              }
            },
          });
        },
        listen: (event, deliverTo) =>
          whileLive(() => registry.addHandler(event, { part: 'script', run: deliverTo })),
        problem: (message) => {
          if (live()) problem(entry, 'script', message);
        },
      });
      active.worker.start();
    }
    if (manifest.ui) {
      try {
        const module = await code.app(plugin);
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

  /**
   * Match what runs to the store's list: load what's new or changed,
   * unload the rest, and while the session is open start what isn't running.
   */
  async function sync() {
    if (stopped) return;
    const state = await store.list();
    if (stopped) return;
    safeMode = state.safeMode;
    const plugins = state.plugins ?? [];
    order = plugins.map(({ manifest }) => manifest.id);
    const wanted = new Map(
      (safeMode ? [] : plugins.filter((plugin) => plugin.enabled)).map((plugin) => [
        plugin.manifest.id,
        plugin,
      ]),
    );
    for (const entry of [...loaded.values()]) {
      const next = wanted.get(entry.plugin.manifest.id);
      // Another version, or the same files from elsewhere: a folder install
      // replacing a library copy keeps its choices in another place.
      if (!next || next.key !== entry.plugin.key || next.library !== entry.plugin.library)
        unload(entry);
    }
    const open = session.get() !== null;
    if (open) {
      const before = settings;
      access = state.access;
      settings = state.settings;
      // Changed since the last listing, as when a save read the record again.
      for (const entry of loaded.values()) {
        const id = entry.plugin.manifest.id;
        if (JSON.stringify(before[id] ?? {}) !== JSON.stringify(settings[id] ?? {}))
          tell(entry, { event: 'settings.changed', payload: settingsOf(entry.plugin) });
      }
    }
    for (const plugin of wanted.values()) {
      const entry = loaded.get(plugin.manifest.id) ?? {
        plugin,
        links: loadStyles(plugin),
        active: null,
        starting: Promise.resolve(),
        problems: { app: null, script: null },
      };
      // The same files, with the person's choices as they are now.
      entry.plugin = plugin;
      loaded.set(plugin.manifest.id, entry);
      if (open && !entry.active) entry.starting = activate(entry);
    }
    idle = plugins.filter((plugin) => !wanted.has(plugin.manifest.id));
    unavailable = state.unavailable;
    listed = state.plugins !== null;
    emit();
  }

  let watching = () => {};
  let following = () => {};
  let stopped = false;

  /** Tell plugins where the person went, and of each page shown, once. */
  let toldLocation = JSON.stringify(reach.location.get());
  let toldShown = reach.location.shown();
  const located = () => {
    const location: AppLocation = reach.location.get();
    const key = JSON.stringify(location);
    if (key !== toldLocation) {
      toldLocation = key;
      deliver({ event: 'location.changed', payload: location });
    }
    const shown = reach.location.shown();
    if (shown !== toldShown) {
      toldShown = shown;
      if (shown) deliver({ event: 'page.shown', payload: shown });
    }
  };

  // One at a time, in order: each Settings action asks for one.
  let syncing: Promise<void> = Promise.resolve();
  const refresh = () => (syncing = syncing.then(sync, sync));

  return {
    /** Start, once: list, and watch the session. */
    start() {
      let was = session.get();
      watching = session.subscribe(() => {
        const now = session.get();
        if (now === was) return;
        was = now;
        epoch += 1;
        for (const entry of loaded.values()) deactivate(entry);
        emit();
        if (!now) {
          access = {};
          settings = {};
        }
        // Listed again: the browser's plugins come and go with the account.
        void refresh();
      });
      following = reach.location.subscribe(located);
      void refresh();
    },
    /** Unload everything, for good: a workshop's preview, as the workshop ends. */
    stop() {
      stopped = true;
      watching();
      following();
      epoch += 1;
      for (const entry of [...loaded.values()]) unload(entry);
      emit();
    },
    refresh,
    access: (pluginId: string) => access[pluginId] ?? [],
    /** Replace a plugin's page access for the open account, in its store. */
    async setAccess(plugin: PluginRef, scopes: readonly PluginScope[]) {
      if (!session.get()) return;
      await store.setAccess(plugin, scopes);
      access = { ...access, [plugin.id]: scopes };
      emit();
    },
    /** Tell every running plugin but `from` of `event`. */
    deliver: (event: AppEvent, from: string | null = null) => deliver(event, from),
    /** A plugin's settings for the open account, with its declared fields' defaults. */
    settings: (plugin: InstalledPlugin) => settingsOf(plugin),
    /** Set some of a plugin's settings from Settings → Plugins, checked as its own changes are. */
    updateSettings: (plugin: InstalledPlugin, patch: Settings) =>
      changeSettings(plugin, (stored) => ({ ...stored, ...patch })),
    /** What a running plugin's settings sections are given; null once it stopped. */
    settingsViewProps: (pluginId: string): SettingsViewProps | null =>
      loaded.get(pluginId)?.active?.settingsProps ?? null,
    /** Open a plugin's settings, where this runtime's places are: Settings → Plugins in the app. */
    openSettings: (pluginId: string) => reach.location.navigate({ kind: 'settings', pluginId }),
    /** Turn a running plugin off in its store, from where its view failed. */
    async disable(pluginId: string) {
      const entry = loaded.get(pluginId);
      if (!entry) return;
      await store.enable(refOf(entry.plugin), false);
      await refresh();
    },
    /** One of a plugin's views failed where it is drawn: said beside the plugin until it starts again. */
    viewFailed(pluginId: string, error: unknown) {
      const entry = loaded.get(pluginId);
      if (entry?.active) problem(entry, 'app', `A view failed: ${pluginError(error).message}`);
    },
    /**
     * What a script's block shows for `source` on `page`: its fields as its
     * form reads them, bound ones from the page's `properties`, and its
     * outputs or why they failed. Null when no running script fills in
     * blocks of that `language`.
     */
    async blockResults(
      language: string,
      page: PageRef,
      source: string,
      properties: BlockProperties = null,
    ): Promise<BlockResults | null> {
      for (const { plugin, active } of loaded.values()) {
        for (const { type, results } of active?.registry.blocks() ?? []) {
          if (results && blockLanguage(plugin.manifest.id, type) === language)
            return results(page, source, properties);
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
    /** What a running plugin's views reach, for what a region it replaces gives them; null once it stopped. */
    pagesOf(pluginId: string): PluginPages | null {
      const active = loaded.get(pluginId)?.active;
      if (!active) return null;
      return {
        pages: active.pages,
        handle: (shown) => reach.handle(active.caller, shown),
        spaces: () => reach.spaces(active.caller),
        readsAll: (spaceId) =>
          active.caller.access !== 'none' &&
          active.caller
            .scopes()
            .some((scope) => scope.spaceId === spaceId && scope.folderId === null),
      };
    },
    /** Run a plugin's command on the page shown. */
    async runCommand(pluginId: string, commandId: string, shown: ShownPage) {
      const active = loaded.get(pluginId)?.active;
      if (!active) throw new PluginError('unloaded', 'The plugin isn’t running');
      const command = active.registry.command(commandId);
      if (!command) throw new PluginError('unloaded', 'The command is gone');
      try {
        await command.run(reach.handle(active.caller, shown));
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
      const props = { page: reach.handle(active.caller, shown) };
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

/** What a place's views draw from without a runtime around them: no plugins. */
const NONE: PluginsSnapshot = {
  listed: false,
  safeMode: false,
  plugins: [],
  unavailable: {},
  commands: [],
  regions: contributions([]),
  replaced: replacedBy([]),
  themes: [],
  blocks: new Map(),
  inline: new Map(),
};
const noChanges = () => () => {};
const none = () => NONE;

/**
 * The runtime the views inside it draw from: the app's own (`AppPlugins`),
 * or the workshop's in its preview. Without one, as in a test, there are
 * no plugins.
 */
export const PluginsContext = createContext<PluginRuntime | null>(null);

/** The runtime of the place drawn in, for parts drawn only for a plugin's contribution. */
export function usePluginRuntime(): PluginRuntime {
  const runtime = use(PluginsContext);
  if (!runtime) throw new Error('No plugin runtime here');
  return runtime;
}

export const usePlugins = (): PluginsSnapshot => {
  const runtime = use(PluginsContext);
  return useSyncExternalStore(runtime?.subscribe ?? noChanges, runtime?.get ?? none);
};

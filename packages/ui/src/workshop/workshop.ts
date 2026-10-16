import type { PluginCandidate, WorkshopFile, WorkshopVersion } from '@wikistow/contracts';
import type { Manifest } from '@wikistow/plugin-sdk';
import { desktop } from '../desktop';
import { createRuntime, type PluginRuntime } from '../plugins/runtime';
import { SCRIPT_BUDGET_MS } from '../plugins/script-worker';
import { pluginTheme } from '../theme/plugin-theme';
import { SAMPLE_SPACE, sampleStore } from './samples';

/** Errors from the previewed plugin's code kept for the report, newest last. */
const MAX_ERRORS = 20;
/** A sample's text in the report, at most: the conversation goes to the model whole each step. */
const MAX_SAMPLE_TEXT = 8000;

export type WorkshopState = {
  phase: 'starting' | 'ready' | 'failed' | 'ended';
  failure: string | null;
  /** Every build so far, failed ones too, oldest first. */
  versions: readonly WorkshopVersion[];
  building: boolean;
  /** The version the preview runs: one that built. A failed build leaves it as it is. */
  running: WorkshopVersion | null;
  /** The person let this workshop's app code (`ui`) run in the preview, with the app's trust. */
  appCode: boolean;
  /** The running version's theme shown across the app, by ID. */
  theme: string | null;
  /** Uncaught errors from the running version's code, newest last. */
  errors: readonly string[];
};

/** A plugin block's fence in a sample's text: its info string and its text. */
type Fence = { language: string; source: string };

/** The `plugin:<id>/<block>` fences in `markdown`, in order. */
export function pluginFences(markdown: string): Fence[] {
  const fences: Fence[] = [];
  let open: { marker: string; language: string; lines: string[] } | null = null;
  for (const line of markdown.split('\n')) {
    if (open) {
      if (
        line.trim().startsWith(open.marker) &&
        line.trim().replaceAll(open.marker[0] ?? '`', '') === ''
      ) {
        fences.push({ language: open.language, source: open.lines.join('\n') });
        open = null;
      } else open.lines.push(line);
      continue;
    }
    const match = /^ {0,3}(`{3,}|~{3,})\s*(plugin:\S+)\s*$/.exec(line);
    if (match?.[1] && match[2]) open = { marker: match[1], language: match[2], lines: [] };
  }
  return fences;
}

/** `manifest` without its app code, for a preview the person hasn't let run it. */
const withoutUi = ({ ui: _ui, ...rest }: Manifest): Manifest => rest;

/**
 * A plugin workshop in the desktop app (#257): a staged workspace the main
 * process keeps and builds (`DesktopBridge.workshop*`), and a preview of a
 * built version running in a plugin runtime of its own, against sample
 * pages that never reach the server. Its themes can be shown across the
 * app, its regions, blocks and commands only in the preview.
 *
 * What the preview runs is always one version that built, chosen by
 * number: a failed build leaves it running. Stopping or unloading counts
 * a generation, so a build that finishes afterwards adds no version, and
 * a load takes the preview at once, never later. App code runs only once
 * the person allows it.
 */
export class Workshop {
  /** Names this workshop in the app's queries. */
  readonly id = crypto.randomUUID();
  readonly samples = sampleStore();
  readonly preview: PluginRuntime;
  #session: string | null = null;
  #state: WorkshopState = {
    phase: 'starting',
    failure: null,
    versions: [],
    building: false,
    running: null,
    appCode: false,
    theme: null,
    errors: [],
  };
  readonly #listeners = new Set<() => void>();
  /** Counts stops and unloads: a build or load begun before one is dropped. */
  #generation = 0;
  /** Lists nothing for one refresh, so a version loads afresh. */
  #holding = false;
  /** Builds under way, a stopped one included until main answers. */
  #building = 0;
  /** The stylesheet of the theme this workshop shows across the app, while it does. */
  #theming: string | null = null;
  readonly #unwatchTheme: () => void;

  constructor() {
    this.preview = createRuntime({
      list: async () => {
        const safeMode = desktop ? (await desktop.plugins()).safeMode : true;
        const running = this.#state.running?.plugin;
        if (!running || this.#holding) return { safeMode, plugins: [] };
        const manifest = this.#state.appCode ? running.manifest : withoutUi(running.manifest);
        return { safeMode, plugins: [{ ...running, manifest }] };
      },
      access: async () => ({}),
      // The samples are open to the manifest's access; there is none to choose.
      setAccess: async () => {},
      pages: (caller) => this.samples.pages(caller),
      handle: (caller, shown) => this.samples.handle(caller, shown),
      disable: () => this.unload(),
      ownsStorage: false,
    });
    this.preview.start(null);
    // Settings' picker shares the preview: one it shows, or stops, ends this one.
    this.#unwatchTheme = pluginTheme.subscribe(() => {
      if (this.#theming && pluginTheme.get().preview?.href !== this.#theming) {
        this.#theming = null;
        this.#set({ theme: null });
      }
    });
    window.addEventListener('error', this.#caught);
    window.addEventListener('unhandledrejection', this.#rejected);
    void this.#start();
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  state = () => this.#state;

  #set(change: Partial<WorkshopState>) {
    this.#state = { ...this.#state, ...change };
    for (const listener of this.#listeners) listener();
  }

  async #start() {
    try {
      if (!desktop) throw new Error('The plugin workshop is in the desktop app.');
      const session = await desktop.workshopStart();
      if (this.#state.phase === 'ended') return void desktop.workshopEnd(session);
      this.#session = session;
      this.#set({ phase: 'ready' });
    } catch (error) {
      this.#set({ phase: 'failed', failure: error instanceof Error ? error.message : null });
    }
  }

  #bridge() {
    if (!desktop || !this.#session || this.#state.phase !== 'ready') {
      throw new Error('The workshop isn’t open.');
    }
    return { desktop, session: this.#session };
  }

  // Errors thrown by the running version's code, which its files' address names.
  readonly #caught = (event: ErrorEvent) => {
    if (this.#ours(event.filename))
      this.#error(`${event.message} (${event.filename}:${event.lineno})`);
  };

  readonly #rejected = (event: PromiseRejectionEvent) => {
    const { reason } = event;
    if (reason instanceof Error && this.#ours(reason.stack)) this.#error(reason.message);
  };

  #ours(where: string | undefined) {
    const key = this.#state.running?.plugin?.key;
    return key !== undefined && where?.includes(`/${key}/`) === true;
  }

  #error(message: string) {
    this.#set({ errors: [...this.#state.errors, message].slice(-MAX_ERRORS) });
  }

  files = (): Promise<WorkshopFile[]> => {
    const { desktop, session } = this.#bridge();
    return desktop.workshopFiles(session);
  };

  read = (path: string) => {
    const { desktop, session } = this.#bridge();
    return desktop.workshopRead(session, path);
  };

  write = (path: string, text: string) => {
    const { desktop, session } = this.#bridge();
    return desktop.workshopWrite(session, path, text);
  };

  remove = (path: string) => {
    const { desktop, session } = this.#bridge();
    return desktop.workshopDelete(session, path);
  };

  /** Build the workspace into its next version. Null if stopped or unloaded meanwhile. */
  async build(signal?: AbortSignal): Promise<WorkshopVersion | null> {
    const { desktop, session } = this.#bridge();
    const generation = this.#generation;
    this.#building += 1;
    this.#set({ building: true });
    try {
      const built = await desktop.workshopBuild(session);
      if (!built || generation !== this.#generation || signal?.aborted) return null;
      this.#set({ versions: [...this.#state.versions, built] });
      return built;
    } finally {
      this.#building -= 1;
      this.#set({ building: this.#building > 0 });
    }
  }

  /** Run version `version` in the preview, in place of what runs now. */
  async load(version: number, signal?: AbortSignal) {
    const record = this.#state.versions.find((built) => built.version === version);
    if (!record?.plugin)
      throw new Error(`Version ${version} didn’t build, so it can’t be previewed.`);
    if (signal?.aborted || this.#state.phase !== 'ready') return;
    this.#set({ running: record, errors: [] });
    await this.preview.refresh();
    this.#showTheme();
    // What it registers as it starts, for the report that follows. App code
    // that never finishes starting doesn't hold this up past a script's budget.
    await Promise.race([
      this.preview.started(record.plugin.manifest.id),
      new Promise((resolve) => setTimeout(resolve, SCRIPT_BUDGET_MS)),
    ]);
  }

  /**
   * Let this workshop's app code run in the preview, or stop it: it runs
   * inside WikiStow with the app's own trust, as an installed App plugin's.
   */
  async allowAppCode(allow: boolean) {
    this.#set({ appCode: allow });
    this.#holding = true;
    await this.preview.refresh();
    this.#holding = false;
    await this.preview.refresh();
  }

  /** Show one of the running version's themes across the app, or none. */
  showTheme(themeId: string | null) {
    this.#set({ theme: themeId });
    this.#showTheme();
  }

  #showTheme() {
    const plugin = this.#state.running?.plugin;
    const theme = plugin?.manifest.themes.find(({ id }) => id === this.#state.theme);
    if (plugin && theme) {
      const href = `/plugins/${plugin.manifest.id}/${plugin.key}/${theme.stylesheet}`;
      this.#theming = href;
      pluginTheme.preview({ base: theme.base, href }, 'workshop');
      return;
    }
    if (this.#state.theme !== null) this.#set({ theme: null });
    // Only its own: a preview Settings shows now isn't this workshop's to stop.
    const ours = this.#theming !== null && pluginTheme.get().preview?.href === this.#theming;
    this.#theming = null;
    if (ours) pluginTheme.preview(null);
  }

  /**
   * Stop what is under way: a build running now makes no version, and
   * nothing begun before this replaces the preview.
   */
  stop() {
    this.#generation += 1;
    if (desktop && this.#session) void desktop.workshopCancel(this.#session);
  }

  /** Stop, and run nothing in the preview. */
  async unload() {
    this.stop();
    this.#set({ running: null, theme: null, errors: [] });
    this.#showTheme();
    await this.preview.refresh();
  }

  /** End the workshop: the preview stops, and the workspace and its versions are deleted. */
  end() {
    if (this.#state.phase === 'ended') return;
    this.stop();
    this.#set({ phase: 'ended', running: null, theme: null });
    this.#showTheme();
    this.preview.stop();
    this.#unwatchTheme();
    window.removeEventListener('error', this.#caught);
    window.removeEventListener('unhandledrejection', this.#rejected);
    if (desktop && this.#session) void desktop.workshopEnd(this.#session);
  }

  /** Export a version that built into a folder the person picks. The folder, or null. */
  export(version: WorkshopVersion) {
    const { desktop, session } = this.#bridge();
    if (!version.hash) throw new Error(`Version ${version.version} didn’t build.`);
    return desktop.workshopExport(session, version.version, version.hash);
  }

  /** Read a version that built for the usual install, bound to the hash reviewed. */
  install(version: WorkshopVersion): Promise<PluginCandidate> {
    const { desktop, session } = this.#bridge();
    if (!version.hash) throw new Error(`Version ${version.version} didn’t build.`);
    return desktop.workshopInstall(session, version.version, version.hash);
  }

  /** A version that built's files, bound to the hash reviewed, to share to the library. */
  upload(version: WorkshopVersion) {
    const { desktop, session } = this.#bridge();
    if (!version.hash) throw new Error(`Version ${version.version} didn’t build.`);
    return desktop.workshopUpload(session, version.version, version.hash);
  }

  /**
   * The person typed in the preview's editor, drawn for the sample's
   * `outside` count: the sample changes, and the plugin is told, as of a save.
   */
  typed(pageId: string, markdown: string, outside: number) {
    const revision = this.samples.typed(pageId, markdown, outside);
    if (revision === null) return;
    this.preview.deliver({
      event: 'draft.saved',
      payload: { page: { spaceId: SAMPLE_SPACE, pageId }, revision },
    });
  }

  /** Run one of the running version's commands on a sample page, in the preview's editor. */
  async runCommand(commandId: string, pageId: string) {
    const sample = this.samples.get().find((page) => page.pageId === pageId);
    const id = this.#state.running?.plugin?.manifest.id;
    if (!sample || !id)
      throw new Error(
        sample ? 'Nothing is running in the preview.' : `There’s no sample page ${pageId}.`,
      );
    await this.preview.runCommand(id, commandId, {
      page: { spaceId: SAMPLE_SPACE, pageId },
      version: 'draft',
      revision: String(sample.outside),
      draft: null,
    });
  }

  /**
   * What the preview shows, as data: the version running and the last
   * build, what the plugin registered, its problems and errors, and each
   * sample page with its blocks' fields and calculated outputs.
   */
  async report() {
    const { versions, running, appCode, theme, errors } = this.#state;
    const snapshot = this.preview.get();
    const manifest = running?.plugin?.manifest;
    const status = snapshot.plugins.find((entry) => entry.plugin.manifest.id === manifest?.id);
    const latest = versions.at(-1);
    const samples = [];
    for (const sample of this.samples.flushed()) {
      const page = { spaceId: SAMPLE_SPACE, pageId: sample.pageId };
      const blocks = [];
      for (const { language, source } of pluginFences(sample.markdown)) {
        const results = await this.preview.blockResults(language, page, source);
        blocks.push(
          results
            ? { block: language, fields: results.fields, outputs: results.outputs }
            : {
                block: language,
                drawn: snapshot.blocks.has(language)
                  ? 'by its view'
                  : 'not by any running plugin: shown as text',
              },
        );
      }
      samples.push({
        pageId: sample.pageId,
        title: sample.title,
        ...(sample.copyOf ? { copyOf: sample.copyOf } : {}),
        markdown:
          sample.markdown.length > MAX_SAMPLE_TEXT
            ? `${sample.markdown.slice(0, MAX_SAMPLE_TEXT)}\n[… cut: ${sample.markdown.length} characters in all]`
            : sample.markdown,
        blocks,
      });
    }
    return {
      running: running?.plugin
        ? {
            version: running.version,
            name: running.plugin.manifest.name,
            level: running.plugin.level,
            appCode: manifest?.ui
              ? appCode
                ? 'running'
                : 'not running: waiting for the person to allow it'
              : 'none',
            warnings: running.diagnostics,
          }
        : null,
      latestBuild:
        latest && latest !== running
          ? {
              version: latest.version,
              built: latest.plugin !== null,
              diagnostics: latest.diagnostics,
            }
          : null,
      problem: status?.problem ?? null,
      errors,
      registered: {
        commands: snapshot.commands.map(({ id, title }) => ({ id, title })),
        blocks: [...snapshot.blocks.keys()],
        regions: Object.fromEntries(
          Object.entries(snapshot.regions).flatMap(([region, list]) =>
            list.length > 0 ? [[region, list.map(({ id }) => id)]] : [],
          ),
        ),
        themes: manifest?.themes.map(({ id, name, base }) => ({ id, name, base })) ?? [],
      },
      themeShown: theme,
      samples,
    };
  }
}

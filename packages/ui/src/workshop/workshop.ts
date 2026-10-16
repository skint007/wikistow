import { toBase64 } from '@wikistow/client';
import {
  pluginDraftRoutes,
  type BuildDiagnostic,
  type PluginUploadFile,
  type WorkshopFile,
  type WorkshopVersion,
} from '@wikistow/contracts';
import { trustLevel, type Manifest } from '@wikistow/plugin-sdk/manifest';
import { api } from '../api';
import { errorMessage } from '../errors';
import { desktop } from '../desktop';
import { createRuntime, type PluginRuntime } from '../plugins/runtime';
import { tabSafeMode } from '../plugins/safe-mode';
import { SCRIPT_BUDGET_MS } from '../plugins/script-worker';
import { pluginTheme } from '../theme/plugin-theme';
import { buildDraft, Bundler, type Built } from './builder';
import { SAMPLE_SPACE, sampleStore } from './samples';

const { draftKey, draftPathProblem, MAX_DRAFT_BYTES, MAX_DRAFT_FILE_BYTES, MAX_DRAFT_FILES } =
  pluginDraftRoutes;

/** Errors from the previewed plugin's code kept for the report, newest last. */
const MAX_ERRORS = 20;
/** A sample's text in the report, at most: the conversation goes to the model whole each step. */
const MAX_SAMPLE_TEXT = 8000;

export type WorkshopState = {
  phase: 'starting' | 'ready' | 'failed' | 'ended';
  failure: string | null;
  /** The draft as the server last answered, once it is read. */
  draft: pluginDraftRoutes.DraftSummary | null;
  /** The draft's files as saved, by path. */
  files: ReadonlyMap<string, string>;
  /** What last went wrong outside the plugin's own code, such as previewing on opening. */
  problem: string | null;
  /** Reading the draft, then building and previewing it, as it opens. */
  opening: boolean;
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

/** Failed, with what was said, as a version. */
const failedVersion = (version: number, diagnostics: BuildDiagnostic[]): WorkshopVersion => ({
  version,
  diagnostics,
  plugin: null,
  hash: null,
});

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.';

const encoder = new TextEncoder();
const byteSize = (text: string) => encoder.encode(text).length;

/**
 * A plugin workshop on a plugin draft (#257, ADR 0004): the draft's files,
 * read from the server when it opens and held here, each change saved
 * before it counts; builds made in the page's build worker and kept for
 * the conversation; and a preview of a built version running in a plugin
 * runtime of its own, against sample pages that never reach the server.
 * Its themes can be shown across the app, its regions, blocks and commands
 * only in the preview. The browser previews a build from the draft's
 * build on the server, the desktop from what main is handed, both under
 * `draft-<hash>`.
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
  /** The plugin draft it works on. */
  readonly draftId: string;
  readonly samples = sampleStore();
  readonly preview: PluginRuntime;
  readonly #bundler = new Bundler();
  #state: WorkshopState = {
    phase: 'starting',
    failure: null,
    draft: null,
    files: new Map(),
    problem: null,
    opening: true,
    versions: [],
    building: false,
    running: null,
    appCode: false,
    theme: null,
    errors: [],
  };
  readonly #listeners = new Set<() => void>();
  /** Each version that built, by number, with its files. */
  readonly #built = new Map<number, Built>();
  /** Builds whose files the preview can load now, by hash. */
  readonly #served = new Set<string>();
  /** The last large upload: the account sends one at a time. */
  #uploading: Promise<unknown> = Promise.resolve();
  /** Counts stops and unloads: a build or load begun before one is dropped. */
  #generation = 0;
  /** Lists nothing for one refresh, so a version loads afresh. */
  #holding = false;
  /** Builds under way, a stopped one included until it answers. */
  #building = 0;
  /** The stylesheet of the theme this workshop shows across the app, while it does. */
  #theming: string | null = null;
  readonly #unwatchTheme: () => void;

  constructor(draftId: string) {
    this.draftId = draftId;
    this.preview = createRuntime({
      list: async () => {
        const safeMode = desktop ? (await desktop.plugins()).safeMode : tabSafeMode.on();
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

  /** Read the draft whole, then build it and preview what built, without the assistant. */
  async #start() {
    try {
      const { draft, files } = await api.call(pluginDraftRoutes.getDraft, {
        params: { draftId: this.draftId },
      });
      if (this.#state.phase === 'ended') return;
      this.#set({
        phase: 'ready',
        draft,
        files: new Map(files.map(({ path, text }) => [path, text])),
      });
    } catch (error) {
      if (this.#state.phase !== 'ended') {
        this.#set({ phase: 'failed', failure: errorMessage(error), opening: false });
      }
      return;
    }
    try {
      if (this.#state.files.size === 0) return;
      const version = await this.build();
      if (version?.plugin) await this.load(version.version);
    } catch (error) {
      this.#set({ problem: message(error) });
    } finally {
      this.#set({ opening: false });
    }
  }

  #open() {
    if (this.#state.phase !== 'ready') throw new Error('The workshop isn’t open.');
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

  /** The draft's files, with their sizes in bytes, by path. */
  files = (): WorkshopFile[] => {
    this.#open();
    return [...this.#state.files]
      .map(([path, text]) => ({ path, size: byteSize(text) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  };

  read = (path: string) => {
    this.#open();
    const text = this.#state.files.get(path);
    if (text === undefined) throw new Error(`There’s no ${path} in the draft.`);
    return text;
  };

  /**
   * Save a file to the draft on the server; the copy here changes only once
   * the server has it. The draft's limits are checked here first, to say
   * which one a file breaks; the server checks them again.
   */
  async write(path: string, text: string) {
    this.#open();
    const problem = draftPathProblem(path);
    if (problem) throw new Error(problem);
    if (text.includes('\0')) throw new Error('A draft file can’t hold a NUL character.');
    const size = byteSize(text);
    if (size > MAX_DRAFT_FILE_BYTES) throw new Error('A draft file holds 256 KB at most.');
    const others = [...this.#state.files].filter(([other]) => other !== path);
    if (others.length + 1 > MAX_DRAFT_FILES) {
      throw new Error(`A draft holds ${MAX_DRAFT_FILES} files at most.`);
    }
    if (others.reduce((total, [, other]) => total + byteSize(other), size) > MAX_DRAFT_BYTES) {
      throw new Error('A draft holds 4 MB at most.');
    }
    await this.#change({ put: [{ path, text }] }, (files) => files.set(path, text));
  }

  async remove(path: string) {
    this.#open();
    const problem = draftPathProblem(path);
    if (problem) throw new Error(problem);
    await this.#change({ remove: [path] }, (files) => files.delete(path));
  }

  async #change(
    body: { put?: pluginDraftRoutes.DraftFile[]; remove?: string[] },
    apply: (files: Map<string, string>) => void,
  ) {
    const { draft } = await api.call(pluginDraftRoutes.changeDraft, {
      params: { draftId: this.draftId },
      body,
    });
    if (this.#state.phase === 'ended') return;
    // From the files as they are now: another change may have landed meanwhile.
    const files = new Map(this.#state.files);
    apply(files);
    this.#set({ draft, files });
  }

  /** Build the draft's files into the next version. Null if stopped or unloaded meanwhile. */
  async build(signal?: AbortSignal): Promise<WorkshopVersion | null> {
    this.#open();
    const generation = this.#generation;
    this.#building += 1;
    this.#set({ building: true });
    try {
      const result = await buildDraft(this.#state.files, this.#bundler).catch(
        (problem: unknown): Awaited<ReturnType<typeof buildDraft>> => ({
          diagnostics: [
            { severity: 'error', file: null, line: null, column: null, message: message(problem) },
          ],
          built: null,
        }),
      );
      if (generation !== this.#generation || signal?.aborted || this.#state.phase !== 'ready') {
        return null;
      }
      const number = this.#state.versions.length + 1;
      const { built } = result;
      const version: WorkshopVersion = built
        ? {
            version: number,
            diagnostics: result.diagnostics,
            plugin: {
              manifest: built.manifest,
              level: trustLevel(built.manifest),
              key: draftKey(built.hash),
              development: null,
              library: false,
              enabled: true,
            },
            hash: built.hash,
          }
        : failedVersion(number, result.diagnostics);
      if (built) this.#built.set(number, built);
      this.#set({ versions: [...this.#state.versions, version] });
      return version;
    } finally {
      this.#building -= 1;
      this.#set({ building: this.#building > 0 });
    }
  }

  /**
   * A version that built, as its folder's files and its hash: what the
   * preview and an export use, and what Publish uploads.
   */
  versionFiles(version: number): { files: PluginUploadFile[]; hash: string } {
    const built = this.#built.get(version);
    if (!built) throw new Error(`Version ${version} didn’t build.`);
    return {
      files: [...built.bytes].map(([path, data]) => ({ path, data })),
      hash: built.hash,
    };
  }

  /**
   * Send one large upload (a preview's build, a version to publish) after
   * any this workshop is sending: the server takes one at a time from an account.
   */
  oneLargeUpload<T>(send: () => Promise<T>): Promise<T> {
    const sent = this.#uploading.then(send);
    this.#uploading = sent.catch(() => {});
    return sent;
  }

  /**
   * Make version `version`'s files loadable under `draft-<hash>`: on the
   * desktop main serves what it is handed; in the browser the draft's build
   * on the server is replaced, and served from the library's file route.
   * Either way the answer must be the hash built here.
   */
  async #serve(version: number) {
    const { files, hash } = this.versionFiles(version);
    if (this.#served.has(hash)) return;
    const served = desktop
      ? await desktop.workshopPreview(files)
      : (
          await this.oneLargeUpload(() =>
            api.call(pluginDraftRoutes.putDraftBuild, {
              params: { draftId: this.draftId },
              body: { files: files.map(({ path, data }) => ({ path, data: toBase64(data) })) },
            }),
          )
        ).hash;
    if (served !== hash) throw new Error('The preview’s copy doesn’t match the version built.');
    // The server keeps one build a draft; main keeps every one it was handed.
    if (!desktop) this.#served.clear();
    this.#served.add(hash);
  }

  /** Run version `version` in the preview, in place of what runs now. */
  async load(version: number, signal?: AbortSignal) {
    const record = this.#state.versions.find((built) => built.version === version);
    if (!record?.plugin)
      throw new Error(`Version ${version} didn’t build, so it can’t be previewed.`);
    if (signal?.aborted || this.#state.phase !== 'ready') return;
    const generation = this.#generation;
    await this.#serve(version);
    if (generation !== this.#generation || signal?.aborted || this.#state.phase !== 'ready') {
      return;
    }
    this.#set({ running: record, errors: [], problem: null });
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
  }

  /** Stop, and run nothing in the preview. */
  async unload() {
    this.stop();
    this.#set({ running: null, theme: null, errors: [] });
    this.#showTheme();
    await this.preview.refresh();
  }

  /**
   * End the workshop: the preview stops, and the versions built go with the
   * conversation. The draft stays on the server.
   */
  end() {
    if (this.#state.phase === 'ended') return;
    this.stop();
    this.#set({ phase: 'ended', running: null, theme: null });
    this.#showTheme();
    this.preview.stop();
    this.#bundler.stop();
    this.#unwatchTheme();
    window.removeEventListener('error', this.#caught);
    window.removeEventListener('unhandledrejection', this.#rejected);
  }

  /** On the desktop, export a version that built into a folder the person picks. The folder, or null. */
  export(version: number) {
    if (!desktop) throw new Error('Exporting to a folder is in the desktop app.');
    const { files, hash } = this.versionFiles(version);
    return desktop.workshopExport(files, hash);
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

/*
 * What WikiStow gives a plugin: plain data and typed operations, never the
 * app's own client objects or keys. The same interface reaches app plugins
 * directly and scripts through their worker's messages.
 */

/** The host interface's major version this SDK builds against. */
export const PLUGIN_API = 1;

/** JSON, as a plugin's page data holds it. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type PageRef = { spaceId: string; pageId: string };

/** A folder, or the top of a space for `folderId: null`. */
export type FolderRef = { spaceId: string; folderId: string | null };

/** A page or folder, for moving. */
export type NodeRef = { spaceId: string; id: string };

/** One version of a page, as the person can read it. */
export type PageVersion = PageRef & {
  folderId: string | null;
  title: string;
  /** The whole Markdown, frontmatter included. */
  markdown: string;
  /** Its revision, the `base` for saving a draft on top of it. */
  revision: string;
  /** Editors read drafts; readers only ever get published versions. */
  version: 'draft' | 'published';
  /** The page's `plugin.<id>` data, or null. */
  data: Json | null;
};

/** What a folder holds, by the names the person can open (null where they can't). */
export type FolderEntry =
  | { kind: 'folder'; spaceId: string; folderId: string; name: string | null }
  | { kind: 'page'; spaceId: string; pageId: string; title: string | null };

export type SearchResult = PageRef & { title: string; draft: boolean };

/** A change to a page: what isn't named stays as it is. */
export type PageChange = {
  title?: string | undefined;
  markdown?: string | undefined;
  data?: Json | null | undefined;
};

/** The page operations, each checked against the plugin's page access. */
export interface Pages {
  /** The draft where the person edits the page, else its published version. */
  read(page: PageRef): Promise<PageVersion>;
  list(folder: FolderRef): Promise<FolderEntry[]>;
  /**
   * Pages within the plugin's access whose text matches, best first. Words
   * may come with filters on properties, as in the app's search: `tag:soup`,
   * `status:"in progress"`.
   */
  search(text: string, options?: { limit?: number | undefined }): Promise<SearchResult[]>;
  create(
    folder: FolderRef,
    page: { title: string; markdown?: string | undefined; data?: Json | undefined },
  ): Promise<PageVersion>;
  createFolder(parent: FolderRef, name: string): Promise<FolderRef>;
  /**
   * Save a new draft on top of `base`, the revision read. Fails with
   * `conflict` if someone saved since; nothing is merged or retried.
   */
  saveDraft(page: PageRef, change: PageChange & { base: string }): Promise<PageVersion>;
  /** Move a page or folder where nobody's access changes. */
  move(node: NodeRef, parent: FolderRef): Promise<void>;
}

/**
 * The page a command was run on or a panel shows, which needs no page
 * access: the person chose it.
 */
export interface PageHandle {
  readonly page: PageRef;
  /**
   * The version the person is looking at. In the draft view what is typed
   * is saved first, a save this plugin isn't told of.
   */
  read(): Promise<PageVersion>;
  /**
   * In the draft view, change the draft as the person's own edit: what is
   * typed is saved first, and the editor opens the result. Null elsewhere.
   */
  readonly edit: ((change: PageChange) => Promise<PageVersion>) | null;
}

export type Command = {
  /** Unique within the plugin. */
  id: string;
  title: string;
  /** Runs from the page toolbar's plugin menu, on the page shown. */
  run(context: { page: PageHandle }): void | Promise<void>;
};

export type PluginEvents = {
  /** The person opened a page, or the version shown changed. */
  'page.shown': { page: PageRef; revision: string; version: 'draft' | 'published' };
  /** This app saved a draft, by the editor or another plugin, never this one. */
  'draft.saved': { page: PageRef; revision: string };
};

/** One event, with its payload. */
export type PluginEvent = {
  [E in keyof PluginEvents]: { event: E; payload: PluginEvents[E] };
}[keyof PluginEvents];

export type Disposer = () => void;

/** What every plugin gets. */
export interface Host {
  /** The host interface version. */
  readonly api: number;
  readonly pluginId: string;
  readonly pages: Pages;
  readonly commands: { register(command: Command): Disposer };
  readonly events: {
    on<E extends keyof PluginEvents>(
      event: E,
      handler: (event: PluginEvents[E]) => void | Promise<void>,
    ): Disposer;
  };
  /** Aborted when the plugin unloads, the vault locks or the person signs out. */
  readonly signal: AbortSignal;
}

/**
 * A view: draw into `element`, which the host owns, and return what undoes
 * it. `reactView` makes one from a React component.
 */
export type View<Props> = (element: HTMLElement, props: Props) => (() => void) | void;

/** What a view in one of a page's places is given: the page shown. */
export type PageViewProps = { page: PageHandle };
export type PanelProps = PageViewProps;

/** What a plugin page (`app.view`) is given. */
export type AppViewProps = {
  /** Leave the plugin page for a page in the app. */
  openPage: (page: PageRef) => void;
};

/** What a settings section is given: nothing yet. */
export type SettingsViewProps = Record<string, never>;

/** What a titlebar button is given: nothing yet. */
export type TitlebarViewProps = Record<string, never>;

/** The info string of a fenced block a plugin claims: `plugin:<id>/<block>`. */
export const blockLanguage = (pluginId: string, type: string) => `plugin:${pluginId}/${type}`;

/** The plugin and block type a fence's info string claims, or null for any other fence. */
export function claimedBlock(language: string): { pluginId: string; type: string } | null {
  const match = /^plugin:([a-z][a-z0-9-]{1,39})\/([a-z][a-z0-9-]{0,39})$/.exec(language);
  return match?.[1] && match[2] ? { pluginId: match[1], type: match[2] } : null;
}

/** What a block's view is given. */
export type BlockProps = {
  /** The fence's text, as the page holds it: the block's settings and saved values. */
  source: string;
  /** The page it is in. */
  page: PageRef;
  /**
   * In the visual editor, replace the block's text as the person's own
   * edit, which the draft saves; the view isn't drawn again for it. Null in
   * the reader, where values the person enters stay in the view.
   */
  setSource: ((source: string) => void) | null;
};

/**
 * A block a plugin draws in place of a fence it claims (`blocks` in its
 * manifest), in the reader and the visual editor. Without the plugin the
 * fence is ordinary code.
 */
export type Block = { type: string; view: View<BlockProps> };

/*
 * Blocks a script fills in (#260): the script declares fields and outputs,
 * the host draws them as a form, and each output's `calculate` runs in the
 * script's worker. The fence's text holds a `<field>: <value>` line per
 * field; outputs are never stored.
 */

/** A number, entered as text: a value outside `min`–`max`, or not a number, is shown as invalid. */
export type NumberField = {
  type: 'number';
  label: string;
  /** Used while the fence has no line for the field. Without one, it must be entered. */
  default?: number | undefined;
  min?: number | undefined;
  max?: number | undefined;
};

/** One line of text. */
export type TextField = { type: 'text'; label: string; default?: string | undefined };

export type BlockField = NumberField | TextField;

/** What an output shows. Numbers must be finite. */
export type OutputValue = number | string;

/** The fields' values, typed by their declarations. */
export type FieldValues<Fields extends Record<string, BlockField>> = {
  readonly [Id in keyof Fields]: Fields[Id] extends NumberField
    ? number
    : Fields[Id] extends TextField
      ? string
      : OutputValue;
};

/**
 * What an output's `calculate` reads: every field, and the other outputs by
 * their IDs. Reading a field that is missing or invalid, or an output that
 * failed, fails this output too; outputs that read each other in a loop
 * show that they do.
 */
export type CalculateValues<Fields extends Record<string, BlockField>> = FieldValues<Fields> &
  Readonly<Record<string, OutputValue>>;

export type BlockOutput<Fields extends Record<string, BlockField>> = {
  label: string;
  /** Given the same values, give the same answer: it runs again whenever they change. One second at most. */
  calculate(
    values: CalculateValues<Fields>,
    context: { page: PageRef },
  ): OutputValue | Promise<OutputValue>;
};

/**
 * A block a script declares (`blocks` in its manifest claims its type).
 * Field and output IDs are `[A-Za-z][A-Za-z0-9_]*`, shared between the
 * two, and name the fence's lines: keep them once pages use them.
 */
export type ScriptBlock<Fields extends Record<string, BlockField>> = {
  type: string;
  fields: Fields;
  outputs: Record<string, BlockOutput<Fields>>;
};

/** What a script gets: `Host`, and blocks it fills in. */
export interface ScriptHost extends Host {
  readonly blocks: {
    register<const Fields extends Record<string, BlockField>>(block: ScriptBlock<Fields>): Disposer;
  };
}

/**
 * Where an app plugin's interface can go, each with what it registers there
 * (`id` is unique within the plugin and region). Several plugins in one
 * place show in the order Settings lists them, then in the order each
 * registered; nothing replaces the app's own content, which a plugin's CSS
 * may hide through its `data-region`. Each place is shown at every window
 * size; the README says where each goes on a phone.
 */
export type Regions = {
  /** A sheet beside the page, opened from its toolbar's Plugins menu, like History. */
  'page.panel': { id: string; title: string; view: View<PageViewProps> };
  /** In the page's toolbar, before the Plugins menu: keep it to a button or two. */
  'page.toolbar': { id: string; view: View<PageViewProps> };
  /** Above the page's text, under its banner. */
  'page.header': { id: string; view: View<PageViewProps> };
  /** Below the page's text. */
  'page.footer': { id: string; view: View<PageViewProps> };
  /** Beside the page's text, under its contents, where the page is wide enough; below it elsewhere. */
  'page.aside': { id: string; view: View<PageViewProps> };
  /** A page of the plugin's own in the app's main area. */
  'app.view': { id: string; title: string; view: View<AppViewProps> };
  /**
   * A navigation item in the rail, opening the plugin's `app.view` whose
   * `id` is `opens`. `icon` is one or two characters, such as an emoji;
   * without it, the title's first letter.
   */
  rail: { id: string; title: string; icon?: string | undefined; opens: string };
  /** A section of Settings, under Plugins. */
  'settings.section': { id: string; title: string; view: View<SettingsViewProps> };
  /**
   * In the desktop app's titlebar, before its menu: a small button or two,
   * which the view names for screen readers. Not in the browser, which has
   * no titlebar of its own.
   */
  'app.titlebar': { id: string; view: View<TitlebarViewProps> };
};

const REGIONS: Record<keyof Regions, true> = {
  'page.panel': true,
  'page.toolbar': true,
  'page.header': true,
  'page.footer': true,
  'page.aside': true,
  'app.view': true,
  rail: true,
  'settings.section': true,
  'app.titlebar': true,
};

/** Whether `name` is a region, for checking what a plugin asks for. */
export const isRegion = (name: string): name is keyof Regions => Object.hasOwn(REGIONS, name);

/** What an app plugin gets beyond `Host`. */
export interface AppHost extends Host {
  readonly ui: {
    register<R extends keyof Regions>(region: R, contribution: Regions[R]): Disposer;
  };
  /** Draw a block type the manifest claims; `invalid` for one it doesn't. */
  readonly blocks: { register(block: Block): Disposer };
}

export type PluginErrorCode =
  /** Outside the plugin's page access, or more than it was given. */
  | 'not-granted'
  /** The person can't do it there, or it would change who can read. */
  | 'forbidden'
  | 'not-found'
  /** Someone saved since the base revision. */
  | 'conflict'
  | 'too-large'
  /** The vault is locked. */
  | 'locked'
  | 'rate-limited'
  | 'timeout'
  /** The plugin was disabled, updated or removed meanwhile. */
  | 'unloaded'
  | 'unsupported'
  | 'invalid'
  | 'failed';

/**
 * A refusal or failure from the host. Each plugin bundles its own copy of
 * the SDK, so `instanceof` goes by its name and code rather than by class:
 * an error from the app's copy is one too.
 */
export class PluginError extends Error {
  readonly code: PluginErrorCode;

  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      value instanceof Error &&
      value.name === 'PluginError' &&
      'code' in value &&
      typeof value.code === 'string'
    );
  }

  constructor(code: PluginErrorCode, message: string) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
  }
}

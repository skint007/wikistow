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

/**
 * A folder or page in a space's tree, with the folder it is in: null at
 * the top of the space, or a folder outside the plugin's access, which
 * isn't listed.
 */
export type TreeEntry = FolderEntry & { parentId: string | null };

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
   * Every folder and page of a space the plugin can read, in one call, as
   * the app's own tree shows them: with what was made on this device and
   * not sent yet, and offline, what this device keeps. Folders come
   * first, each list in no set order. Empty where it can read nothing
   * there. Missing (undefined) in an app older than it; in a script it is
   * always there, and such an app stops the script that calls it.
   */
  tree?(spaceId: string): Promise<TreeEntry[]>;
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
  /**
   * In the draft view, the editor at the person's cursor. Null elsewhere,
   * and null or missing (undefined) in an app older than it.
   */
  readonly editor?: EditorCursor | null | undefined;
}

/**
 * Where the person is in the draft view's editor: in split, the side they
 * were in last. Text in and out has LF line breaks; what goes in takes the
 * page's own.
 */
export interface EditorCursor {
  /** What is selected, as Markdown, or `''` at a cursor. */
  selection(): Promise<string>;
  /**
   * Put `markdown` in place of the selection, or at the cursor, as the
   * person's own edit: it can be undone, and saves as typing does. The
   * source editor inserts the text; the visual editor reads it into the
   * page, as a paste does, except that anything but a single paragraph
   * goes in as whole blocks, splitting the text at the cursor, so a block
   * put after some text stays a block. It counts as a write, as `edit` does.
   */
  insert(markdown: string): Promise<void>;
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

/**
 * Where the person is in the app. A page's `version` is the one shown,
 * missing while the page opens or where it can't. `other` is anywhere
 * else, with the space where that is one of a space's own pages (its
 * members or groups).
 */
export type AppLocation =
  | { kind: 'space'; spaceId: string }
  | { kind: 'folder'; spaceId: string; folderId: string }
  | {
      kind: 'page';
      spaceId: string;
      pageId: string;
      version?: PageVersion['version'] | undefined;
    }
  | { kind: 'plugin'; pluginId: string; viewId: string }
  | { kind: 'other'; spaceId?: string | undefined };

/**
 * Where `host.app.navigate` goes: a space, a folder, a page (its draft or
 * publication, else the one the app opens), or one of the plugin's own
 * `app.view`s.
 */
export type Destination =
  | { kind: 'space'; spaceId: string }
  | { kind: 'folder'; spaceId: string; folderId: string }
  | { kind: 'page'; spaceId: string; pageId: string; version?: PageVersion['version'] | undefined }
  | { kind: 'plugin'; viewId: string };

/** A space the plugin has page access in. */
export type SpaceSummary = {
  spaceId: string;
  /** Null where it can't be read. */
  name: string | null;
  /** Its emoji, or null for one without. The app may show an image or a symbol instead. */
  icon: string | null;
};

/** What app code gets as `host.app`: where the person is, and the way elsewhere. */
export interface AppAccess {
  readonly location: {
    get(): AppLocation;
    /** Called as the location changes, as `location.changed` handlers are. */
    subscribe(listener: (location: AppLocation) => void | Promise<void>): Disposer;
  };
  /** Go there, as a link would. Fails with `invalid` for a malformed ID. */
  navigate(to: Destination): Promise<void>;
  readonly spaces: {
    /** The spaces the plugin has any page access in, as the app lists them. */
    list(): Promise<SpaceSummary[]>;
  };
  /**
   * Draw `markdown` into `element` as the app's reader draws a page's
   * text: wikilinks, blocks, math, diagrams and the rest, with `page`'s
   * files and links. A `PageVersion` names the version whose files it
   * shows; a bare `PageRef`, the version shown of that page, else its
   * latest publication, else its draft. Frontmatter shows as the page's
   * properties. Where the plugin can't read `page`, a note says so
   * instead. Returns what undoes it.
   */
  renderMarkdown(
    element: HTMLElement,
    markdown: string,
    options: { page: PageRef | PageVersion },
  ): Disposer;
}

/** App code's events: every plugin's, and where the person is. */
export type AppEvents = PluginEvents & {
  /** The person went elsewhere in the app, or the version shown of a page changed. */
  'location.changed': AppLocation;
};

/** One of app code's events, with its payload. */
export type AppEvent = {
  [E in keyof AppEvents]: { event: E; payload: AppEvents[E] };
}[keyof AppEvents];

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

/** What a view drawing a space's home (`space.home`) is given: the space. */
export type SpaceHomeProps = { spaceId: string };

/**
 * What a view drawing a folder's page (`folder.view`) is given: the folder,
 * and what is directly in it, as `host.pages.list` gives it. It is drawn
 * again when they change.
 */
export type FolderViewProps = {
  folder: { spaceId: string; folderId: string };
  entries: FolderEntry[];
};

/** The info string of a fenced block a plugin claims: `plugin:<id>/<block>`. */
export const blockLanguage = (pluginId: string, type: string) => `plugin:${pluginId}/${type}`;

/** The plugin and block type a fence's info string claims, or null for any other fence. */
export function claimedBlock(language: string): { pluginId: string; type: string } | null {
  const match = /^plugin:([a-z][a-z0-9-]{1,39})\/([a-z][a-z0-9-]{0,39})$/.exec(language);
  return match?.[1] && match[2] ? { pluginId: match[1], type: match[2] } : null;
}

/** A scalar in a page's properties: text, a number, `true` or `false`, or `null` for an empty value. */
export type PropertyScalar = string | number | boolean | null;

/** A property's value: a scalar, or a list of scalars and lists of scalars. */
export type PropertyValue =
  | PropertyScalar
  | readonly (PropertyScalar | readonly PropertyScalar[])[];

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
  /**
   * The page's properties, as the page shows them now: each top-level key
   * of its frontmatter, as written, with its value. A value that is
   * neither a scalar nor a list of them, such as a nested map, is its
   * source text. Empty for a page without frontmatter, and null for one
   * whose frontmatter doesn't read as properties. The view is drawn again
   * when they change, except for a change it made itself (`setProperty`).
   * Missing (undefined) in an app older than it: treat that as unknown.
   */
  properties?: Readonly<Record<string, PropertyValue>> | null | undefined;
  /**
   * Set one of the page's properties, changing only that value's
   * characters in its frontmatter: the key as written, else the first key
   * whose name matches it as `` `=key` `` does (case, `_`, `-` and spaces
   * alike), else a new key at the block's end. `key` follows the
   * template-variable rule (a letter or digit, then letters, digits,
   * spaces, `_` and `-`). Each `=key` on the page, and on others as
   * `` `=[[Page]].key` ``, follows it.
   *
   * In the visual editor it is the person's own edit to the draft. In the
   * reader it is for an editor who can publish the page, on its latest
   * publication, while the draft has no changes: shown at once, and
   * published with the page's other changes once they pause (as a task
   * ticked there is), or left out with a note if it no longer applies by
   * then. Null anywhere else. Throws `PluginError` with `invalid` for a key
   * or value that can't be set, or, in the editor, a value that can't be
   * changed in place, such as one on several lines. Call it as a value is
   * committed, on blur or Enter, not on each key. Missing (undefined) in
   * an app older than it, which can't set properties.
   */
  setProperty?: ((key: string, value: PropertyValue) => void) | null | undefined;
};

/**
 * A block a plugin draws in place of a fence it claims (`blocks` in its
 * manifest), in the reader and the visual editor. Without the plugin the
 * fence is ordinary code.
 */
export type Block = { type: string; view: View<BlockProps> };

/** What a claimed span's view is given. */
export type InlineProps = {
  /** The span's text after `plugin:<id>/<type> `, as the reader reads it: a line break is a space. */
  text: string;
  /** The page it is in. */
  page: PageRef;
  /**
   * In the visual editor, make `text` the span's text as the person's own
   * edit, which the draft saves; the view isn't drawn again for it. Null in
   * the reader.
   */
  setText: ((text: string) => void) | null;
};

/**
 * Inline code a plugin draws in place of a span it claims (`inline` in its
 * manifest), written `` `plugin:<id>/<type> <text>` ``, in the reader and
 * the visual editor. The page's text never changes for it, and without the
 * plugin the span is ordinary inline code.
 */
export type Inline = { type: string; view: View<InlineProps> };

const CLAIMED_INLINE = /^plugin:([a-z][a-z0-9-]{1,39})\/([a-z][a-z0-9-]{0,39})(?: (.*))?$/s;

/**
 * The plugin, type and text an inline code span claims, from its code (as
 * Markdown reads it, between the backticks), or null for any other code.
 */
export function claimedInline(
  code: string,
): { pluginId: string; type: string; text: string } | null {
  const match = CLAIMED_INLINE.exec(code);
  return match?.[1] && match[2]
    ? { pluginId: match[1], type: match[2], text: (match[3] ?? '').replace(/\r\n?|\n/g, ' ') }
    : null;
}

/**
 * The Markdown of a span `pluginId` claims, of `type` holding `text`, with
 * enough backticks around it for the backticks in it: for a page's text,
 * or to insert where the person is typing.
 */
export function inlineSpan(pluginId: string, type: string, text: string): string {
  const one = text.replace(/\r\n?|\n/g, ' ');
  const code = one === '' ? `plugin:${pluginId}/${type}` : `plugin:${pluginId}/${type} ${one}`;
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  // A backtick at the end would close the span early; a space each side is read away.
  const pad = code.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${code}${pad}${fence}`;
}

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
  /** A property the field shows and sets (`BoundField`). */
  property?: string | undefined;
};

/** One line of text. */
export type TextField = {
  type: 'text';
  label: string;
  default?: string | undefined;
  /** A property the field shows and sets (`BoundField`). */
  property?: string | undefined;
};

/*
 * A field with `property` is bound to that page property, named by the
 * template-variable rule, as `setProperty` takes it: it shows the
 * property's value when the page has one, else its fence line or default,
 * and sets the property, never its fence line, once a valid value is
 * committed (blur or Enter), as a number for a number field. Where the
 * page can't change (`setProperty` is null), a value entered stays in the
 * form.
 */

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
  /** Every page operation: the SDK in the script sends each, `tree` too, whatever the app knows. */
  readonly pages: Required<Pages>;
  readonly blocks: {
    register<const Fields extends Record<string, BlockField>>(block: ScriptBlock<Fields>): Disposer;
  };
}

/**
 * Where an app plugin's interface can go beside the app's own, each with
 * what it registers there (`id` is unique within the plugin and region).
 * Several plugins in one place show in the order Settings lists them, then
 * in the order each registered. Each place is shown at every window size;
 * `REGIONS` says where each goes on a phone. A plugin's CSS may hide the
 * app's own content through its `data-region`; the regions in
 * `Replacements` can be drawn in its place instead.
 */
export type Regions = {
  /** A sheet beside the page, opened from its toolbar's Plugins menu, like History. */
  'page.panel': { id: string; title: string; view: View<PageViewProps> };
  /** In the page's toolbar, before the Plugins menu: keep it to a button or two. */
  'page.toolbar': { id: string; view: View<PageViewProps> };
  /**
   * In the draft view, in the editor's format toolbar (a bar of its own
   * over the source editor): keep it to a button or two. Its view's
   * `page.editor` is set.
   */
  'editor.toolbar': { id: string; view: View<PageViewProps> };
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

/**
 * The regions an app plugin can draw in place of the app's own part, with
 * `host.ui.replace(region, { id, view })`, where its manifest's `replaces`
 * names them (ADR 0011). One view draws each: the first installed (in
 * Settings' order, folder installs first on the desktop) whose plugin the
 * person hasn't turned back to the app's own there. It
 * draws only where the plugin has page access, the app's own part showing
 * elsewhere. A view that throws, or returns having drawn nothing, gives
 * the region back to the app's own part, with a note naming the plugin.
 * In safe mode every region is the app's own.
 */
export type Replacements = {
  /** What a space shows with no page open. */
  'space.home': { id: string; view: View<SpaceHomeProps> };
  /** A folder's page. */
  'folder.view': { id: string; view: View<FolderViewProps> };
};

/** Every region: one plugins add to (`Regions`), or one they can replace (`Replacements`). */
export type RegionName = keyof Regions | keyof Replacements;

/** What the README's table says of a region. */
export type RegionInfo = {
  /** `add`: plugins' views show beside the app's own. `replace`: one plugin's view can show in its place. */
  policy: 'add' | 'replace';
  /** What `host.ui.register` takes there, as it is written; null where it takes only `host.ui.replace`. */
  registers: string | null;
  /** Where it shows. */
  where: string;
  /** Where it shows on a phone. */
  phone: string;
};

/**
 * Every region, in the README's order, with what its table says of it. The
 * app draws each one through `Place` (`packages/ui/src/plugins/places.tsx`),
 * and a test checks the README against this.
 */
export const REGIONS = {
  rail: {
    policy: 'add',
    registers: '{ id, title, icon?, opens }',
    where: "A rail item opening the plugin's `app.view` named `opens`",
    phone: 'In the navigation drawer',
  },
  'app.view': {
    policy: 'add',
    registers: '{ id, title, view }',
    where: 'A page of its own in the main area; its view gets `openPage(page)`',
    phone: 'The same',
  },
  'space.home': {
    policy: 'replace',
    registers: null,
    where: 'What a space shows with no page open (Pick a page); its view gets `{ spaceId }`',
    phone: 'The same',
  },
  'folder.view': {
    policy: 'replace',
    registers: null,
    where: "A folder's page; its view gets `{ folder, entries }`, what `host.pages.list` gives",
    phone: 'The same',
  },
  'page.toolbar': {
    policy: 'add',
    registers: '{ id, view }',
    where: "The page's toolbar, before the Plugins menu",
    phone: 'The same; keep it to a button',
  },
  'editor.toolbar': {
    policy: 'add',
    registers: '{ id, view }',
    where:
      "The editor's format toolbar, in the draft view (a bar of its own over the source editor); its view's `page.editor` is set",
    phone: 'The same; keep it to a button',
  },
  'page.header': {
    policy: 'add',
    registers: '{ id, view }',
    where: "Above the page's text, under the banner",
    phone: 'The same',
  },
  'page.footer': {
    policy: 'add',
    registers: '{ id, view }',
    where: "Below the page's text",
    phone: 'The same',
  },
  'page.aside': {
    policy: 'add',
    registers: '{ id, view }',
    where: 'Beside the text, under its contents, where the page card is 960px wide or more',
    phone: 'Below the page',
  },
  'page.panel': {
    policy: 'add',
    registers: '{ id, title, view }',
    where: 'A sheet opened from the Plugins menu',
    phone: 'The same',
  },
  'settings.section': {
    policy: 'add',
    registers: '{ id, title, view }',
    where:
      "Under the plugin's row on the Plugins page (Settings → Plugins), opened by its **Settings** button",
    phone: 'The same',
  },
  'app.titlebar': {
    policy: 'add',
    registers: '{ id, view }',
    where:
      "The desktop app's titlebar, before its menu: a small button or two, which the view names for screen readers",
    phone: 'Not in the browser, which has no titlebar of its own',
  },
} as const satisfies {
  readonly [R in RegionName]: RegionInfo & {
    policy: R extends keyof Replacements ? 'replace' : 'add';
    registers: R extends keyof Regions ? string : null;
  };
};

/**
 * The `data-region` attributes a plugin's CSS can style the app through,
 * each with what it marks, in the README's order. A test checks the README
 * and the app's own attributes against this.
 */
export const DATA_REGIONS = {
  app: 'The whole window',
  titlebar: "The desktop app's titlebar",
  rail: 'The rail',
  topbar: "The phone's top bar",
  main: 'Beside the rail',
  sidebar: "A space's page tree",
  folder: "A folder's page",
  page: 'The page card',
  'page.cover': 'Its banner',
  'page.toolbar': 'Its toolbar',
  'page.body': 'The text and its aside',
  'page.content': "The page's column: header, title, text, footer",
  'page.header': "Plugins' views above the text, only while a plugin fills it",
  'page.footer': "Plugins' views below the text, only while a plugin fills it",
  'page.aside': "The contents and plugins' views beside the text, only while a plugin fills it",
  'editor.toolbar': "Plugins' buttons in the editor's format toolbar, only while a plugin fills it",
  'app.view': "A plugin's page",
  settings: 'Settings',
  workshop: 'The plugin workshop',
  'whats-new': "What's new",
  'safe-mode': 'The safe mode banner',
} as const;

const regionsWhere = (keep: (info: RegionInfo) => boolean) =>
  new Set<string>(
    Object.entries(REGIONS).flatMap(([name, info]: [string, RegionInfo]) =>
      keep(info) ? [name] : [],
    ),
  );
const ADDED = regionsWhere(({ registers }) => registers !== null);
const REPLACEABLE = regionsWhere(({ policy }) => policy === 'replace');

/** Whether `name` is a region plugins add to, for checking what a plugin asks for. */
export const isRegion = (name: string): name is keyof Regions => ADDED.has(name);

/** Whether `name` is a region a plugin can replace. */
export const isReplaceable = (name: string): name is keyof Replacements => REPLACEABLE.has(name);

/** What an app plugin gets beyond `Host`. */
export interface AppHost extends Host {
  /**
   * Its events, and `location.changed`, which an app older than it lacks:
   * it fails there, so call `app.location.subscribe` instead.
   */
  readonly events: {
    on<E extends keyof AppEvents>(
      event: E,
      handler: (event: AppEvents[E]) => void | Promise<void>,
    ): Disposer;
  };
  /** Where the person is, and the way elsewhere. Missing (undefined) in an app older than it. */
  readonly app?: AppAccess | undefined;
  readonly ui: {
    register<R extends keyof Regions>(region: R, contribution: Regions[R]): Disposer;
    /**
     * Draw `region` in place of the app's own part (`Replacements`): one its
     * manifest's `replaces` names, else `invalid`; `unsupported` for one this
     * app can't replace. Registering it again replaces the view before.
     * Missing (undefined) in an app older than it.
     */
    replace?<R extends keyof Replacements>(region: R, replacement: Replacements[R]): Disposer;
  };
  /** Draw a block type the manifest claims; `invalid` for one it doesn't. */
  readonly blocks: { register(block: Block): Disposer };
  /** Draw an inline code type the manifest's `inline` claims; `invalid` for one it doesn't. */
  readonly inline: { register(inline: Inline): Disposer };
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

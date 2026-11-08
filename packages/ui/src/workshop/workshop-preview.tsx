import {
  PageId,
  propertyKeyFor,
  readProperties,
  setProperty,
  SpaceId,
  splitFrontmatter,
  type Banner,
  type PropertyValue,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { pluginDraftRoutes, type pluginRoutes, type WorkshopVersion } from '@wikistow/contracts';
import { PluginError, type AppViewProps } from '@wikistow/plugin-sdk';
import { MANIFEST_FILE } from '@wikistow/plugin-sdk/manifest';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { desktop } from '../desktop';
import { errorMessage } from '../errors';
import { lineBreakOf, type EditorSurfaceHandle } from '../page/editor/surface';
import { VisualEditor } from '../page/editor/visual-editor';
import { inertHost } from '../page/editor/visual/host';
import { Markdown } from '../page/markdown';
import { bodyTop, CoverBand } from '../page/cover/cover-band';
import { PageCard, PageColumns, PageToolbar } from '../page/page-layout';
import { joinPage } from '../page/properties';
import { LIBRARY_KEY, uploadAndInstall, type PluginUpload } from '../plugins/library';
import { ConfirmUpload } from '../plugins/library-settings';
import { PagePlugins } from '../plugins/page-plugins';
import { Place, Replaceable, type OpenPanel } from '../plugins/places';
import { useAppPlugins } from '../plugins/app-plugins';
import type { MarkdownPage } from '../plugins/markdown-drawings';
import { RenderedMarkdown } from '../plugins/rendered-markdown';
import { DeclaredSettings } from '../plugins/declared-settings';
import { PluginsContext, usePlugins, type ShownPage } from '../plugins/runtime';
import { PickAPage } from '../shell/pick-a-page';
import { useClient } from '../vault/store';
import { Propose } from './proposals';
import { SAMPLE_SPACE, type Sample } from './samples';
import { OLD_SERVER, type Workshop } from './workshop';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.';

const LEVELS = { theme: 'Theme', script: 'Script', app: 'App' } as const;

/**
 * The workshop's preview (#257), beside its conversation: which version
 * runs, what its last build said, and the plugin itself, drawn by a
 * runtime of the workshop's own over sample pages. Its themes can be shown
 * across the app. Versions that built can be previewed again, and on the
 * desktop exported, each by the hash the person sees.
 */
export function WorkshopPreview({ workshop }: { workshop: Workshop }) {
  const state = useSyncExternalStore(workshop.subscribe, workshop.state);
  const samples = useSyncExternalStore(workshop.samples.subscribe, workshop.samples.get);
  const [selected, setSelected] = useState<string | null>(null);
  const sample = samples.find((page) => page.pageId === selected) ?? samples[0] ?? null;
  // With no sample shown, its plugin sees the person nowhere in particular.
  const none = sample === null;
  useEffect(() => {
    if (none) workshop.location.routed({ kind: 'other' });
  }, [workshop, none]);
  return (
    <div className="grid content-start gap-5">
      <Status workshop={workshop} />
      <Propose workshop={workshop} />
      {state.running && (
        <PluginsContext value={workshop.preview}>
          <Problems workshop={workshop} />
          <Themes workshop={workshop} />
          <section aria-label="Sample pages" className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold">Sample pages</h2>
              {samples.map((page) => (
                <Button
                  key={page.pageId}
                  size="sm"
                  variant={page === sample ? 'secondary' : 'ghost'}
                  aria-pressed={page === sample}
                  onClick={() => setSelected(page.pageId)}
                >
                  {page.title}
                </Button>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setSelected(workshop.samples.put({ title: 'Sample', markdown: '' }).pageId)
                }
              >
                New sample
              </Button>
            </div>
            {sample ? (
              <SamplePage workshop={workshop} sample={sample} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No sample pages yet. Ask the assistant for one, or copy one of your pages into the
                preview from the conversation.
              </p>
            )}
          </section>
          <PluginPlaces workshop={workshop} onOpen={setSelected} />
          <RenderedMarkdown drawings={workshop.markdown} Reader={SampleMarkdown} />
        </PluginsContext>
      )}
      <Versions workshop={workshop} />
      <Files workshop={workshop} />
    </div>
  );
}

/** Which version runs, whether the last build failed, and what it said. */
function Status({ workshop }: { workshop: Workshop }) {
  const { phase, failure, problem, opening, versions, running, building } = useSyncExternalStore(
    workshop.subscribe,
    workshop.state,
  );
  // Here, so how a publish went still shows once another version is in the preview.
  const [published, setPublished] = useState<Notice | null>(null);
  const latest = versions.at(-1);
  const newest = versions.findLast((version) => version.plugin !== null);
  const plugin = running?.plugin;
  if (phase === 'failed') {
    return (
      <p role="alert" className="text-sm text-destructive">
        {failure ?? 'The workshop couldn’t start.'}
      </p>
    );
  }
  return (
    <div className="grid gap-2" role="status" aria-label="Preview status">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {plugin ? (
          <>
            <Badge>Previewing v{running.version}</Badge>
            <strong>{plugin.manifest.name}</strong>
            <span className="text-muted-foreground">{plugin.manifest.version}</span>
            <Badge variant="secondary">{LEVELS[plugin.level]}</Badge>
            <Button size="sm" variant="outline" onClick={() => void workshop.unload()}>
              Unload
            </Button>
            <Publish workshop={workshop} version={running} onNotice={setPublished} />
          </>
        ) : (
          <span className="text-muted-foreground">
            {opening
              ? 'Opening the draft…'
              : versions.length === 0
                ? 'Nothing is built yet. Ask the assistant for a plugin.'
                : 'Nothing is in the preview.'}
          </span>
        )}
        {building && <span className="text-muted-foreground">Building…</span>}
      </div>
      {published && (
        <p
          role={published.failed ? 'alert' : 'status'}
          className={cn('text-sm', published.failed && 'text-destructive')}
        >
          {published.text}{' '}
          {!published.failed && (
            <Link to="/settings/plugins" search={{ tab: 'library' }} className="quiet-link">
              See it in the library
            </Link>
          )}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      {latest && !latest.plugin && !latest.history && (
        <Alert variant="destructive">
          <AlertDescription className="grid gap-1.5">
            <p>
              v{latest.version} didn’t build.{' '}
              {running && running.version < latest.version
                ? `The preview still shows v${running.version}${running.version === newest?.version ? ', the last version that did' : ''}.`
                : ''}
            </p>
            <Diagnostics version={latest} />
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

type Notice = { text: string; failed: boolean };

/**
 * Publish the version in the preview to the library (ADR 0004): the upload
 * confirmation, with Shared or Only me, then the upload, after any preview
 * upload under way, which installs it for the person on all their devices.
 * `onNotice` says how it went, or null as another publish starts.
 */
function Publish({
  workshop,
  version,
  onNotice,
}: {
  workshop: Workshop;
  version: WorkshopVersion;
  onNotice: (notice: Notice | null) => void;
}) {
  const { store: pluginStore, runtime: pluginRuntime } = useAppPlugins();
  const ctx = useClient();
  const queryClient = useQueryClient();
  const [upload, setUpload] = useState<PluginUpload | null>(null);
  const shown = version.plugin?.manifest;
  if (!shown) return null;
  const publish = async (
    chosen: PluginUpload,
    visibility: pluginRoutes.PluginVisibility | undefined,
  ) => {
    const { manifest } = chosen;
    onNotice(null);
    try {
      await workshop.oneLargeUpload(() => uploadAndInstall(pluginStore, chosen, visibility));
      onNotice({
        text: `Published ${manifest.name} ${manifest.version} and installed it on all your devices.`,
        failed: false,
      });
    } catch (failure) {
      onNotice({
        // The app's words for a refusal hide this one, which the person can fix.
        text:
          failure instanceof ApiError && failure.code === 'forbidden'
            ? `Another account owns the plugin ID ${manifest.id}. Ask the assistant to give it another ID, then publish again.`
            : errorMessage(failure),
        failed: true,
      });
    }
    await queryClient.invalidateQueries({ queryKey: LIBRARY_KEY });
    await pluginRuntime.refresh();
  };
  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          onNotice(null);
          setUpload({ ...workshop.versionFiles(version.version), manifest: shown });
        }}
      >
        Publish…
      </Button>
      <ConfirmUpload
        ctx={ctx}
        upload={upload}
        verb="Publish"
        onDone={() => setUpload(null)}
        onUpload={publish}
      />
    </>
  );
}

function Diagnostics({ version }: { version: WorkshopVersion }) {
  if (version.diagnostics.length === 0) return null;
  return (
    <ul className="grid gap-0.5 font-mono text-xs" aria-label={`v${version.version} diagnostics`}>
      {version.diagnostics.map((diagnostic, index) => (
        <li key={index}>
          {diagnostic.severity === 'warning' && 'Warning: '}
          {diagnostic.file &&
            `${diagnostic.file}${diagnostic.line === null ? '' : `:${diagnostic.line}:${diagnostic.column ?? 1}`} `}
          {diagnostic.message}
        </li>
      ))}
    </ul>
  );
}

/** What went wrong while it ran, and whether its app code may run. */
function Problems({ workshop }: { workshop: Workshop }) {
  const { running, appCode, errors } = useSyncExternalStore(workshop.subscribe, workshop.state);
  const { plugins } = usePlugins();
  const plugin = running?.plugin;
  const problem = plugins.find(
    (status) => status.plugin.manifest.id === plugin?.manifest.id,
  )?.problem;
  return (
    <>
      {plugin?.manifest.ui && !appCode && (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">
              This version has app code. It runs inside WikiStow with your trust, as an installed
              App plugin does: it can read what this window shows and use your account. Its script
              and styles run already.
            </span>
            <Button size="sm" onClick={() => void workshop.allowAppCode(true)}>
              Run its app code in this workshop
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {plugin?.manifest.ui && appCode && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          This workshop’s app code runs in the preview, with your trust.
          <Button size="sm" variant="outline" onClick={() => void workshop.allowAppCode(false)}>
            Stop running it
          </Button>
        </p>
      )}
      {(problem || errors.length > 0) && (
        <Alert variant="destructive">
          <AlertDescription className="grid gap-1 text-sm">
            {problem && <p>{problem}</p>}
            {errors.map((error, index) => (
              <p key={index} className="font-mono text-xs">
                {error}
              </p>
            ))}
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}

/** The running version's themes, each to show across the app until the workshop stops. */
function Themes({ workshop }: { workshop: Workshop }) {
  const { running, theme } = useSyncExternalStore(workshop.subscribe, workshop.state);
  const themes = running?.plugin?.manifest.themes ?? [];
  if (themes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Theme">
      <span className="font-bold">Theme across the app</span>
      <Button
        size="sm"
        variant={theme === null ? 'secondary' : 'ghost'}
        aria-pressed={theme === null}
        onClick={() => void workshop.showTheme(null)}
      >
        Not shown
      </Button>
      {themes.map(({ id, name }) => (
        <Button
          key={id}
          size="sm"
          variant={theme === id ? 'secondary' : 'ghost'}
          aria-pressed={theme === id}
          onClick={() => void workshop.showTheme(id)}
        >
          {name}
        </Button>
      ))}
      {theme !== null && (
        <span className="text-xs text-muted-foreground">
          Previewing: nothing is chosen until it’s installed and picked in Settings.
        </span>
      )}
    </div>
  );
}

const INERT = inertHost();

/**
 * A sample page with the plugin's places, in its editor (a draft view,
 * where blocks change the sample's text and its properties, and commands
 * may edit it) or as a reader sees it. The editor holds the body, its
 * frontmatter split off as the draft editor splits it. It is the
 * workshop's own text: nothing is saved anywhere.
 */
function SamplePage({ workshop, sample }: { workshop: Workshop; sample: Sample }) {
  const ctx = useClient();
  const [mode, setMode] = useState<'editor' | 'reader'>('editor');
  const editor = useRef<EditorSurfaceHandle>(null);
  const { frontmatter, body } = splitFrontmatter(sample.markdown);
  // The frontmatter now, for what's typed and set before the sample shows it.
  const frontmatterNow = useRef(frontmatter);
  frontmatterNow.current = frontmatter;
  const properties = useMemo(() => {
    const read = readProperties(frontmatter);
    return read.ok ? read.properties : null;
  }, [frontmatter]);
  // What is typed reaches the sample before the plugin reads or edits it.
  useEffect(
    () =>
      workshop.samples.editing(sample.pageId, {
        handOver: () => {
          const text = editor.current?.read();
          if (text !== undefined)
            workshop.typed(sample.pageId, joinPage(frontmatterNow.current, text), sample.outside);
        },
        selection: () => editor.current?.selection?.() ?? '',
        insert: (markdown) => editor.current?.insert?.(markdown),
      }),
    [workshop, sample.pageId, sample.outside],
  );
  // A block's property set as the draft editor sets one: only that value changes.
  const setOne = (key: string, value: PropertyValue) => {
    const block = frontmatterNow.current;
    const text = editor.current?.read() ?? body;
    const edit = setProperty(block, propertyKeyFor(block, key), value, lineBreakOf(block ?? text));
    if (!edit.ok) return edit;
    frontmatterNow.current = edit.frontmatter;
    workshop.typed(sample.pageId, joinPage(edit.frontmatter, text), sample.outside);
    return { ok: true } as const;
  };
  const [panel, setPanel] = useState<OpenPanel>(null);
  const shown = useMemo<ShownPage>(
    () => ({
      page: { spaceId: SAMPLE_SPACE, pageId: sample.pageId },
      version: mode === 'editor' ? 'draft' : 'published',
      // Changed by the plugin or the assistant, not by typing here: views keep their place meanwhile.
      revision: String(sample.outside),
      draft: null,
    }),
    [sample.pageId, sample.outside, mode],
  );
  // Where its plugin sees the person: on this sample, as the app's router
  // and page route tell their plugins of a page. Here, not in the preview
  // around it, whose effects run after this one's.
  useEffect(() => {
    workshop.location.routed({ kind: 'page', ...shown.page });
    return workshop.location.showing({
      page: shown.page,
      version: shown.version,
      revision: shown.revision,
    });
  }, [workshop, shown]);
  const page = useMemo(
    () => ({ spaceId: SpaceId.parse(SAMPLE_SPACE), pageId: PageId.parse(sample.pageId) }),
    [sample.pageId],
  );
  const attachments = { ctx, page, audience: 'draft', attachments: [] } as const;
  return (
    <PageCard label={`Sample page ${sample.title}`}>
      <CoverBand banner={THEME_BANNER} attachments={attachments}>
        <PageToolbar>
          <span className="min-w-0 flex-1 truncate font-bold">
            {sample.copyOf ? `A copy of “${sample.copyOf}”` : 'Sample page'}
          </span>
          <div role="group" aria-label="Show it" className="flex gap-1">
            {(['editor', 'reader'] as const).map((choice) => (
              <Button
                key={choice}
                size="sm"
                variant={mode === choice ? 'secondary' : 'ghost'}
                aria-pressed={mode === choice}
                onClick={() => setMode(choice)}
              >
                {choice === 'editor' ? 'Editor' : 'Reader'}
              </Button>
            ))}
          </div>
          <Place name="page.toolbar" shown={shown} />
          <PagePlugins shown={shown} onOpenPanel={setPanel} />
        </PageToolbar>
      </CoverBand>
      <PageColumns shown={shown} contents={null} className={bodyTop(false)}>
        <h2 className="text-2xl font-extrabold">{sample.title}</h2>
        {mode === 'editor' ? (
          <div className="min-h-40">
            <VisualEditor
              // Changes from outside the editor show afresh; typing doesn't redraw it.
              key={`${sample.pageId}:${sample.outside}`}
              ref={editor}
              initial={body}
              // As it goes, an editor replaced for a change from outside reports
              // its last text, which mustn't undo that change.
              onChange={(text) =>
                workshop.typed(
                  sample.pageId,
                  joinPage(frontmatterNow.current, text),
                  sample.outside,
                )
              }
              properties={properties}
              setProperty={setOne}
              links={INERT.links()}
              attachments={INERT.attachments()}
              onFiles={() => {}}
              page={shown.page}
              toolbar={<Place name="editor.toolbar" shown={shown} />}
            />
          </div>
        ) : (
          <Markdown
            source={sample.markdown}
            attachments={attachments}
            pages={null}
            links={new Map()}
            editing={null}
            bodyIn={(own, markdown) => (
              <Replaceable
                name="page.reader"
                inputs={{ page: shown.page, revision: shown.revision, markdown }}
              >
                {own}
              </Replaceable>
            )}
          />
        )}
      </PageColumns>
      {/* Its panels only: the page's own, such as History, need a page the server has. */}
      <Place name="page.panel" shown={shown} open={panel} onOpenChange={setPanel} own={null} />
    </PageCard>
  );
}

const THEME_BANNER: Banner = { kind: 'theme' };

const NO_RAIL = {};

const viewKey = (pluginId: string, viewId: string) => `app.view:${pluginId}:${viewId}`;

/** The workshop's reader for its plugin's Markdown (`host.app.renderMarkdown`), as a sample's reader shows it. */
function SampleMarkdown({ markdown, page }: { markdown: string; page: MarkdownPage }) {
  const ctx = useClient();
  return (
    <Markdown
      source={markdown}
      attachments={{
        ctx,
        page: { spaceId: page.spaceId, pageId: page.pageId },
        audience: 'draft',
        attachments: [],
      }}
      pages={null}
      links={NO_LINKS}
      editing={null}
    />
  );
}

const NO_LINKS: ReadonlyMap<string, string> = new Map();

/**
 * The plugin's other places, each drawn as the app draws it, opened here:
 * its own pages, which its rail items open too, the rail, the samples'
 * page tree and space home where it replaces those, its Settings sections
 * and its titlebar buttons. Its `host.app.navigate` stays in the preview: it
 * opens a sample page, or one of the plugin's own pages here, and fails
 * with `unsupported` for anywhere else.
 */
function PluginPlaces({
  workshop,
  onOpen,
}: {
  workshop: Workshop;
  onOpen: (pageId: string) => void;
}) {
  const { regions, replaced, plugins } = usePlugins();
  // The sample pages, which a replaced page tree is given again as they change.
  const samples = useSyncExternalStore(workshop.samples.subscribe, workshop.samples.get);
  const [open, setOpen] = useState<string | null>(null);
  const appView = useMemo<AppViewProps>(
    () => ({ openPage: (page) => page.spaceId === SAMPLE_SPACE && onOpen(page.pageId) }),
    [onOpen],
  );
  // The plugin page a rail item opened, which may name one the plugin hasn't registered.
  const [railView, setRailView] = useState<{ pluginId: string; viewId: string } | null>(null);
  useEffect(
    () =>
      workshop.location.navigateWith(async (to) => {
        if (to.kind === 'plugin') {
          setRailView({ pluginId: to.pluginId, viewId: to.viewId });
          setOpen(viewKey(to.pluginId, to.viewId));
        } else if (to.kind === 'settings') {
          // Its settings here, kept in the workshop: none to open shows nothing.
          setOpen(`settings.section:${to.pluginId}`);
        } else if (
          to.kind === 'page' &&
          to.spaceId === SAMPLE_SPACE &&
          workshop.samples.get().some(({ pageId }) => pageId === to.pageId)
        ) {
          onOpen(to.pageId);
        } else {
          throw new PluginError('unsupported', 'The preview opens only its sample pages');
        }
      }),
    [workshop, onOpen],
  );
  const drawView = (pluginId: string, viewId: string) => (
    <div className="grid gap-6">
      <Place name="app.view" pluginId={pluginId} viewId={viewId} props={appView} />
    </div>
  );
  const places = [
    ...regions['app.view'].map((view) => ({
      key: viewKey(view.pluginId, view.id),
      label: `Page: ${view.title}`,
      draw: () => drawView(view.pluginId, view.id),
    })),
    // The whole rail, as the app's window shows it beside the page.
    ...(replaced.rail
      ? [
          {
            key: 'rail.replaced',
            label: 'The rail',
            draw: () => (
              <div className="h-96 w-[70px]">
                <Replaceable name="rail" inputs={NO_RAIL}>
                  <p className="text-xs text-muted-foreground">The app’s own rail</p>
                </Replaceable>
              </div>
            ),
          },
        ]
      : []),
    // The samples' page tree, as the sidebar beside a page shows it.
    ...(replaced['space.sidebar']
      ? [
          {
            key: 'space.sidebar',
            label: 'Sidebar',
            draw: () => (
              <div className="h-96 w-(--sidebar-width)">
                <Replaceable
                  name="space.sidebar"
                  inputs={{ spaceId: SAMPLE_SPACE }}
                  stamp={samples}
                >
                  <p className="text-sm text-muted-foreground">The app’s own page tree</p>
                </Replaceable>
              </div>
            ),
          },
        ]
      : []),
    // The samples' one space, as a space with no page open shows it.
    ...(replaced['space.home']
      ? [
          {
            key: 'space.home',
            label: 'Space home',
            draw: () => (
              <div className="h-96">
                <Replaceable name="space.home" inputs={{ spaceId: SAMPLE_SPACE }}>
                  <PickAPage />
                </Replaceable>
              </div>
            ),
          },
        ]
      : []),
    // Each plugin's settings together, as its row on the Plugins page shows them: those its
    // manifest declares, then its sections. What it keeps there stays in the workshop.
    ...plugins
      .map(({ plugin }) => plugin)
      .filter(
        ({ manifest }) =>
          (manifest.settings?.length ?? 0) > 0 ||
          regions['settings.section'].some(({ pluginId }) => pluginId === manifest.id),
      )
      .map((plugin) => ({
        key: `settings.section:${plugin.manifest.id}`,
        label: 'Settings',
        draw: () => (
          <div className="grid gap-2">
            <DeclaredSettings plugin={plugin} />
            <Place name="settings.section" pluginId={plugin.manifest.id} />
          </div>
        ),
      })),
    // All its titlebar buttons, as the desktop app's titlebar shows them.
    ...(regions['app.titlebar'].length > 0
      ? [
          {
            key: 'app.titlebar',
            label: 'Titlebar',
            draw: () => (
              <div className="flex h-9 items-center justify-end gap-1">
                <Place name="app.titlebar" />
              </div>
            ),
          },
        ]
      : []),
  ];
  const rail = regions.rail.length > 0;
  if (places.length === 0 && !rail) return null;
  // A rail item naming a page the plugin lacks shows "Not available", as the app does.
  const shown =
    places.find((place) => place.key === open) ??
    (railView && open === viewKey(railView.pluginId, railView.viewId)
      ? { key: open, draw: () => drawView(railView.pluginId, railView.viewId) }
      : undefined);
  return (
    <section aria-label="Its other places" className="grid gap-2">
      <h2 className="text-sm font-bold">Its other places</h2>
      {rail && (
        <div role="group" aria-label="Rail" className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">Rail</span>
          <Place
            name="rail"
            open={({ pluginId, opens }) => {
              setRailView({ pluginId, viewId: opens });
              setOpen(viewKey(pluginId, opens));
            }}
          />
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {places.map((place) => (
          <Button
            key={place.key}
            size="sm"
            variant={open === place.key ? 'secondary' : 'ghost'}
            aria-pressed={open === place.key}
            onClick={() => setOpen(open === place.key ? null : place.key)}
          >
            {place.label}
          </Button>
        ))}
      </div>
      {shown && (
        <div key={shown.key} className="rounded-card border bg-background p-4">
          {shown.draw()}
        </div>
      )}
    </section>
  );
}

/**
 * Every build, newest first: preview any that built, or on the desktop
 * export it, by its hash. One kept from before whose build isn't kept is
 * history only.
 */
function Versions({ workshop }: { workshop: Workshop }) {
  const { versions, running } = useSyncExternalStore(workshop.subscribe, workshop.state);
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);
  const act = async (run: () => Promise<string | null>) => {
    setNotice(null);
    try {
      const text = await run();
      if (text) setNotice({ text, failed: false });
    } catch (error) {
      setNotice({ text: message(error), failed: true });
    }
  };
  if (versions.length === 0) return null;
  return (
    <section aria-label="Versions" className="grid gap-2">
      <h2 className="text-sm font-bold">Versions</h2>
      {notice && (
        <p
          role={notice.failed ? 'alert' : 'status'}
          className={cn('text-sm', notice.failed && 'text-destructive')}
        >
          {notice.text}
        </p>
      )}
      <ul className="grid gap-2">
        {[...versions].reverse().map((version) => (
          <li
            key={version.version}
            aria-label={`Version ${version.version}`}
            className="grid gap-1.5 rounded-control border p-3 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <strong>v{version.version}</strong>
              {version.plugin ? (
                <span>
                  {version.plugin.manifest.name} {version.plugin.manifest.version}
                </span>
              ) : version.history ? (
                <>
                  <span>
                    {version.history.name} {version.history.version}
                  </span>
                  <Badge variant="secondary">Build not kept</Badge>
                </>
              ) : (
                <Badge variant="destructive">Didn’t build</Badge>
              )}
              {running?.version === version.version && <Badge>In the preview</Badge>}
              <span className="flex-1" />
              {version.plugin && running?.version !== version.version && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void act(async () => (await workshop.load(version.version), null))}
                >
                  Preview
                </Button>
              )}
              {version.plugin && desktop && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void act(async () => {
                      const folder = await workshop.export(version.version);
                      return folder && `Exported v${version.version} to ${folder}.`;
                    })
                  }
                >
                  Export…
                </Button>
              )}
            </div>
            {version.hash && (
              <p className="text-xs break-all text-muted-foreground">SHA-256 {version.hash}</p>
            )}
            {version.plugin || version.history ? <Diagnostics version={version} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Fonts and images as an Add file… input takes them. */
const BINARY_ACCEPT = pluginDraftRoutes.DRAFT_BINARY_KINDS.join(',');

const kilobytes = (size: number) => `${Math.max(1, Math.round(size / 1024))} KB`;

/**
 * The draft's files as saved, to read what the assistant wrote, and
 * **Add file…**, which adds fonts and images under `public/`: the model
 * can't write those.
 */
function Files({ workshop }: { workshop: Workshop }) {
  const { phase, files, binary } = useSyncExternalStore(workshop.subscribe, workshop.state);
  const [path, setPath] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  if (phase !== 'ready') return null;
  const add = async (chosen: File[]) => {
    setProblem(null);
    setAdding(true);
    let added = false;
    try {
      // One at a time: each is its own upload.
      for (const file of chosen) {
        const path = `public/${file.name}`;
        // The person chose a file, not a path: say what its name needs.
        if (pluginDraftRoutes.draftPathProblem(path)) {
          throw new Error(
            `“${file.name}” can’t be added: a font or image’s name uses only letters, digits, _, . and -, and ends in ${pluginDraftRoutes.DRAFT_BINARY_KINDS.join(', ')}. Rename it and add it again.`,
          );
        }
        await workshop.addBinary(path, new Uint8Array(await file.arrayBuffer()));
        added = true;
      }
    } catch (error) {
      // Only a server from before fonts and images in drafts has no route for them: it
      // answers 404, or 413 past its usual 1 MiB body. The limits were checked here first.
      const old = error instanceof ApiError && (error.status === 404 || error.status === 413);
      setProblem(old ? OLD_SERVER : message(error));
    }
    try {
      // Built and previewed at once, as on opening, so Publish carries what was added.
      if (added && workshop.state().files.has(MANIFEST_FILE)) await workshop.buildAndPreview();
    } catch (error) {
      setProblem(message(error));
    } finally {
      setAdding(false);
    }
  };
  const text = path === null ? undefined : files.get(path);
  const bytes = path === null ? undefined : binary.get(path);
  const paths = [...files.keys(), ...binary.keys()].sort();
  return (
    <section aria-label="Draft files" className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-sm font-bold">Draft files</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={adding}
          onClick={() => input.current?.click()}
        >
          Add file…
        </Button>
        <input
          ref={input}
          type="file"
          hidden
          multiple
          accept={BINARY_ACCEPT}
          aria-label="Font or image"
          onChange={(event) => {
            const chosen = [...(event.target.files ?? [])];
            // So choosing the same file again sends it again.
            event.target.value = '';
            if (chosen.length > 0) void add(chosen);
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Add fonts and images ({pluginDraftRoutes.DRAFT_BINARY_KINDS.join(' ')}, 1 MB each) to
        public/. The assistant can list and delete them, but not write them.
      </p>
      {problem && (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      {paths.length > 0 && (
        <div role="group" aria-label="Files" className="flex flex-wrap gap-1">
          {paths.map((file) => (
            <Button
              key={file}
              size="sm"
              variant={path === file ? 'secondary' : 'ghost'}
              aria-pressed={path === file}
              onClick={() => setPath(path === file ? null : file)}
              className="font-mono"
            >
              {file}
            </Button>
          ))}
        </div>
      )}
      {path && text !== undefined && (
        <pre
          aria-label={path}
          className="max-h-96 overflow-auto rounded-control bg-muted p-3 font-mono text-xs whitespace-pre"
        >
          {text}
        </pre>
      )}
      {path && bytes !== undefined && (
        <p aria-label={path} className="text-sm text-muted-foreground">
          A font or image, {kilobytes(bytes.length)}, at {path.slice('public/'.length)} in the built
          plugin.
        </p>
      )}
    </section>
  );
}

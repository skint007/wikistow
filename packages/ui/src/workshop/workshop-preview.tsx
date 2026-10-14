import { PageId, SpaceId } from '@wikistow/client';
import type { PluginCandidate, WorkshopVersion } from '@wikistow/contracts';
import type { AppViewProps, SettingsViewProps } from '@wikistow/plugin-sdk';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { desktop } from '../desktop';
import type { EditorSurfaceHandle } from '../page/editor/surface';
import { VisualEditor } from '../page/editor/visual-editor';
import { inertHost } from '../page/editor/visual/host';
import { Markdown } from '../page/markdown';
import { PagePlugins } from '../plugins/page-plugins';
import { Approval } from '../plugins/plugin-settings';
import { PageViews, pluginName } from '../plugins/regions';
import { pluginRuntime, PluginsContext, usePlugins, type ShownPage } from '../plugins/runtime';
import { PluginView } from '../plugins/views';
import { useClient } from '../vault/store';
import { SAMPLE_SPACE, type Sample } from './samples';
import type { Workshop } from './workshop';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.';

const LEVELS = { theme: 'Theme', script: 'Script', app: 'App' } as const;

/**
 * The workshop's preview (#257), beside its conversation: which version
 * runs, what its last build said, and the plugin itself, drawn by a
 * runtime of the workshop's own over sample pages. Its themes can be shown
 * across the app. Versions that built can be previewed again, exported or
 * installed, each by the hash the person sees.
 */
export function WorkshopPreview({ workshop }: { workshop: Workshop }) {
  const state = useSyncExternalStore(workshop.subscribe, workshop.state);
  const samples = useSyncExternalStore(workshop.samples.subscribe, workshop.samples.get);
  const [selected, setSelected] = useState<string | null>(null);
  const sample = samples.find((page) => page.pageId === selected) ?? samples[0] ?? null;
  return (
    <div className="grid content-start gap-5">
      <Status workshop={workshop} />
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
                variant="ghost"
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
          <PluginPlaces onOpen={setSelected} />
        </PluginsContext>
      )}
      <Versions workshop={workshop} />
      <Files workshop={workshop} />
    </div>
  );
}

/** Which version runs, whether the last build failed, and what it said. */
function Status({ workshop }: { workshop: Workshop }) {
  const { phase, failure, versions, running, building } = useSyncExternalStore(
    workshop.subscribe,
    workshop.state,
  );
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
            <Button size="sm" variant="ghost" onClick={() => void workshop.unload()}>
              Unload
            </Button>
          </>
        ) : (
          <span className="text-muted-foreground">
            {versions.length === 0
              ? 'Nothing is built yet. Ask the assistant for a plugin.'
              : 'Nothing is in the preview.'}
          </span>
        )}
        {building && <span className="text-muted-foreground">Building…</span>}
      </div>
      {latest && !latest.plugin && (
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
          <Button size="sm" variant="ghost" onClick={() => void workshop.allowAppCode(false)}>
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
        onClick={() => workshop.showTheme(null)}
      >
        Not shown
      </Button>
      {themes.map(({ id, name }) => (
        <Button
          key={id}
          size="sm"
          variant={theme === id ? 'secondary' : 'ghost'}
          aria-pressed={theme === id}
          onClick={() => workshop.showTheme(id)}
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
 * where blocks change the sample's text and commands may edit it) or as a
 * reader sees it. It is the workshop's own text: nothing is saved anywhere.
 */
function SamplePage({ workshop, sample }: { workshop: Workshop; sample: Sample }) {
  const ctx = useClient();
  const [mode, setMode] = useState<'editor' | 'reader'>('editor');
  const editor = useRef<EditorSurfaceHandle>(null);
  // What is typed reaches the sample before the plugin reads or edits it.
  useEffect(
    () =>
      workshop.samples.editing(sample.pageId, () => {
        const text = editor.current?.read();
        if (text !== undefined) workshop.typed(sample.pageId, text, sample.outside);
      }),
    [workshop, sample.pageId, sample.outside],
  );
  const { regions } = usePlugins();
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
  const page = useMemo(
    () => ({ spaceId: SpaceId.parse(SAMPLE_SPACE), pageId: PageId.parse(sample.pageId) }),
    [sample.pageId],
  );
  return (
    <article
      data-region="page"
      aria-label={`Sample page ${sample.title}`}
      className="grid rounded-card border bg-background"
    >
      <div
        data-region="page.toolbar"
        className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm"
      >
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
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
        <PageViews place="page.toolbar" shown={shown} />
        <PagePlugins shown={shown} />
      </div>
      <div data-region="page.body" className="grid gap-6 p-6 min-[960px]:grid-cols-[1fr_auto]">
        <div data-region="page.content" className="grid min-w-0 content-start gap-4">
          {regions['page.header'].length > 0 && (
            <div data-region="page.header" className="grid gap-2">
              <PageViews place="page.header" shown={shown} />
            </div>
          )}
          <h2 className="text-2xl font-extrabold">{sample.title}</h2>
          {mode === 'editor' ? (
            <div className="min-h-40">
              <VisualEditor
                // Changes from outside the editor show afresh; typing doesn't redraw it.
                key={`${sample.pageId}:${sample.outside}`}
                ref={editor}
                initial={sample.markdown}
                // As it goes, an editor replaced for a change from outside reports
                // its last text, which mustn't undo that change.
                onChange={(markdown) => workshop.typed(sample.pageId, markdown, sample.outside)}
                links={INERT.links()}
                attachments={INERT.attachments()}
                onFiles={() => {}}
                page={shown.page}
              />
            </div>
          ) : (
            <Markdown
              source={sample.markdown}
              attachments={{ ctx, page, audience: 'draft', attachments: [] }}
              pages={null}
              links={new Map()}
              editing={null}
            />
          )}
          {regions['page.footer'].length > 0 && (
            <div data-region="page.footer" className="grid gap-2">
              <PageViews place="page.footer" shown={shown} />
            </div>
          )}
        </div>
        {regions['page.aside'].length > 0 && (
          <div data-region="page.aside" className="grid w-60 content-start gap-3">
            <PageViews place="page.aside" shown={shown} />
          </div>
        )}
      </div>
    </article>
  );
}

const NO_SETTINGS: SettingsViewProps = {};

/** The plugin's own pages, rail items and Settings sections, opened here. */
function PluginPlaces({ onOpen }: { onOpen: (pageId: string) => void }) {
  const { regions, plugins } = usePlugins();
  const [open, setOpen] = useState<string | null>(null);
  const appView = useMemo<AppViewProps>(
    () => ({ openPage: (page) => page.spaceId === SAMPLE_SPACE && onOpen(page.pageId) }),
    [onOpen],
  );
  const places = [
    ...regions['app.view'].map((view) => ({
      key: `app.view:${view.id}`,
      label: `Page: ${view.title}`,
      draw: () => (
        <PluginView
          pluginId={view.pluginId}
          name={pluginName(plugins, view.pluginId)}
          view={view.view}
          props={appView}
        />
      ),
    })),
    ...regions['settings.section'].map((section) => ({
      key: `settings.section:${section.id}`,
      label: `Settings: ${section.title}`,
      draw: () => (
        <PluginView
          pluginId={section.pluginId}
          name={pluginName(plugins, section.pluginId)}
          view={section.view}
          props={NO_SETTINGS}
        />
      ),
    })),
  ];
  const rail = regions.rail;
  if (places.length === 0 && rail.length === 0) return null;
  const shown = places.find((place) => place.key === open);
  return (
    <section aria-label="Its other places" className="grid gap-2">
      <h2 className="text-sm font-bold">Its other places</h2>
      {rail.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Rail:{' '}
          {rail
            .map(
              (item) =>
                `${item.icon ?? item.title.slice(0, 1)} ${item.title} (opens ${item.opens})`,
            )
            .join(', ')}
        </p>
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

/** Every build, newest first: preview any that built, or export or install it by its hash. */
function Versions({ workshop }: { workshop: Workshop }) {
  const { versions, running } = useSyncExternalStore(workshop.subscribe, workshop.state);
  const [candidate, setCandidate] = useState<PluginCandidate | null>(null);
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
              ) : (
                <Badge variant="destructive">Didn’t build</Badge>
              )}
              {running?.version === version.version && <Badge>In the preview</Badge>}
              <span className="flex-1" />
              {version.plugin && running?.version !== version.version && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void act(async () => (await workshop.load(version.version), null))}
                >
                  Preview
                </Button>
              )}
              {version.plugin && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void act(async () => {
                        const folder = await workshop.export(version);
                        return folder && `Exported v${version.version} to ${folder}.`;
                      })
                    }
                  >
                    Export…
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      void act(async () => {
                        setCandidate(await workshop.install(version));
                        return null;
                      })
                    }
                  >
                    Install…
                  </Button>
                </>
              )}
            </div>
            {version.hash && (
              <p className="text-xs break-all text-muted-foreground">SHA-256 {version.hash}</p>
            )}
            {version.plugin ? <Diagnostics version={version} /> : null}
          </li>
        ))}
      </ul>
      <Approval
        candidate={candidate}
        onDone={() => setCandidate(null)}
        onApprove={(token) =>
          act(async () => {
            await desktop?.approvePlugin(token);
            await pluginRuntime.refresh();
            return 'Installed. It runs across the app now, outside the workshop, as Settings → Plugins lists it.';
          })
        }
      />
    </section>
  );
}

/** The workspace's files, to read what the assistant wrote. */
function Files({ workshop }: { workshop: Workshop }) {
  const { versions } = useSyncExternalStore(workshop.subscribe, workshop.state);
  const [path, setPath] = useState<string | null>(null);
  // Listed afresh with each build.
  const files = useQuery({
    queryKey: ['workshop-files', workshop.id, versions.length],
    queryFn: () => workshop.files(),
  });
  const text = useQuery({
    queryKey: ['workshop-file', workshop.id, versions.length, path],
    queryFn: () => (path ? workshop.read(path) : null),
    enabled: path !== null,
  });
  if (!files.data?.length) return null;
  return (
    <section aria-label="Workspace files" className="grid gap-2">
      <h2 className="text-sm font-bold">Workspace files</h2>
      <div className="flex flex-wrap gap-1">
        {files.data.map((file) => (
          <Button
            key={file.path}
            size="sm"
            variant={path === file.path ? 'secondary' : 'ghost'}
            aria-pressed={path === file.path}
            onClick={() => setPath(path === file.path ? null : file.path)}
            className="font-mono"
          >
            {file.path}
          </Button>
        ))}
      </div>
      {path && (
        <pre
          aria-label={path}
          className="max-h-96 overflow-auto rounded-control bg-muted p-3 font-mono text-xs whitespace-pre"
        >
          {text.data ?? 'Reading…'}
        </pre>
      )}
    </section>
  );
}

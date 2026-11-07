import type { ClientContext, pageOperations, RevisionId } from '@wikistow/client';
import type {
  AppViewProps,
  PageViewProps,
  Regions,
  SettingsViewProps,
  TitlebarViewProps,
  View,
} from '@wikistow/plugin-sdk';
import { Link } from '@tanstack/react-router';
import { History, type LucideIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { HistorySheet } from '../page/history-sheet';
import { TableOfContents, type Heading } from '../page/table-of-contents';
import {
  usePluginRuntime,
  usePlugins,
  type Contribution,
  type PluginsSnapshot,
  type ShownPage,
} from './runtime';
import { PluginView } from './views';

/*
 * Every place plugins draw into, and the one way to draw one: `<Place
 * name=… />`. Each place draws the app's own parts first, then what
 * running plugins registered there, in the order Settings lists them and
 * then the order each registered (ADR 0001). A plugin's view is mounted
 * by `PluginView`, which says so in its place, with Disable, if it fails.
 * The SDK's `REGIONS` is the plugin-facing side of the same table: what
 * each registers and where it shows.
 */

/** What a page gives its own panels. */
export type PagePanelProps = {
  ctx: ClientContext;
  page: pageOperations.PageRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The person can change the page: an editor, on a page with a draft. */
  editor: boolean;
  /** The publication shown, or null in the draft view. */
  published: RevisionId | null;
  /** In the draft view: save what's typed, and open the draft afresh. */
  draft: { flush: () => Promise<void>; reopen: () => Promise<void> } | null;
};

/** One of the page's own panels, opened by a button of its own in the page's toolbar. */
export type OwnPanel = {
  id: string;
  label: string;
  icon: LucideIcon;
  Panel: ComponentType<PagePanelProps>;
};

/** The app's own `page.panel`s, which come before plugins'. */
export const OWN_PANELS: readonly OwnPanel[] = [
  {
    id: 'history',
    label: 'History',
    icon: History,
    Panel: ({ editor, published, draft, ...props }) => (
      <HistorySheet
        {...props}
        canRestore={editor}
        showing={published}
        beforeRestore={draft?.flush}
        onRestored={draft?.reopen}
      />
    ),
  },
];

/** Which of a page's panels is open: an own panel's ID, or `panelKey` of a plugin's. */
export type OpenPanel = string | null;

/** A plugin's panel, as `OpenPanel` names it. */
export const panelKey = ({ pluginId, id }: Contribution<'page.panel'>) => `${pluginId}:${id}`;

/** What the app gives each place, where it draws it. */
export type PlaceInputs = {
  rail: {
    /** Called as an item is chosen, such as to close the phone's drawer. */
    onNavigate?: (() => void) | undefined;
    /** Opens an item's `app.view` in place of going to its page, as the workshop's preview does. */
    open?: ((item: Contribution<'rail'>) => void) | undefined;
  };
  /** One plugin page, by its plugin and ID. */
  'app.view': { pluginId: string; viewId: string; props: AppViewProps };
  'page.toolbar': { shown: ShownPage };
  'page.header': { shown: ShownPage };
  'page.footer': { shown: ShownPage };
  'page.aside': {
    shown: ShownPage;
    /** The page's table of contents, the app's own aside, where it has one. */
    contents: { headings: Heading[]; card: HTMLElement | null } | null;
  };
  'page.panel': {
    shown: ShownPage;
    open: OpenPanel;
    onOpenChange: (open: OpenPanel) => void;
    /** What the page's own panels are given, or null where they don't show, as in the workshop. */
    own: Omit<PagePanelProps, 'open' | 'onOpenChange'> | null;
  };
  /** One plugin's sections. */
  'settings.section': { pluginId: string };
  'app.titlebar': Record<never, never>;
};

/** What a place's drawing gets: the app's inputs, and what plugins registered there. */
type Drawing<R extends keyof Regions> = PlaceInputs[R] & {
  items: Contribution<R>[];
  nameOf: (pluginId: string) => string;
};

/** A plugin's name, for what is said about it. */
export const pluginName = (plugins: PluginsSnapshot['plugins'], pluginId: string) =>
  plugins.find(({ plugin }) => plugin.manifest.id === pluginId)?.plugin.manifest.name ?? pluginId;

/**
 * How each place is drawn. Drawings call no hooks: what needs one is a
 * component they draw.
 */
const PLACES: { [R in keyof Regions]: (drawing: Drawing<R>) => ReactNode } = {
  rail: ({ items, onNavigate, open }) =>
    items.map((item) => (
      <RailItem
        key={`${item.pluginId}:${item.id}`}
        item={item}
        onNavigate={onNavigate}
        open={open}
      />
    )),
  'app.view': ({ items, pluginId, viewId, props, nameOf }) => {
    const view = items.find((item) => item.pluginId === pluginId && item.id === viewId);
    if (!view) {
      return (
        <div className="grid gap-2">
          <h1 className="text-[32px] leading-tight font-extrabold">Not available</h1>
          <p className="text-sm text-muted-foreground">
            This page comes from a plugin that isn’t running now. It may be off, or starting.
          </p>
          <Link to="/settings/plugins" className="text-sm font-bold text-primary">
            Manage plugins
          </Link>
        </div>
      );
    }
    return (
      <>
        <h1 className="text-[32px] leading-tight font-extrabold">{view.title}</h1>
        {/* Drawn afresh for each plugin page, so one failing says nothing of the next. */}
        <PluginView
          key={`${pluginId}:${viewId}`}
          pluginId={pluginId}
          name={nameOf(pluginId)}
          view={view.view}
          props={props}
        />
      </>
    );
  },
  'page.toolbar': ({ items, shown, nameOf }) => pageViews('page.toolbar', items, shown, nameOf),
  'page.header': ({ items, shown, nameOf }) =>
    items.length > 0 && (
      <div data-region="page.header" className="grid gap-3">
        {pageViews('page.header', items, shown, nameOf)}
      </div>
    ),
  'page.footer': ({ items, shown, nameOf }) =>
    items.length > 0 && (
      <div data-region="page.footer" className="grid gap-3">
        {pageViews('page.footer', items, shown, nameOf)}
      </div>
    ),
  // Beside the page where its card is wide enough, the contents over plugins' asides; where it
  // isn't, the asides go below the page and the contents are in its text.
  'page.aside': ({ items, shown, nameOf, contents }) =>
    items.length > 0 ? (
      <div
        data-region="page.aside"
        className="grid w-full content-start gap-4 @min-[960px]:sticky @min-[960px]:top-6 @min-[960px]:max-h-[calc(100svh-5rem-var(--titlebar-height))] @min-[960px]:w-52 @min-[960px]:shrink-0 @min-[960px]:self-start @min-[960px]:overflow-y-auto"
      >
        {contents && <TableOfContents {...contents} className="hidden @min-[960px]:grid" />}
        {pageViews('page.aside', items, shown, nameOf)}
      </div>
    ) : (
      contents && (
        <TableOfContents
          {...contents}
          className="sticky top-6 hidden max-h-[calc(100svh-5rem-var(--titlebar-height))] w-52 shrink-0 self-start overflow-y-auto @min-[960px]:grid"
        />
      )
    ),
  // The page's own panels are sheets of their own; a plugin's opens in a dialog. One shows at a time.
  'page.panel': ({ items, shown, open, onOpenChange, own, nameOf }) => {
    // A panel whose plugin stopped closes.
    const showing = items.find((panel) => panelKey(panel) === open);
    return (
      <>
        {own &&
          OWN_PANELS.map(({ id, Panel }) => (
            <Panel
              key={id}
              {...own}
              open={open === id}
              onOpenChange={(next) => onOpenChange(next ? id : null)}
            />
          ))}
        <Dialog open={Boolean(showing)} onOpenChange={(next) => !next && onOpenChange(null)}>
          {showing && (
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{showing.title}</DialogTitle>
                <DialogDescription>From {nameOf(showing.pluginId)}</DialogDescription>
              </DialogHeader>
              <PageView
                pluginId={showing.pluginId}
                viewId={`page.panel:${showing.id}`}
                name={nameOf(showing.pluginId)}
                view={showing.view}
                shown={shown}
              />
            </DialogContent>
          )}
        </Dialog>
      </>
    );
  },
  'settings.section': ({ items, pluginId, nameOf }) =>
    items
      .filter((section) => section.pluginId === pluginId)
      .map(({ id, title, view }) => (
        <section
          key={id}
          aria-label={title}
          className="grid gap-2 rounded-control bg-muted/50 p-3 text-sm"
        >
          <div>
            <h3 className="font-bold">{title}</h3>
            <p className="text-muted-foreground">From {nameOf(pluginId)}.</p>
          </div>
          <PluginView pluginId={pluginId} name={nameOf(pluginId)} view={view} props={NO_SETTINGS} />
        </section>
      )),
  // Each in a box that clicks rather than moves the window.
  'app.titlebar': ({ items, nameOf }) =>
    items.map(({ pluginId, id, view }) => (
      <div
        key={`${pluginId}:${id}`}
        className="flex h-7 max-w-40 items-center overflow-hidden [app-region:no-drag]"
      >
        <PluginView pluginId={pluginId} name={nameOf(pluginId)} view={view} props={NO_TITLEBAR} />
      </div>
    )),
};

const NO_SETTINGS: SettingsViewProps = {};
const NO_TITLEBAR: TitlebarViewProps = {};

/**
 * One of the places plugins draw into, with the app's own parts there.
 * Nothing shows where nothing is there, wrapper and all. Rail items,
 * plugin pages and titlebar buttons show only while the vault is open, as
 * app code runs only then; in safe mode nothing of a plugin's does.
 */
export function Place<R extends keyof Regions>(props: { name: R } & PlaceInputs[R]) {
  const { regions, plugins } = usePlugins();
  const draw = PLACES[props.name];
  return draw({
    ...props,
    items: regions[props.name],
    nameOf: (pluginId) => pluginName(plugins, pluginId),
  });
}

/** Each plugin's view in one of the page's places. */
const pageViews = (
  place: 'page.toolbar' | 'page.header' | 'page.footer' | 'page.aside',
  items: Contribution<typeof place>[],
  shown: ShownPage,
  nameOf: (pluginId: string) => string,
) =>
  items.map(({ pluginId, id, view }) => (
    <PageView
      key={`${pluginId}:${id}`}
      pluginId={pluginId}
      viewId={`${place}:${id}`}
      name={nameOf(pluginId)}
      view={view}
      shown={shown}
    />
  ));

/** One plugin's view of the page shown: drawn afresh only when the page or its version changes. */
function PageView({
  pluginId,
  viewId,
  name,
  view,
  shown,
}: {
  pluginId: string;
  /** The view's place and ID, such as `page.aside:<id>`. */
  viewId: string;
  name: string;
  view: View<PageViewProps>;
  shown: ShownPage;
}) {
  const props = usePluginRuntime().pageViewProps(pluginId, viewId, shown);
  if (!props) return null;
  return <PluginView pluginId={pluginId} name={name} view={view} props={props} />;
}

const railItem =
  'flex w-14 flex-col items-center gap-1 rounded-control py-1.5 text-[10px] font-bold text-subtle-foreground hover:tint active:tint-strong aria-[current=page]:hover:bg-none aria-[current=page]:active:bg-none';

/** A plugin's rail item, opening its plugin's page. */
function RailItem({
  item,
  onNavigate,
  open,
}: {
  item: Contribution<'rail'>;
} & PlaceInputs['rail']) {
  const { pluginId, title, icon, opens } = item;
  const face = (
    <>
      <span
        aria-hidden
        className="grid h-4 place-items-center overflow-hidden text-sm leading-none"
      >
        {icon ?? title.slice(0, 1)}
      </span>
      <span className="w-full truncate text-center">{title}</span>
    </>
  );
  if (open) {
    return (
      <button
        type="button"
        onClick={() => open(item)}
        data-hint={title}
        data-hint-side="right"
        data-plugin={pluginId}
        className={railItem}
      >
        {face}
      </button>
    );
  }
  return (
    <Link
      to="/plugin/$pluginId/$viewId"
      params={{ pluginId, viewId: opens }}
      onClick={onNavigate}
      data-hint={title}
      data-hint-side="right"
      data-plugin={pluginId}
      className={railItem}
      activeProps={{ className: 'text-primary-ink bg-primary-soft' }}
    >
      {face}
    </Link>
  );
}

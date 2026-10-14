import type { PageViewProps, View } from '@wikistow/plugin-sdk';
import { usePluginRuntime, usePlugins, type PluginsSnapshot, type ShownPage } from './runtime';
import { PluginView } from './views';

/** The places in a page that plugins draw into, beside the panel sheet. */
export type PagePlace = 'page.toolbar' | 'page.header' | 'page.footer' | 'page.aside';

/** A plugin's name, for what is said about it. */
export const pluginName = (plugins: PluginsSnapshot['plugins'], pluginId: string) =>
  plugins.find(({ plugin }) => plugin.manifest.id === pluginId)?.plugin.manifest.name ?? pluginId;

/**
 * Each running plugin's view in one of the page's places, in plugin order.
 * Nothing without any; the caller draws the place itself.
 */
export function PageViews({ place, shown }: { place: PagePlace; shown: ShownPage }) {
  const { regions, plugins } = usePlugins();
  return regions[place].map(({ pluginId, id, view }) => (
    <PageView
      key={`${pluginId}:${id}`}
      pluginId={pluginId}
      viewId={`${place}:${id}`}
      name={pluginName(plugins, pluginId)}
      view={view}
      shown={shown}
    />
  ));
}

/** One plugin's view of the page shown: drawn afresh only when the page or its version changes. */
export function PageView({
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

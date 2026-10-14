import { PageId, SpaceId } from '@wikistow/client';
import type { AppViewProps } from '@wikistow/plugin-sdk';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { pluginName } from '../../../../../plugins/regions';
import { usePlugins } from '../../../../../plugins/runtime';
import { PluginView } from '../../../../../plugins/views';

// `/plugin/…`, not `/plugins/…`: the desktop app serves plugins' files there.
export const Route = createFileRoute('/_app/_vault/plugin/$pluginId/$viewId')({
  component: PluginPage,
});

/**
 * A plugin's own page (`app.view`), opened from its rail item, in the main
 * area. While its plugin isn't running it says so, with the way to Settings.
 */
function PluginPage() {
  const { pluginId, viewId } = Route.useParams();
  const { regions, plugins } = usePlugins();
  const navigate = useNavigate();
  const view = regions['app.view'].find(
    (registered) => registered.pluginId === pluginId && registered.id === viewId,
  );
  const props = useMemo<AppViewProps>(
    () => ({
      openPage: (page) =>
        void navigate({
          to: '/s/$spaceId/p/$pageId',
          params: { spaceId: SpaceId.parse(page.spaceId), pageId: PageId.parse(page.pageId) },
        }),
    }),
    [navigate],
  );
  return (
    <section
      data-region="app.view"
      className="h-full min-h-0 overflow-y-auto rounded-card bg-card shadow-card"
    >
      <div className="mx-auto grid w-full max-w-[720px] gap-6 px-11 py-10 max-[899px]:px-[18px] max-[899px]:py-8">
        {view ? (
          <>
            <h1 className="text-[32px] leading-tight font-extrabold">{view.title}</h1>
            {/* Drawn afresh for each plugin page, so one failing says nothing of the next. */}
            <PluginView
              key={`${pluginId}:${viewId}`}
              pluginId={pluginId}
              name={pluginName(plugins, pluginId)}
              view={view.view}
              props={props}
            />
          </>
        ) : (
          <div className="grid gap-2">
            <h1 className="text-[32px] leading-tight font-extrabold">Not available</h1>
            <p className="text-sm text-muted-foreground">
              This page comes from a plugin that isn’t running now. It may be off, or starting.
            </p>
            <Link to="/settings" className="text-sm font-bold text-primary">
              Manage plugins
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}

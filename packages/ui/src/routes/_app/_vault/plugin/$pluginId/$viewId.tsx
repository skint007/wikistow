import { PageId, SpaceId } from '@wikistow/client';
import type { AppViewProps } from '@wikistow/plugin-sdk';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Place } from '../../../../../plugins/places';

// `/plugin/…`, not `/plugins/…`: plugins' files are served there (by the server, or by the desktop app).
export const Route = createFileRoute('/_app/_vault/plugin/$pluginId/$viewId')({
  component: PluginPage,
});

/**
 * A plugin's own page (`app.view`), opened from its rail item, in the main
 * area. While its plugin isn't running it says so, with the way to Settings.
 */
function PluginPage() {
  const { pluginId, viewId } = Route.useParams();
  const navigate = useNavigate();
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
        <Place name="app.view" pluginId={pluginId} viewId={viewId} props={props} />
      </div>
    </section>
  );
}

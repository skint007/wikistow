import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { desktop } from '../../../desktop';
import { LibrarySettings } from '../../../plugins/library-settings';
import {
  InstallFromFolder,
  PluginSettings,
  SafeModeNotice,
  type PluginsView,
} from '../../../plugins/plugin-settings';
import { usePlugins } from '../../../plugins/runtime';

const TABS = [
  { tab: undefined, label: 'Installed' },
  { tab: 'library', label: 'Library' },
] as const;

export const Route = createFileRoute('/_app/settings/plugins')({
  // The tab is in the address, so other places can link to Library. Installed has none.
  validateSearch: z.object({ tab: z.literal('library').optional().catch(undefined) }),
  component: PluginsPage,
});

/**
 * Plugins, a page of its own so Settings doesn't grow with them: the
 * install actions, the safe mode shortcut, then the Installed and Library
 * tabs, searched by name and description.
 */
function PluginsPage() {
  const { tab = 'installed' } = Route.useSearch();
  const { safeMode } = usePlugins();
  const [query, setQuery] = useState('');
  const view: PluginsView = { tab, query };
  const tabClass =
    'rounded-row px-3 py-1.5 text-sm font-bold text-subtle-foreground outline-offset-[-2px] hover:tint active:tint-strong aria-[current=page]:bg-primary-soft aria-[current=page]:text-primary-ink aria-[current=page]:hover:bg-none aria-[current=page]:active:bg-none';
  return (
    <div data-region="settings" className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-4xl content-start gap-3.5 pb-10">
        <Link
          to="/settings"
          hash="plugins"
          className="flex items-center gap-1.5 justify-self-start rounded-row px-1.5 py-1 text-sm font-bold text-subtle-foreground hover:tint active:tint-strong"
        >
          <ArrowLeft className="size-4" strokeWidth={1.75} />
          Back to Settings
        </Link>
        <div className="flex flex-wrap items-center gap-2 px-1.5">
          <h1 className="flex-1 text-[32px] leading-tight font-extrabold">Plugins</h1>
          {desktop && <InstallFromFolder />}
          {!safeMode && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/workshop">Build one with the assistant</Link>
            </Button>
          )}
        </div>
        <div className="grid gap-2 px-1.5 text-sm text-muted-foreground">
          <p>
            {desktop
              ? 'If one breaks the app, Ctrl+Shift+Alt+P restarts it without plugins.'
              : 'If one breaks the app, Ctrl+Shift+Alt+P, or ?safe-mode in the address, opens this tab without plugins.'}
          </p>
          <SafeModeNotice />
        </div>
        <div className="grid gap-4 rounded-card bg-card p-4 shadow-card">
          <div className="flex flex-wrap items-center gap-2">
            <nav aria-label="Plugins" className="flex gap-1">
              {TABS.map(({ tab: value, label }) => (
                <Link
                  key={label}
                  to="/settings/plugins"
                  search={{ tab: value }}
                  // Installed is active only on the page without a tab.
                  activeOptions={{ exact: true }}
                  className={tabClass}
                >
                  {label}
                </Link>
              ))}
            </nav>
            <Input
              type="search"
              aria-label="Search plugins"
              placeholder="Search plugins"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="ml-auto w-auto min-w-48 flex-1 rounded-row border-0 bg-muted sm:max-w-64"
            />
          </div>
          {desktop ? <PluginSettings {...view} /> : <LibrarySettings {...view} />}
        </div>
      </div>
    </div>
  );
}

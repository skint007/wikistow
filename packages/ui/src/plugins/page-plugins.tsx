import { Puzzle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { panelKey, pluginName, type OpenPanel } from './places';
import { pluginRuntime, usePluginRuntime, usePlugins, type ShownPage } from './runtime';
import { desktop } from '../desktop';
import { useNeedsConnection } from '../shell/availability';

/**
 * The page toolbar's plugin menu: each running plugin's commands, run on
 * the page shown, and its panels, which `onOpenPanel` opens in the page's
 * `page.panel` place. Nothing shows without any. It also tells plugins the
 * page was shown.
 */
export function PagePlugins({
  shown,
  onOpenPanel,
}: {
  shown: ShownPage;
  onOpenPanel: (panel: OpenPanel) => void;
}) {
  const runtime = usePluginRuntime();
  const { commands, regions, plugins } = usePlugins();
  const panels = regions['page.panel'];
  const [notice, setNotice] = useState<string | null>(null);
  const needs = useNeedsConnection();
  const { pageId, spaceId } = shown.page;
  const { version, revision } = shown;

  // While the draft is open here, the app's plugins change it through the editor.
  const editing = shown.draft !== null;
  const { ready, flush, saved, fits, revise } = shown.draft ?? {};
  useEffect(() => {
    if (!editing || !ready || !flush || !saved || !fits || !revise) return;
    return pluginRuntime.openDraft({ spaceId, pageId }, { ready, flush, saved, fits, revise });
    // The editor's functions are new each render; the editor behind them isn't.
  }, [editing, spaceId, pageId]);

  useEffect(() => {
    runtime.deliver({
      event: 'page.shown',
      payload: { page: { spaceId, pageId }, revision, version },
    });
  }, [runtime, spaceId, pageId, revision, version]);

  const nameOf = (pluginId: string) => pluginName(plugins, pluginId);

  if (commands.length === 0 && panels.length === 0) return null;
  // A browser's plugins load from the server; the desktop's run from disk (ADR 0009, decision 8).
  const select = (run: () => void) => (desktop ? { onSelect: run } : needs.select(run));
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Plugins">
            <Puzzle strokeWidth={1.75} /> <span className="max-[899px]:sr-only">Plugins</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label="Plugins">
          {panels.length > 0 && <DropdownMenuLabel>Panels</DropdownMenuLabel>}
          {panels.map((panel) => (
            <DropdownMenuItem
              key={`${panel.pluginId}:${panel.id}`}
              {...select(() => onOpenPanel(panelKey(panel)))}
            >
              {panel.title}
            </DropdownMenuItem>
          ))}
          {panels.length > 0 && commands.length > 0 && <DropdownMenuSeparator />}
          {commands.length > 0 && <DropdownMenuLabel>Commands</DropdownMenuLabel>}
          {commands.map((command) => (
            <DropdownMenuItem
              key={`${command.pluginId}:${command.id}`}
              {...select(() => {
                setNotice(null);
                runtime.runCommand(command.pluginId, command.id, shown).catch((error: unknown) => {
                  const message = error instanceof Error ? error.message : 'It failed';
                  setNotice(`${nameOf(command.pluginId)}: ${command.title} failed. ${message}`);
                });
              })}
            >
              {command.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {notice && (
        <p role="alert" className="basis-full text-sm text-destructive">
          {notice}{' '}
          <button type="button" className="underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
    </>
  );
}

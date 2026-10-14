import { Puzzle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageView, pluginName } from './regions';
import {
  pluginRuntime,
  usePluginRuntime,
  usePlugins,
  type PluginPanel,
  type ShownPage,
} from './runtime';

/**
 * The page toolbar's plugin menu: each running plugin's commands, run on
 * the page shown, and its panels, opened beside it. Nothing shows without
 * any. It also tells plugins the page was shown.
 */
export function PagePlugins({ shown }: { shown: ShownPage }) {
  const runtime = usePluginRuntime();
  const { commands, regions, plugins } = usePlugins();
  const panels = regions['page.panel'];
  const [open, setOpen] = useState<PluginPanel | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  // A panel whose plugin stopped closes.
  const showing =
    open && panels.find((panel) => panel.pluginId === open.pluginId && panel.id === open.id);

  if (commands.length === 0 && panels.length === 0) return null;
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
            <DropdownMenuItem key={`${panel.pluginId}:${panel.id}`} onSelect={() => setOpen(panel)}>
              {panel.title}
            </DropdownMenuItem>
          ))}
          {panels.length > 0 && commands.length > 0 && <DropdownMenuSeparator />}
          {commands.length > 0 && <DropdownMenuLabel>Commands</DropdownMenuLabel>}
          {commands.map((command) => (
            <DropdownMenuItem
              key={`${command.pluginId}:${command.id}`}
              onSelect={() => {
                setNotice(null);
                runtime.runCommand(command.pluginId, command.id, shown).catch((error: unknown) => {
                  const message = error instanceof Error ? error.message : 'It failed';
                  setNotice(`${nameOf(command.pluginId)}: ${command.title} failed. ${message}`);
                });
              }}
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
      <Dialog open={Boolean(showing)} onOpenChange={(next) => !next && setOpen(null)}>
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
}

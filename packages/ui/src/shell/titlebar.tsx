import type { DesktopBridge, WindowAction, WindowState } from '@wikistow/contracts';
import { Copy, Ellipsis, Minus, Square, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { desktop } from '../desktop';
import { TitlebarViews } from '../plugins/regions';

/**
 * The desktop window's titlebar (#74), over the top of every screen: the
 * window has no system frame. Its empty part moves the window, and
 * double-clicking it maximizes, as the system's would. It holds plugins'
 * buttons (`app.titlebar`), a menu for what the old menu bar did, and the
 * window's buttons. Nothing in a browser.
 */
export function Titlebar() {
  return desktop && <DesktopTitlebar desktop={desktop} />;
}

const BUTTON =
  'grid h-full w-11 place-items-center text-muted-foreground [app-region:no-drag] hover:tint hover:text-foreground active:tint-strong focus-visible:-outline-offset-2';

function DesktopTitlebar({ desktop }: { desktop: DesktopBridge }) {
  const state = useWindowState(desktop);
  const act = (action: WindowAction) => () => void desktop.windowAction(action);
  // Room for it at the top of the page (`--titlebar-height`, app.css).
  useLayoutEffect(() => {
    document.documentElement.dataset.titlebar = '';
    return () => void delete document.documentElement.dataset.titlebar;
  }, []);
  const restores = state.maximized || state.fullScreen;
  return (
    <div
      data-region="titlebar"
      role="group"
      aria-label="Window"
      className="fixed inset-x-0 top-0 z-40 flex h-(--titlebar-height) items-center bg-background select-none [app-region:drag]"
    >
      {/* Centred over the rail. A narrow window's top bar has the name already. */}
      <span
        aria-hidden
        className="w-[70px] text-center text-[13px] font-extrabold max-[899px]:invisible"
      >
        Wiki<span className="text-primary">Stow</span>
      </span>
      <div className="ml-auto flex h-full items-center gap-1 pr-1">
        <TitlebarViews />
      </div>
      <WindowMenu fullScreen={state.fullScreen} act={act} />
      <button type="button" aria-label="Minimize" onClick={act('minimize')} className={BUTTON}>
        <Minus className="size-4" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label={
          state.fullScreen ? 'Leave full screen' : state.maximized ? 'Restore' : 'Maximize'
        }
        onClick={act('toggle-maximize')}
        className={BUTTON}
      >
        {restores ? (
          <Copy className="size-3.5 -scale-x-100" strokeWidth={1.75} />
        ) : (
          <Square className="size-3.5" strokeWidth={1.75} />
        )}
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={act('close')}
        className={cn(BUTTON, 'hover:bg-destructive hover:text-destructive-foreground')}
      >
        <X className="size-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}

/** The old menu bar's View items, with the keys that still do them (apps/desktop/src/shortcuts.ts). */
function WindowMenu({
  fullScreen,
  act,
}: {
  fullScreen: boolean;
  act: (action: WindowAction) => () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Window menu" className={BUTTON}>
        <Ellipsis className="size-4" strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onSelect={act('reload')}>
          Reload <DropdownMenuShortcut>Ctrl+R</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={act('zoom-in')}>
          Zoom in <DropdownMenuShortcut>Ctrl+=</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={act('zoom-out')}>
          Zoom out <DropdownMenuShortcut>Ctrl+-</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={act('zoom-reset')}>
          Actual size <DropdownMenuShortcut>Ctrl+0</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={act('toggle-full-screen')}>
          {fullScreen ? 'Leave full screen' : 'Full screen'}
          <DropdownMenuShortcut>F11</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={act('toggle-developer-tools')}>
          Developer tools <DropdownMenuShortcut>Ctrl+Shift+I</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The window's maximized and full screen state, as main reports it. */
function useWindowState(desktop: DesktopBridge) {
  const [state, setState] = useState<WindowState>({ maximized: false, fullScreen: false });
  useEffect(() => {
    let live = true;
    const stop = desktop.onWindowState(setState);
    void desktop.windowState().then((now) => live && setState(now));
    return () => {
      live = false;
      stop();
    };
  }, [desktop]);
  return state;
}

import { screen, type BrowserWindow, type Rectangle } from 'electron';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** The size the window opens at when none was kept. */
const DEFAULT_SIZE = { width: 1280, height: 820 };
/** How long the window must stay as it is before its new place is written. */
const SAVE_MS = 500;

const Kept = z.object({
  bounds: z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  maximized: z.boolean(),
});

/** `bounds` moved, and shrunk if it must be, to lie inside `area`. */
export function fitInto(bounds: Rectangle, area: Rectangle): Rectangle {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  };
}

/**
 * Where the window was when last moved, resized or closed, kept in
 * `window.json` in `userData` (#72). It belongs to this device, whoever is
 * signed in and to whichever server.
 */
export function windowPlace(userData: string) {
  const file = join(userData, 'window.json');
  const next = `${file}.next`;
  return {
    /**
     * The kept size and position, fitted to the work area of the display it
     * is mostly on, and whether the window was maximized. The default size
     * when nothing (or nothing readable) was kept. Needs the app ready.
     */
    read() {
      try {
        const kept = Kept.parse(JSON.parse(readFileSync(file, 'utf8')));
        const { workArea } = screen.getDisplayMatching(kept.bounds);
        return { bounds: fitInto(kept.bounds, workArea), maximized: kept.maximized };
      } catch {
        return { bounds: DEFAULT_SIZE, maximized: false };
      }
    },
    /**
     * Keep `window`'s place as it changes and when it closes: its normal
     * bounds, so a maximized window restores to its last normal size, and
     * whether it is maximized. Call it before the window shows.
     */
    track(window: BrowserWindow) {
      // Followed here rather than read with `getNormalBounds()`, which on
      // Linux gives the maximized bounds once a launch opened the window
      // maximized. Until it settles, the bounds it was created with.
      let normal = window.getBounds();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Written synchronously, whole, then moved into place: the file is tiny,
      // and the write as the window closes must land before the app quits.
      const save = () => {
        clearTimeout(timer);
        if (window.isDestroyed()) return;
        const maximized = window.isMaximized();
        if (!maximized && !window.isMinimized() && !window.isFullScreen()) {
          normal = window.getBounds();
        }
        try {
          writeFileSync(next, JSON.stringify({ bounds: normal, maximized }));
          renameSync(next, file);
        } catch {
          // Not kept this time; the next change tries again.
        }
      };
      // Once it has settled: a window being maximized moves and resizes on the way.
      const saveSoon = () => {
        clearTimeout(timer);
        timer = setTimeout(save, SAVE_MS);
      };
      window.on('resize', saveSoon);
      window.on('move', saveSoon);
      window.on('maximize', saveSoon);
      window.on('unmaximize', saveSoon);
      window.on('close', save);
    },
  };
}

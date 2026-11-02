// The window's keyboard shortcuts. Main answers them before the page sees
// them, so they work however a plugin left the page. On Linux and Windows
// the app has no menu, so these are the keys Electron's default menu gave.
// On a Mac the menu bar shows them too (mac-menu.ts); answering them here
// first keeps the menu from doing them again.
import type { WindowAction } from '@wikistow/contracts';
import type { Input } from 'electron';

type Shortcut = WindowAction | 'quit';

/**
 * The default menu's keys the app keeps. Cut, copy, paste, undo and select
 * all need no menu on Linux: the page handles them. Named as
 * `Ctrl+Shift+<key>`, the key as typed.
 */
const SHORTCUTS = new Map<string, Shortcut>([
  ['Ctrl+R', 'reload'],
  ['Ctrl+Shift+R', 'reload'],
  ['F5', 'reload'],
  ['Ctrl+=', 'zoom-in'],
  ['Ctrl++', 'zoom-in'],
  ['Ctrl+Shift++', 'zoom-in'],
  ['Ctrl+-', 'zoom-out'],
  ['Ctrl+0', 'zoom-reset'],
  ['F11', 'toggle-full-screen'],
  ['Ctrl+Shift+I', 'toggle-developer-tools'],
  ['F12', 'toggle-developer-tools'],
  ['Ctrl+W', 'close'],
  ['Ctrl+Q', 'quit'],
]);

/**
 * The same on a Mac, with Cmd, and the Mac's own keys for full screen and
 * developer tools. Cut, copy, paste, undo and select all are the Edit
 * menu's, which a Mac needs for them to work in text fields. Named as
 * `Ctrl+Alt+Shift+Cmd+<key>`.
 */
const MAC_SHORTCUTS = new Map<string, Shortcut>([
  ['Cmd+R', 'reload'],
  ['Shift+Cmd+R', 'reload'],
  ['Cmd+=', 'zoom-in'],
  ['Cmd++', 'zoom-in'],
  ['Shift+Cmd++', 'zoom-in'],
  ['Cmd+-', 'zoom-out'],
  ['Cmd+0', 'zoom-reset'],
  ['Ctrl+Cmd+F', 'toggle-full-screen'],
  ['Alt+Cmd+I', 'toggle-developer-tools'],
  ['Cmd+W', 'close'],
  ['Cmd+Q', 'quit'],
]);

/** What a key pressed in the window does, if it is one of this system's shortcuts. */
export function shortcut(input: Input, platform = process.platform): Shortcut | null {
  if (input.type !== 'keyDown') return null;
  if (platform === 'darwin') {
    // Alt changes the character a letter types (Alt+I is `ˆ`), so with Alt
    // the key's place names it. Otherwise the character does, as the menu's do.
    const key =
      input.alt && /^Key[A-Z]$/.test(input.code)
        ? input.code.slice(3)
        : input.key.length === 1
          ? input.key.toUpperCase()
          : input.key;
    const name = [
      input.control && 'Ctrl',
      input.alt && 'Alt',
      input.shift && 'Shift',
      input.meta && 'Cmd',
      key,
    ];
    return MAC_SHORTCUTS.get(name.filter(Boolean).join('+')) ?? null;
  }
  if (input.alt || input.meta) return null;
  const key = input.key.length === 1 ? input.key.toUpperCase() : input.key;
  const name = [input.control && 'Ctrl', input.shift && 'Shift', key].filter(Boolean).join('+');
  return SHORTCUTS.get(name) ?? null;
}

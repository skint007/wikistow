// The window's keyboard shortcuts. The app has no menu, so main answers the
// keys Electron's default menu gave, before the page sees them.
import type { WindowAction } from '@wikistow/contracts';
import type { Input } from 'electron';

/**
 * The default menu's keys the app keeps. Cut, copy, paste, undo and select
 * all need no menu on Linux: the page handles them. Named as
 * `Ctrl+Shift+<key>`, the key as typed.
 */
const SHORTCUTS = new Map<string, WindowAction | 'quit'>([
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

/** What a key pressed in the window does, if it is one of `SHORTCUTS`. */
export function shortcut(input: Input): WindowAction | 'quit' | null {
  if (input.type !== 'keyDown' || input.alt || input.meta) return null;
  const key = input.key.length === 1 ? input.key.toUpperCase() : input.key;
  const name = [input.control && 'Ctrl', input.shift && 'Shift', key].filter(Boolean).join('+');
  return SHORTCUTS.get(name) ?? null;
}

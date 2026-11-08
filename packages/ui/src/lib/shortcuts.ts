import { isApple } from '../shell/search-model';

const APPLE = typeof navigator !== 'undefined' && isApple();

/** A ProseMirror key name as the person presses it: `⌘⌥7` on Apple systems, `Ctrl+Alt+7` elsewhere. */
export function shortcutLabel(key: string): string {
  const parts = key.split('-');
  const last = parts.pop()?.toUpperCase() ?? '';
  const names = APPLE
    ? { Mod: '⌘', Alt: '⌥', Shift: '⇧' }
    : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
  const mods = parts.map((part) => names[part as keyof typeof names] ?? part);
  return APPLE ? [...mods, last].join('') : [...mods, last].join('+');
}

/** A ProseMirror key name as `aria-keyshortcuts` writes it: `Control+Alt+7`, `Meta+Alt+7` on Apple systems. */
export function ariaShortcut(key: string): string {
  const parts = key.split('-');
  const last = parts.pop()?.toUpperCase() ?? '';
  const mods = parts.map((part) => (part === 'Mod' ? (APPLE ? 'Meta' : 'Control') : part));
  return [...mods, last].join('+');
}

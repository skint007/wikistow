import { useSyncExternalStore } from 'react';
import { z } from 'zod';

/*
 * Keyboard shortcuts for plugins' commands (#404), which the person gives
 * them in Settings → Plugins; a plugin can't choose one. They are kept on
 * this device, as a plugin theme and the palette's recent commands are:
 * which keys are free depends on where the app runs (the desktop app's
 * window keys, a browser's own, which never reach the page), so a key is
 * checked where it is used. A shortcut is named as ProseMirror names keys
 * (`Mod-Alt-s`), as the palette shows them (`PaletteEntry.keys`): `Mod` is
 * Cmd on Apple systems and Ctrl elsewhere, and `Ctrl` is Ctrl beside Cmd.
 */

/** The modifiers a shortcut's name holds, in the order it writes them. */
const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;

/**
 * The keys besides letters, digits and F1–F24 a shortcut can end with, by
 * their place on the keyboard (`KeyboardEvent.code`), which Shift doesn't
 * change. Not `-`, which a name couldn't hold.
 */
const PLACES: Readonly<Record<string, string>> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`',
  Equal: '=',
};

/**
 * `name` with its modifiers in `MODIFIERS`' order, as names are compared.
 * A capital letter, as CodeMirror writes `Alt-A`, is that letter with Shift.
 */
export function normalShortcut(name: string): string {
  const parts = name.split('-');
  let key = parts.pop() ?? '';
  const held = new Set(parts.map((part) => (part === 'Cmd' || part === 'Meta' ? 'Mod' : part)));
  if (/^[A-Z]$/.test(key)) {
    held.add('Shift');
    key = key.toLowerCase();
  }
  return [...MODIFIERS.filter((modifier) => held.has(modifier)), key].join('-');
}

/**
 * The shortcut a key press names, or null for a press no shortcut is: a
 * modifier alone, a key `PLACES` doesn't name, or with the Windows key. A
 * letter goes by the letter typed, as the app's own keys do (Ctrl+K is
 * search wherever K is), else by its place, as when Alt changes what a
 * Mac types; a digit and the rest go by their place.
 */
export function shortcutOf(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'code'> & {
    // Autofill sends keydown events with no key at all.
    key?: string | undefined;
    getModifierState?: (key: string) => boolean;
  },
  apple: boolean,
): string | null {
  if (!apple && event.metaKey) return null;
  // AltGr, which comes as Ctrl and Alt on Windows, types characters such as @.
  if (event.getModifierState?.('AltGraph')) return null;
  const { code } = event;
  const key =
    event.key !== undefined && /^[a-z]$/i.test(event.key)
      ? event.key.toLowerCase()
      : /^Key[A-Z]$/.test(code)
        ? code.slice(3).toLowerCase()
        : /^Digit[0-9]$/.test(code)
          ? code.slice(5)
          : /^F([1-9]|1[0-9]|2[0-4])$/.test(code)
            ? code
            : (PLACES[code] ?? null);
  if (key === null) return null;
  const held = {
    Mod: apple ? event.metaKey : event.ctrlKey,
    Ctrl: apple && event.ctrlKey,
    Alt: event.altKey,
    Shift: event.shiftKey,
  };
  return [...MODIFIERS.filter((modifier) => held[modifier]), key].join('-');
}

/**
 * The app's own keys, which no plugin's command may take, each with what
 * it does there. The editors' come from their keymaps (a test checks them),
 * the desktop app's from its window (`apps/desktop/src/shortcuts.ts`), and
 * a browser's are those it keeps for itself.
 */
export const APP_SHORTCUTS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({
    // The app's.
    'Mod-k': 'Search',
    'Mod-Shift-p': 'Command palette',
    F1: 'Command palette',
    'Mod-Alt-Shift-p': 'Safe mode',
    'Ctrl-Alt-Shift-p': 'Safe mode',
    'Mod-f': 'Find on page',
    // The visual editor's formats and headings (`formatting.ts`).
    'Mod-b': 'Bold',
    'Mod-i': 'Italic',
    'Mod-e': 'Code',
    'Mod-Alt-x': 'Strikethrough',
    'Mod-Shift-b': 'Quote',
    'Mod-Alt-c': 'Code block',
    'Mod-Alt-7': 'Numbered list',
    'Mod-Alt-8': 'Bulleted list',
    'Mod-Alt-9': 'Task list',
    'Mod-Alt-0': 'Text',
    'Mod-Alt-1': 'Heading 1',
    'Mod-Alt-2': 'Heading 2',
    'Mod-Alt-3': 'Heading 3',
    'Mod-Alt-4': 'Heading 4',
    'Mod-Alt-5': 'Heading 5',
    'Mod-Alt-6': 'Heading 6',
    // Editing, in both editors and every text box.
    'Mod-z': 'Undo',
    'Mod-y': 'Redo',
    'Mod-Shift-z': 'Redo',
    'Ctrl-Shift-z': 'Redo',
    'Mod-a': 'Select all',
    'Mod-c': 'Copy',
    'Mod-x': 'Cut',
    'Mod-v': 'Paste',
    'Mod-Shift-v': 'Paste as plain text',
    // The source editor's (CodeMirror's keymaps, `cursors.ts`).
    'Mod-d': 'Select the next match',
    'Mod-u': 'Undo the selection',
    'Mod-Shift-u': 'Redo the selection',
    'Alt-u': 'Redo the selection',
    'Mod-[': 'Indent less',
    'Mod-]': 'Indent more',
    'Mod-/': 'Comment',
    'Mod-Alt-\\': 'Indent',
    'Mod-Shift-k': 'Delete the line',
    'Mod-Shift-\\': 'Matching bracket',
    'Alt-l': 'Select the line',
    'Alt-Shift-a': 'Block comment',
    'Alt-Shift-m': 'Tab focus mode',
    'Alt-`': 'Completions',
    'Alt-i': 'Completions',
    'Ctrl-a': 'Line start',
    'Ctrl-Shift-a': 'Block comment',
    'Ctrl-b': 'Back a character',
    'Ctrl-d': 'Delete forward',
    'Ctrl-e': 'Line end',
    'Ctrl-f': 'Forward a character',
    'Ctrl-h': 'Delete back',
    'Ctrl-Alt-h': 'Delete a word back',
    'Ctrl-k': 'Delete to the line’s end',
    'Ctrl-l': 'Select the line',
    'Ctrl-m': 'Tab focus mode',
    'Ctrl-n': 'Next line',
    'Ctrl-o': 'Split the line',
    'Ctrl-p': 'Previous line',
    'Ctrl-t': 'Swap characters',
    'Ctrl-v': 'Page down',
    // The desktop app's window.
    'Mod-r': 'Reload',
    'Mod-Shift-r': 'Reload',
    F5: 'Reload',
    'Mod-=': 'Zoom in',
    'Mod-Shift-=': 'Zoom in',
    'Mod-0': 'Actual size',
    F11: 'Full screen',
    'Mod-Ctrl-f': 'Full screen',
    'Mod-Shift-i': 'Developer tools',
    'Mod-Alt-i': 'Developer tools',
    F12: 'Developer tools',
    'Mod-w': 'Close the window',
    'Mod-q': 'Quit',
    // A browser's, which never reach the page, and a Mac's.
    'Mod-t': 'New tab',
    'Mod-Shift-t': 'Reopen a tab',
    'Mod-n': 'New window',
    'Mod-Shift-n': 'New private window',
    'Mod-Shift-w': 'Close the window',
    'Mod-l': 'The address bar',
    'Mod-p': 'Print',
    'Mod-s': 'Save the page',
    'Mod-o': 'Open a file',
    'Mod-g': 'Find next',
    'Mod-Shift-g': 'Find previous',
    'Mod-h': 'Hide or history',
    'Mod-j': 'Downloads',
    'Mod-m': 'Minimize',
    'Mod-,': 'Preferences',
    'Mod-1': 'Tab 1',
    'Mod-2': 'Tab 2',
    'Mod-3': 'Tab 3',
    'Mod-4': 'Tab 4',
    'Mod-5': 'Tab 5',
    'Mod-6': 'Tab 6',
    'Mod-7': 'Tab 7',
    'Mod-8': 'Tab 8',
    'Mod-9': 'Last tab',
  }).map(([name, what]) => [normalShortcut(name), what]),
);

/** A command a shortcut runs: its plugin's ID, and its own. */
export type CommandKey = { pluginId: string; commandId: string };

const commandKey = ({ pluginId, commandId }: CommandKey) => `${pluginId}/${commandId}`;

/**
 * Why `name` can't be a shortcut for `command`, or null if it can. It needs
 * Mod, or a function key, so it never types text: Alt alone types
 * characters on a Mac (⌥S is ß), as AltGr does elsewhere. It mustn't be one
 * of the app's own (`APP_SHORTCUTS`) or another command's in `taken`, named
 * there with its title.
 */
export function shortcutProblem(
  name: string,
  command: CommandKey,
  taken: readonly (CommandKey & { title: string; keys: string })[],
  label: (name: string) => string,
): string | null {
  const normal = normalShortcut(name);
  const parts = normal.split('-');
  const key = parts.at(-1) ?? '';
  if (!/^F\d+$/.test(key) && !parts.includes('Mod')) {
    // As the person's system names it: Ctrl, or ⌘.
    const mod = label('Mod-x').replace(/\+?X$/, '');
    return `Hold ${mod} with a key, or use a function key, so it types no text.`;
  }
  const own = APP_SHORTCUTS[normal];
  if (own) return `${label(normal)} is the app’s own: ${own}.`;
  const other = taken.find(
    (each) => commandKey(each) !== commandKey(command) && normalShortcut(each.keys) === normal,
  );
  if (other) return `${label(normal)} already runs ${other.title}.`;
  return null;
}

const KEPT = 'wikistow.pluginShortcuts';
const Kept = z.record(z.string(), z.string().max(60)).catch({});

function readKept(): Readonly<Record<string, string>> {
  try {
    return Kept.parse(JSON.parse(localStorage.getItem(KEPT) ?? '{}'));
  } catch {
    return {};
  }
}

let kept = readKept();
const listeners = new Set<() => void>();

/** The shortcuts given to plugins' commands on this device, by `<pluginId>/<commandId>`. */
export const pluginShortcuts = {
  get: () => kept,
  /** The shortcut given to `command`, if any. */
  of: (command: CommandKey): string | null => kept[commandKey(command)] ?? null,
  /** Give `command` the shortcut `name`, or none for null. */
  set(command: CommandKey, name: string | null) {
    const { [commandKey(command)]: _was, ...rest } = kept;
    kept = name === null ? rest : { ...rest, [commandKey(command)]: normalShortcut(name) };
    try {
      localStorage.setItem(KEPT, JSON.stringify(kept));
    } catch {
      // Not kept past this run.
    }
    for (const listener of listeners) listener();
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

export const usePluginShortcuts = () =>
  useSyncExternalStore(pluginShortcuts.subscribe, pluginShortcuts.get);

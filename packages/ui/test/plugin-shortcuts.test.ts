import { completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { describe, expect, it } from 'vite-plus/test';
import { headingShortcut, SHORTCUTS } from '../src/page/editor/visual/formatting.ts';
import {
  APP_SHORTCUTS,
  normalShortcut,
  shortcutOf,
  shortcutProblem,
} from '../src/plugins/shortcuts.ts';

// Plugins' command shortcuts (#404) must never take a key the app or its
// editors use: a plugin's command would run, or the editor's, but not both,
// and which one depends on where the focus is.

/** Whether a plugin's shortcut could be `name`: a key it can end with, held with Mod or Alt. */
const nameable = (name: string) => {
  const parts = normalShortcut(name).split('-');
  const key = parts.at(-1) ?? '';
  return (
    /^([a-z0-9,./;'[\]\\`=]|F\d+)$/.test(key) &&
    (/^F\d+$/.test(key) || parts.includes('Mod') || parts.includes('Alt') || parts.includes('Ctrl'))
  );
};

describe('plugin shortcuts', () => {
  it('reserve every key the editors bind that a shortcut could be', () => {
    const editors = [
      ...Object.values(SHORTCUTS),
      ...[0, 1, 2, 3, 4, 5, 6].map(headingShortcut),
      'Mod-d',
      ...[...defaultKeymap, ...historyKeymap, ...completionKeymap].flatMap(({ key, mac }) => [
        ...(key ? [key] : []),
        ...(mac ? [mac] : []),
      ]),
    ];
    const free = editors
      .filter(nameable)
      .filter((name) => !(normalShortcut(name) in APP_SHORTCUTS));
    expect(free).toEqual([]);
  });

  it('name a key press by the letter typed, else by its place', () => {
    const press = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(
      shortcutOf({ ...press, ctrlKey: true, shiftKey: true, key: 'S', code: 'KeyS' }, false),
    ).toBe('Mod-Shift-s');
    // Alt changes what a Mac types: its place names it.
    expect(
      shortcutOf({ ...press, metaKey: true, altKey: true, key: 'ß', code: 'KeyS' }, true),
    ).toBe('Mod-Alt-s');
    expect(
      shortcutOf({ ...press, ctrlKey: true, shiftKey: true, key: '!', code: 'Digit1' }, false),
    ).toBe('Mod-Shift-1');
    expect(
      shortcutOf({ ...press, ctrlKey: true, key: 'Control', code: 'ControlLeft' }, false),
    ).toBeNull();
  });

  it('refuse the app’s keys, another command’s, and keys that type text', () => {
    const label = (name: string) => name;
    const mine = { pluginId: 'refactor', commandId: 'split' };
    const taken = [
      { pluginId: 'tools', commandId: 'stamp', title: 'Tools: Stamp', keys: 'Mod-Alt-s' },
    ];
    expect(shortcutProblem('Mod-k', mine, taken, label)).toContain('Search');
    expect(shortcutProblem('Alt-Mod-s', mine, taken, label)).toContain('Tools: Stamp');
    expect(shortcutProblem('Shift-s', mine, taken, label)).toContain('types no text');
    expect(
      shortcutProblem('Mod-Alt-s', { pluginId: 'tools', commandId: 'stamp' }, taken, label),
    ).toBeNull();
    expect(shortcutProblem('Mod-Shift-y', mine, taken, label)).toBeNull();
  });
});

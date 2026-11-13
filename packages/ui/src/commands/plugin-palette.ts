import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { desktop } from '../desktop';
import { pluginName } from '../plugins/places';
import { usePluginRuntime, usePlugins, type ShownPage } from '../plugins/runtime';
import { shortcutOf, usePluginShortcuts } from '../plugins/shortcuts';
import { isApple } from '../shell/search-model';
import { vaultStore } from '../vault/store';
import { NEEDS_CONNECTION, useNeedsConnection } from '../shell/availability';
import { requirementsHere } from './ui-commands';
import type { PaletteEntry } from './palette';

/**
 * The running plugins' commands, for the palette while `shown` is: each run
 * on it as the page toolbar's Plugins menu runs it, through the runtime,
 * with its time limit. `onNotice` hears what to say when one fails, and
 * null as each starts, as the menu clears its note. Each has the shortcut
 * the person gave it here (#404), which runs it too while `shown` is, from
 * anywhere in the page, the editors included, but not over a dialog: the
 * app's own keys and the editors' are never one (`APP_SHORTCUTS`).
 */
export function usePluginPaletteEntries(
  shown: ShownPage,
  onNotice: (message: string | null) => void,
): PaletteEntry[] {
  const runtime = usePluginRuntime();
  const { commands, plugins } = usePlugins();
  const { offline } = useNeedsConnection();
  const shortcuts = usePluginShortcuts();
  const satisfies = requirementsHere();
  const entries = commands.map((command): PaletteEntry => {
    const plugin = pluginName(plugins, command.pluginId);
    const keys = shortcuts[`${command.pluginId}/${command.id}`];
    return {
      command: { id: `plugin:${command.pluginId}:${command.id}`, requires: ['unlocked-vault'] },
      satisfies,
      title: command.title,
      ...(keys === undefined ? {} : { keys }),
      plugin,
      // A browser's plugins load from the server; the desktop's run from disk (ADR 0009, decision 8).
      waiting: offline && !desktop ? NEEDS_CONNECTION : null,
      run: () => {
        onNotice(null);
        void runtime.runCommand(command.pluginId, command.id, shown).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'It failed';
          onNotice(`${plugin}: ${command.title} failed. ${message}`);
        });
      },
    };
  });
  const latest = useRef(entries);
  useEffect(() => {
    latest.current = entries;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Left to whatever handled it first, such as an editor's own keys.
      if (event.defaultPrevented || event.repeat) return;
      const keys = shortcutOf(event, isApple());
      const entry = keys && latest.current.find((each) => each.keys === keys);
      if (!entry || vaultStore.get().status !== 'unlocked') return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      if (entry.waiting) onNotice(`${entry.plugin}: ${entry.title}. ${entry.waiting}`);
      else entry.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNotice]);
  return entries;
}

/**
 * A **_Plugin_ settings…** entry for each enabled plugin with settings,
 * declared or a section of its own, as the page's Plugins menu lists them,
 * anywhere in the app: it opens the plugin's settings, which need no page.
 */
export function usePluginSettingsEntries(): PaletteEntry[] {
  const navigate = useNavigate();
  const { plugins, regions, safeMode } = usePlugins();
  if (safeMode) return [];
  const sections = new Set(regions['settings.section'].map(({ pluginId }) => pluginId));
  const satisfies = requirementsHere();
  return plugins
    .map(({ plugin }) => plugin)
    .filter(
      ({ enabled, manifest }) =>
        enabled && ((manifest.settings?.length ?? 0) > 0 || sections.has(manifest.id)),
    )
    .map(({ manifest }) => ({
      command: { id: `plugin-settings:${manifest.id}`, requires: ['unlocked-vault'] },
      satisfies,
      title: `${manifest.name} settings…`,
      // Where `host.app.navigate({ kind: 'settings' })` and the Plugins menu go.
      run: () => void navigate({ to: '/settings/plugins', search: { plugin: manifest.id } }),
    }));
}

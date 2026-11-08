import { desktop } from '../desktop';
import { pluginName } from '../plugins/places';
import { usePluginRuntime, usePlugins, type ShownPage } from '../plugins/runtime';
import { NEEDS_CONNECTION, useNeedsConnection } from '../shell/availability';
import { requirementsHere } from './ui-commands';
import type { PaletteEntry } from './palette';

/**
 * The running plugins' commands, for the palette while `shown` is: each run
 * on it as the page toolbar's Plugins menu runs it, through the runtime,
 * with its time limit. `onNotice` hears what to say when one fails, and
 * null as each starts, as the menu clears its note.
 */
export function usePluginPaletteEntries(
  shown: ShownPage,
  onNotice: (message: string | null) => void,
): PaletteEntry[] {
  const runtime = usePluginRuntime();
  const { commands, plugins } = usePlugins();
  const { offline } = useNeedsConnection();
  const satisfies = requirementsHere();
  return commands.map((command) => {
    const plugin = pluginName(plugins, command.pluginId);
    return {
      command: { id: `plugin:${command.pluginId}:${command.id}`, requires: ['unlocked-vault'] },
      satisfies,
      title: command.title,
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
}

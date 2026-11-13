import { useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ariaShortcut, shortcutLabel } from '@/lib/shortcuts';
import { ScopePill, THIS_DEVICE } from '../settings/rows';
import { isApple } from '../shell/search-model';
import { pluginName } from './places';
import { usePlugins } from './runtime';
import {
  pluginShortcuts,
  shortcutOf,
  shortcutProblem,
  usePluginShortcuts,
  type CommandKey,
} from './shortcuts';

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS']);

/**
 * The shortcuts of a running plugin's commands, under its row in Settings
 * → Plugins (#404): each command with its keys, **Set** to press new ones
 * and **Clear**. Keys the app or another command already uses are refused,
 * saying whose they are. Kept on this device (`pluginShortcuts`). Nothing
 * shows while the plugin registers no command, as while it is off.
 */
export function CommandShortcuts({ pluginId }: { pluginId: string }) {
  const { commands, plugins } = usePlugins();
  const shortcuts = usePluginShortcuts();
  const [recording, setRecording] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ commandId: string; message: string } | null>(null);
  const own = commands.filter((command) => command.pluginId === pluginId);
  if (own.length === 0) return null;
  const name = pluginName(plugins, pluginId);
  // Every shortcut kept here, a plugin's that is off or not started yet too, so none is given twice.
  const taken = Object.entries(shortcuts).flatMap(([at, keys]) => {
    const slash = at.indexOf('/');
    const [pluginId, commandId] = [at.slice(0, slash), at.slice(slash + 1)];
    const running = commands.find((each) => each.pluginId === pluginId && each.id === commandId);
    const title = `${pluginName(plugins, pluginId)}: ${running?.title ?? commandId}`;
    return slash < 0 ? [] : [{ pluginId, commandId, title, keys }];
  });

  const pressed = (command: CommandKey, event: KeyboardEvent<HTMLButtonElement>) => {
    if (MODIFIER_KEYS.has(event.key)) return;
    // Not the app's own key, nor a plugin's, while it is pressed here.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      setRecording(null);
      return;
    }
    const keys = shortcutOf(event.nativeEvent, isApple());
    const message = keys
      ? shortcutProblem(keys, command, taken, shortcutLabel)
      : 'That key can’t be a shortcut. Use a letter, a digit, punctuation or F1–F24.';
    if (message || !keys) {
      setProblem({ commandId: command.commandId, message: message ?? '' });
      return;
    }
    pluginShortcuts.set(command, keys);
    setProblem(null);
    setRecording(null);
  };

  return (
    <section aria-label={`${name} shortcuts`} className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Shortcuts</h3>
        <ScopePill>{THIS_DEVICE}</ScopePill>
      </div>
      <ul className="grid gap-1.5">
        {own.map((command) => {
          const key: CommandKey = { pluginId, commandId: command.id };
          const keys = shortcuts[`${pluginId}/${command.id}`];
          const listening = recording === command.id;
          return (
            <li key={command.id} className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1">{command.title}</span>
                {listening ? (
                  <Button
                    size="sm"
                    variant="outline"
                    // Focused at once, to hear the keys pressed next.
                    autoFocus
                    aria-label={`Press the keys for ${command.title}, or Escape`}
                    onKeyDown={(event) => pressed(key, event)}
                    onBlur={() => setRecording(null)}
                  >
                    Press keys…
                  </Button>
                ) : (
                  <>
                    {keys === undefined ? (
                      <span className="text-muted-foreground">None</span>
                    ) : (
                      <kbd
                        aria-keyshortcuts={ariaShortcut(keys)}
                        className="rounded-control border border-border px-1.5 font-mono text-xs"
                      >
                        {shortcutLabel(keys)}
                      </kbd>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Set a shortcut for ${command.title}`}
                      onClick={() => {
                        setProblem(null);
                        setRecording(command.id);
                      }}
                    >
                      Set
                    </Button>
                    {keys !== undefined && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Clear the shortcut for ${command.title}`}
                        onClick={() => pluginShortcuts.set(key, null)}
                      >
                        Clear
                      </Button>
                    )}
                  </>
                )}
              </div>
              {problem?.commandId === command.id && (
                <p role="alert" className="text-sm text-destructive">
                  {problem.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

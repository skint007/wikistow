import { accountRoutes } from '@wikistow/contracts';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { runCommand } from '../commands/command';
import {
  requirementsHere,
  setPluginTheme,
  setTheme as setThemeCommand,
} from '../commands/ui-commands';
import { usePlugins, type PluginThemeOption } from '../plugins/runtime';
import { pluginTheme, usePluginTheme } from './plugin-theme';
import { THEME_LABELS, useTheme } from './theme';

const env = { satisfies: requirementsHere() };

/**
 * The built-in palettes, synced to the account, and in the desktop app the
 * themes enabled plugins add, kept on this computer. A plugin theme can be
 * previewed first; a built-in choice, or "Use … here", leaves it.
 */
export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const { themes } = usePlugins();
  const { chosen, preview } = usePluginTheme();
  const isChosen = (option: PluginThemeOption) =>
    chosen?.pluginId === option.pluginId && chosen.themeId === option.id;
  // The plugin theme shown here when nothing is previewed; with its plugin off, the palette is.
  const using = themes.find(isChosen) ?? null;
  // Null for a theme no enabled plugin lists, such as one whose plugin was just turned off.
  const previewing = preview && (themes.find((option) => option.href === preview.href) ?? null);
  const choose = (option: PluginThemeOption | null) =>
    void runCommand(
      setPluginTheme,
      {
        theme: option && {
          pluginId: option.pluginId,
          themeId: option.id,
          base: option.base,
          href: option.href,
        },
      },
      env,
    );
  // Leaving Settings ends a preview started here; the workshop's goes on.
  useEffect(
    () => () => {
      if (pluginTheme.get().preview?.by === 'settings') pluginTheme.preview(null);
    },
    [],
  );

  return (
    <div className="grid gap-4">
      <div role="group" aria-label="Theme" className="flex flex-wrap gap-2">
        {accountRoutes.THEMES.map((choice) => {
          const on = !using && choice === theme;
          return (
            <Button
              key={choice}
              variant={on ? 'default' : 'outline'}
              aria-pressed={on}
              onClick={() =>
                void runCommand(setThemeCommand, { theme: choice }, { ...env, setTheme })
              }
            >
              {THEME_LABELS[choice]}
            </Button>
          );
        })}
      </div>
      {themes.length > 0 && (
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">
            From plugins, on this computer only. Your account keeps its theme everywhere else.
          </p>
          <ul aria-label="Plugin themes" className="grid gap-2">
            {themes.map((option) => {
              const on = using === option;
              return (
                <li
                  key={`${option.pluginId}:${option.id}`}
                  className="flex flex-wrap items-center gap-2"
                >
                  <Button
                    variant={on ? 'default' : 'outline'}
                    aria-pressed={on}
                    onClick={() => choose(option)}
                  >
                    {option.name}
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {option.base === 'dark' ? 'Dark' : 'Light'}, from {option.pluginName}
                  </span>
                  {!on && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Preview ${option.name}`}
                      onClick={() => pluginTheme.preview({ base: option.base, href: option.href })}
                    >
                      Preview
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {preview && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-control bg-muted p-3 text-sm"
        >
          <span className="flex-1">
            Previewing {previewing?.name ?? 'a theme'}. Nothing changes until you use it.
          </span>
          {previewing && (
            <Button size="sm" onClick={() => choose(previewing)}>
              Use {previewing.name}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => pluginTheme.preview(null)}>
            Stop preview
          </Button>
        </div>
      )}
      {using && !preview && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="flex-1 text-muted-foreground">
            {using.name} is on here. Your account’s theme is {THEME_LABELS[theme]}.
          </span>
          <Button size="sm" variant="outline" onClick={() => choose(null)}>
            Use {THEME_LABELS[theme]} here
          </Button>
        </div>
      )}
    </div>
  );
}

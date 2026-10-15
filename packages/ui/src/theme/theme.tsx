import { accountRoutes } from '@wikistow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, meQuery } from '../api';
import { desktop } from '../desktop';
import { usePlugins } from '../plugins/runtime';
import { pluginTheme, usePluginTheme, type ThemeStyle } from './plugin-theme';

const STORAGE_KEY = 'wikistow.theme';
const CHOICES = accountRoutes.THEMES;
export type Theme = (typeof CHOICES)[number];
type Palette = Exclude<Theme, 'system'>;

const isTheme = (value: unknown): value is Theme => CHOICES.some((theme) => theme === value);

function stored(): Theme {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');
// "System" follows the operating system, using Light or Midnight slate.
const resolve = (theme: Theme): Palette =>
  theme === 'system' ? (darkQuery().matches ? 'slate' : 'light') : theme;
// The built-in palette a plugin theme is drawn over.
const BASES: Record<ThemeStyle['base'], Palette> = { light: 'light', dark: 'slate' };

type ThemeContext = { theme: Theme; setTheme: (theme: Theme) => void };
const Context = createContext<ThemeContext | null>(null);

/**
 * Applies the palette to `<html data-theme>`. The browser remembers the last
 * choice for the boot script; the account's setting wins once it loads, and
 * changes are saved to the account. On top of that, a plugin theme chosen on
 * this device (or one previewed) adds its stylesheet over its base palette,
 * while its plugin is enabled (see `plugin-theme.ts`).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setLocal] = useState<Theme>(stored);
  const { data: me } = useQuery(meQuery);
  const queryClient = useQueryClient();
  const { chosen, launch, preview } = usePluginTheme();
  const { themes, listed } = usePlugins();
  const available =
    chosen &&
    themes.find((option) => option.pluginId === chosen.pluginId && option.id === chosen.themeId);
  // At launch, until the desktop app lists its plugins: as it was last shown.
  // A browser draws no plugin's styles until the vault is open and lists them.
  const chosenStyle = listed ? (available ?? null) : desktop ? launch : null;
  const style = preview ?? chosenStyle;
  const availableBase = available?.base ?? null;
  const availableHref = available?.href ?? null;
  useEffect(() => {
    if (!listed) return;
    pluginTheme.listed(
      availableBase && availableHref ? { base: availableBase, href: availableHref } : null,
    );
  }, [listed, availableBase, availableHref]);
  const base = style?.base ?? null;
  const href = style?.href ?? null;

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not fatal: the next load falls back to the system theme.
    }
  }, [theme]);

  useEffect(() => {
    // After the app's own styles, so its tokens win.
    let link: HTMLLinkElement | null = null;
    if (href) {
      link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset['pluginTheme'] = '';
      document.head.append(link);
    }
    const apply = () =>
      document.documentElement.setAttribute('data-theme', base ? BASES[base] : resolve(theme));
    apply();
    const media = !base && theme === 'system' ? darkQuery() : null;
    media?.addEventListener('change', apply);
    return () => {
      link?.remove();
      media?.removeEventListener('change', apply);
    };
  }, [theme, base, href]);

  const accountTheme = me?.account.theme;
  useEffect(() => {
    if (accountTheme) setLocal(accountTheme);
  }, [accountTheme]);

  const setTheme = useCallback(
    (next: Theme) => {
      setLocal(next);
      // Choosing a built-in palette here leaves a plugin theme.
      pluginTheme.choose(null);
      if (!me) return;
      void api.call(accountRoutes.setTheme, { body: { theme: next } }).then(
        () => queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
        () => {
          // The palette still applies locally; the account keeps its old choice.
        },
      );
    },
    [me, queryClient],
  );

  return <Context value={{ theme, setTheme }}>{children}</Context>;
}

export function useTheme(): ThemeContext {
  const context = use(Context);
  if (!context) throw new Error('useTheme outside ThemeProvider');
  return context;
}

export const THEME_LABELS: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  slate: 'Midnight slate',
  warm: 'Warm charcoal',
  oled: 'OLED black',
};

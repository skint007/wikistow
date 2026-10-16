import { useSyncExternalStore } from 'react';
import { z } from 'zod';

const STORAGE_KEY = 'wikistow.pluginTheme';

/**
 * A theme as the app draws it: a stylesheet from the app's own origin over a
 * built-in palette, Light for a light base and Midnight slate for a dark one.
 */
export const ThemeStyle = z.object({ base: z.enum(['light', 'dark']), href: z.string() });
export type ThemeStyle = z.infer<typeof ThemeStyle>;

/**
 * A plugin's theme, by the plugin's ID and the theme's own, with how it is
 * drawn, to draw it at launch before the plugins are listed.
 */
export const ChosenTheme = ThemeStyle.extend({ pluginId: z.string(), themeId: z.string() });
export type ChosenTheme = z.infer<typeof ChosenTheme>;

/** As kept: also whether it was shown when the plugins were last listed (its plugin enabled). */
const Kept = ChosenTheme.extend({ shown: z.boolean() });
type Kept = z.infer<typeof Kept>;

type State = {
  /** The plugin theme chosen on this device, shown while its plugin is enabled. */
  chosen: ChosenTheme | null;
  /** What to draw at launch until the plugins are listed: the chosen theme, if shown last time. */
  launch: ThemeStyle | null;
  /** A theme shown for now, over everything else, and never kept, with who shows it. */
  preview: (ThemeStyle & { by: PreviewBy }) | null;
};

/** Who shows a preview: Settings' theme picker, or the plugin workshop (#257). */
export type PreviewBy = 'settings' | 'workshop';

function stored(): Kept | null {
  try {
    const parsed = Kept.safeParse(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function keep(theme: Kept | null) {
  try {
    if (theme) localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not kept past this run; it still applies now.
  }
}

/**
 * Which plugin theme this device (a computer or a browser) shows. A plugin
 * theme ranks above the account's built-in choice, which every other device
 * keeps showing, and a preview ranks above both. `ThemeProvider` applies it.
 */
function createPluginTheme() {
  const kept = stored();
  let state: State = { chosen: kept, launch: kept?.shown ? kept : null, preview: null };
  const listeners = new Set<() => void>();
  const set = (next: Partial<State>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  return {
    /**
     * Show a plugin's theme on this device from now on, or with null go back
     * to the account's palette. Ends any preview.
     */
    choose(theme: ChosenTheme | null) {
      keep(theme && { ...theme, shown: true });
      set({ chosen: theme, preview: null });
    },
    /**
     * How the chosen theme shows now the plugins are listed, or null while its
     * plugin is off: kept for the next launch, a new version's stylesheet too.
     */
    listed(style: ThemeStyle | null) {
      const { chosen } = state;
      if (chosen) keep({ ...chosen, ...style, shown: style !== null });
    },
    /**
     * Show `style` until `preview(null)` or a choice, keeping nothing. Any
     * stylesheet the app serves works, such as a staged version of a theme
     * that isn't installed yet. `by` says who shows it, so each ends only
     * its own.
     */
    preview(style: ThemeStyle | null, by: PreviewBy = 'settings') {
      set({ preview: style && { ...style, by } });
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => state,
  };
}

export const pluginTheme = createPluginTheme();

export const usePluginTheme = () => useSyncExternalStore(pluginTheme.subscribe, pluginTheme.get);

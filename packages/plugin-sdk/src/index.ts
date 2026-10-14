/*
 * @wikistow/plugin-sdk: what a WikiStow plugin is written against. A
 * plugin's `ui.ts` default-exports `definePlugin(...)`; its `script.ts`
 * calls `defineScript(...)`. The build (`wikistow-plugin build`) bundles
 * each into one file. See docs/adr/0001-desktop-plugin-runtime.md.
 */
import type { AppHost } from './host.ts';

export * from './host.ts';
export type { Manifest, PageAccess, TrustLevel } from './manifest.ts';
export { defineScript } from './script.ts';
export * from './theme.ts';

/** An app plugin: interface code that runs in the app's page, with the app's trust. */
export type AppPlugin = {
  /** Register what the plugin adds. Everything registered goes when it unloads. */
  activate(host: AppHost): void | Promise<void>;
  /** Undo anything `activate` did beyond registering, such as timers. */
  deactivate?(): void;
};

/** `ui.ts`'s default export. */
export const definePlugin = (plugin: AppPlugin): AppPlugin => plugin;

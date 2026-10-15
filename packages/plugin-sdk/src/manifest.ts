import { z } from 'zod';
import { PLUGIN_API } from './host.ts';

export { PLUGIN_API };

/** The manifest's file name, at the top of a built plugin folder. */
export const MANIFEST_FILE = 'wikistow-plugin.json';

/**
 * A plugin's ID: it names its data (`plugin.<id>`), its commands and its
 * blocks, and its folder in the desktop app's data.
 */
export const PluginId = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'Use 2–40 of a–z, 0–9 and -');

/**
 * A file in the built folder, by its path from the top, with no way out of
 * it: names of letters, digits, `_`, `.` and `-`, none of them `.` or `..`,
 * joined by single slashes. They need no escaping in a URL.
 */
export const PluginFile = z
  .string()
  .regex(
    /^(?!(?:.*\/)?\.\.?(?:\/|$))[\w.-]+(?:\/[\w.-]+)*$/,
    'A path inside the plugin folder, of letters, digits, _ . - and /',
  );

/** How much of a person's pages a plugin may be given. */
export const PageAccess = z.enum(['none', 'read', 'write']);
export type PageAccess = z.infer<typeof PageAccess>;

/** A theme a plugin adds to the theme picker, drawn over a built-in palette. */
export const PluginTheme = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().min(1).max(60),
  base: z.enum(['light', 'dark']),
  stylesheet: PluginFile,
});

/** `wikistow-plugin.json`: what a plugin is and what it contains. */
export const Manifest = z.strictObject({
  id: PluginId,
  name: z.string().min(1).max(60),
  version: z.string().min(1).max(40),
  api: z.literal(PLUGIN_API),
  description: z.string().max(400).optional(),
  /** Interface code, run in the app's page: an app plugin. */
  ui: PluginFile.optional(),
  /** Code run in a worker of its own, which reaches pages only through the host. */
  script: PluginFile.optional(),
  /** Stylesheets loaded while the plugin is enabled. */
  styles: z.array(PluginFile).max(20).default([]),
  themes: z.array(PluginTheme).max(20).default([]),
  /** The most page access the person may give it. */
  access: PageAccess.default('none'),
  /** The fenced block types it claims, written `plugin:<id>/<block>`. */
  blocks: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/))
    .max(20)
    .default([]),
});
export type Manifest = z.infer<typeof Manifest>;

/**
 * How far a person trusts a plugin by installing it, from what it holds:
 * styles only; code in an isolated worker; or code in the app's own page.
 */
export type TrustLevel = 'theme' | 'script' | 'app';

export const trustLevel = (manifest: Pick<Manifest, 'ui' | 'script'>): TrustLevel =>
  manifest.ui ? 'app' : manifest.script ? 'script' : 'theme';

const RANKS = { none: 0, read: 1, write: 2, theme: 0, script: 1, app: 2 } as const;

/** Whether `next` asks for more than `approved`: more page access, or a higher trust level. */
export const asksMore = (
  approved: { access: PageAccess; level: TrustLevel },
  next: { access: PageAccess; level: TrustLevel },
) => RANKS[next.access] > RANKS[approved.access] || RANKS[next.level] > RANKS[approved.level];

/** The lesser of two page accesses. */
export const leastAccess = (a: PageAccess, b: PageAccess): PageAccess =>
  RANKS[a] <= RANKS[b] ? a : b;

/** Every file the manifest names, which the folder must hold. */
export const manifestFiles = (manifest: Manifest): string[] => [
  ...(manifest.ui ? [manifest.ui] : []),
  ...(manifest.script ? [manifest.script] : []),
  ...manifest.styles,
  ...manifest.themes.map((theme) => theme.stylesheet),
];

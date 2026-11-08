import { z } from 'zod';
import { PLUGIN_API, SETTINGS_LIMIT, type Json, type Settings } from './host.ts';

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

const SettingCommon = {
  /** Its key in the plugin's settings. */
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
  label: z.string().min(1).max(100),
  /** A line under the label, saying what it does. */
  description: z.string().max(400).optional(),
};

/** A setting the host draws in the plugin's row in Settings → Plugins, and checks values against. */
export const SettingField = z.discriminatedUnion('type', [
  z.strictObject({
    ...SettingCommon,
    type: z.literal('text'),
    default: z.string().max(1000).optional(),
  }),
  z.strictObject({
    ...SettingCommon,
    type: z.literal('number'),
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.strictObject({ ...SettingCommon, type: z.literal('boolean'), default: z.boolean().optional() }),
  z.strictObject({
    ...SettingCommon,
    type: z.literal('choice'),
    options: z
      .array(
        z.strictObject({ value: z.string().min(1).max(100), label: z.string().min(1).max(100) }),
      )
      .min(1)
      .max(50),
    default: z.string().max(100).optional(),
  }),
]);
export type SettingField = z.infer<typeof SettingField>;

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
  /**
   * The inline code types it claims, written `` `plugin:<id>/<type> <text>` ``
   * (ADR 0011, decision 7). Left out, not defaulted: released apps read
   * manifests strictly, and would refuse one with a key they don't know.
   */
  inline: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/))
    .max(20)
    .optional(),
  /**
   * The regions it draws in place of the app's own part, with
   * `host.ui.replace` (ADR 0011), which the approval dialog names. Names
   * this app doesn't know are kept and never drawn, so a plugin built for
   * a newer app still loads. Left out, not defaulted, as `inline` is.
   */
  replaces: z
    .array(z.string().regex(/^[a-z][a-z0-9.-]{0,39}$/))
    .max(20)
    .optional(),
  /**
   * The settings the host draws for it in Settings → Plugins (#310), each
   * key once, each default a value its field takes. Left out, not
   * defaulted, as `inline` is.
   */
  settings: z
    .array(SettingField)
    .max(30)
    .refine(
      (fields) => new Set(fields.map(({ key }) => key)).size === fields.length,
      'Each setting needs a key of its own',
    )
    .refine(
      (fields) =>
        fields.every((field) => field.default === undefined || settingFits(field, field.default)),
      'A setting’s default must be a value it takes',
    )
    .optional(),
});
export type Manifest = z.infer<typeof Manifest>;

/** A plugin's settings as stored: any JSON object. */
export const SettingsValue = z.record(z.string().max(100), z.json());

/** Whether `value` is one `field` takes. */
export function settingFits(field: SettingField, value: Json): boolean {
  switch (field.type) {
    case 'text':
      return typeof value === 'string';
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (field.min === undefined || value >= field.min) &&
        (field.max === undefined || value <= field.max)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'choice':
      return field.options.some((option) => option.value === value);
  }
}

/**
 * The settings a plugin reads: what is stored, with each declared field's
 * default where its value is missing or no longer fits it (after an update
 * changed the field, say).
 */
export function settingsWithDefaults(
  fields: readonly SettingField[] | undefined,
  stored: Settings,
): Settings {
  const read: Settings = { ...stored };
  for (const field of fields ?? []) {
    const value = read[field.key];
    if (value !== undefined && settingFits(field, value)) continue;
    if (field.default === undefined) delete read[field.key];
    else read[field.key] = field.default;
  }
  return read;
}

/** The first declared field `settings` holds a value for that it doesn't take, if any. */
export const misfit = (fields: readonly SettingField[] | undefined, settings: Settings) =>
  (fields ?? []).find((field) => {
    const value = settings[field.key];
    return value !== undefined && !settingFits(field, value);
  });

/** Whether `settings` fit in `SETTINGS_LIMIT`. */
export const settingsFit = (settings: Settings) =>
  new TextEncoder().encode(JSON.stringify(settings)).byteLength <= SETTINGS_LIMIT;

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

// A page's banner, emoji, image icon and icon from the icon set, kept in
// the `wikistow.cover` payload extension so they belong to the version like
// any other edit. An
// image banner or icon names one of the page's own attachments by ID; its
// key stays in the attachment list, so publishing re-encrypts it with the
// rest (section 5.5).
import { z } from 'zod';
import { AttachmentId } from './ids.ts';
import { SymbolName } from './metadata.ts';
import type { PagePayload } from './payload.ts';

export const COVER_NAMESPACE = 'wikistow.cover';

/** The preset gradients, as named in the theme's `--banner-*` variables. */
export const BANNER_PRESETS = ['sunrise', 'ocean', 'meadow', 'lavender', 'dusk', 'stone'] as const;
export type BannerPreset = (typeof BANNER_PRESETS)[number];

/**
 * A test for one fully-qualified emoji as Unicode recommends it: a
 * pictograph, a flag, a keycap, a skin tone or tag sequence, or a ZWJ
 * sequence. Anything with marks stacked after it fails, so a page's emoji
 * stays inside its badge. The pattern needs the `v` flag, so it is built on
 * first use: a browser without it (Safari before 17) refuses every emoji
 * rather than failing to load.
 */
export function emojiTest(
  make: (source: string, flags: string) => RegExp = RegExp,
): (text: string) => boolean {
  let pattern: RegExp | null | undefined;
  return (text) => {
    if (pattern === undefined) {
      try {
        pattern = make('^\\p{RGI_Emoji}$', 'v');
      } catch {
        pattern = null;
      }
    }
    return pattern?.test(text) ?? false;
  };
}

/** Whether `text` is one emoji. */
export const isEmoji = emojiTest();

export const PageEmoji = z.string().refine(isEmoji, 'Choose a single emoji');

export const Banner = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('theme') }),
  z.looseObject({ kind: z.literal('preset'), name: z.enum(BANNER_PRESETS) }),
  z.looseObject({
    kind: z.literal('image'),
    attachmentId: AttachmentId,
    /** The vertical focal point, 0 (top) to 100 (bottom). */
    focal: z.number().int().min(0).max(100),
    /** The band's height, 0 (the usual band, when missing) to 100 (three times as tall). */
    height: z.number().int().min(0).max(100).optional(),
    /** How far the bottom edge fades into the page, 0 (none, when missing) to 100 (the whole band). */
    fade: z.number().int().min(0).max(100).optional(),
  }),
]);
export type Banner = z.infer<typeof Banner>;

/** An image shown in place of the emoji: one of the page's attachments, resized to fit 144 px. */
export const CoverIcon = z.looseObject({ attachmentId: AttachmentId });
export type CoverIcon = z.infer<typeof CoverIcon>;

/** An icon from the icon set shown in place of the emoji, by name (`SymbolName`). */
export const CoverSymbol = z.looseObject({ name: SymbolName });
export type CoverSymbol = z.infer<typeof CoverSymbol>;

/** The extension as written. Loose, so fields a newer client adds survive an edit here. */
export const Cover = z.looseObject({
  format: z.literal(1),
  emoji: PageEmoji.optional(),
  banner: Banner.optional(),
  icon: CoverIcon.optional(),
  symbol: CoverSymbol.optional(),
});
export type Cover = z.infer<typeof Cover>;

/**
 * The cover as shown: the theme gradient, and no emoji, image or icon,
 * unless the version says otherwise. The emoji stays beside an image or
 * icon, for older apps and an image that doesn't load. The app checks
 * its icon set has `symbol`'s name. Where an older app added an image
 * beside an icon, the image, chosen later, shows.
 */
export type ShownCover = {
  emoji: string | null;
  banner: Banner;
  icon: CoverIcon | null;
  symbol: CoverSymbol | null;
};

const THEME: Banner = { kind: 'theme' };

/**
 * The cover a version shows. Each part falls back on its own: an emoji this
 * app doesn't accept is left out, a banner of a kind it doesn't know, or an
 * image the version doesn't list, shows the theme gradient, and an image
 * icon the version doesn't list, or an icon name that isn't one, is none.
 */
export function coverOf(payload: Pick<PagePayload, 'extensions' | 'attachments'>): ShownCover {
  const raw = z
    .looseObject({
      format: z.literal(1),
      emoji: z.unknown().optional(),
      banner: z.unknown().optional(),
      icon: z.unknown().optional(),
      symbol: z.unknown().optional(),
    })
    .safeParse(payload.extensions[COVER_NAMESPACE]);
  if (!raw.success) return { emoji: null, banner: THEME, icon: null, symbol: null };
  const listed = (id: string) => payload.attachments.some((ref) => ref.id === id);
  const emoji = PageEmoji.safeParse(raw.data.emoji);
  const banner = Banner.safeParse(raw.data.banner);
  const icon = CoverIcon.safeParse(raw.data.icon);
  const symbol = CoverSymbol.safeParse(raw.data.symbol);
  return {
    emoji: emoji.success ? emoji.data : null,
    banner:
      banner.success && (banner.data.kind !== 'image' || listed(banner.data.attachmentId))
        ? banner.data
        : THEME,
    icon: icon.success && listed(icon.data.attachmentId) ? icon.data : null,
    symbol: symbol.success ? symbol.data : null,
  };
}

/** A banner this app writes. */
export type BannerChoice =
  | { kind: 'theme' }
  | { kind: 'preset'; name: BannerPreset }
  | { kind: 'image'; attachmentId: AttachmentId; focal: number; height?: number; fade?: number };

type Json = PagePayload['extensions'][string];
type JsonObject = { [key: string]: Json };

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a writer changes in a cover: null removes that part. */
export type CoverChanges = {
  emoji?: string | null;
  banner?: BannerChoice | null;
  icon?: { attachmentId: AttachmentId } | null;
  symbol?: { name: string } | null;
};

/**
 * The extension namespace with `changes` applied over what the version had,
 * fields this app doesn't know included: pass it as `extensions` to
 * `revisePayload`. Throws on an emoji, banner, image or icon that isn't valid;
 * what was there before is kept as it was.
 */
export function reviseCover(
  extensions: PagePayload['extensions'],
  changes: CoverChanges,
): { [COVER_NAMESPACE]: Json } {
  if (changes.emoji) PageEmoji.parse(changes.emoji);
  if (changes.banner) Banner.parse(changes.banner);
  if (changes.icon) CoverIcon.parse(changes.icon);
  if (changes.symbol) CoverSymbol.parse(changes.symbol);
  // Spread the original rather than Zod's copy, which would drop a key named "__proto__".
  const old = extensions[COVER_NAMESPACE];
  const kept = isObject(old) && old['format'] === 1 ? old : {};
  const next: JsonObject = { ...kept, format: 1 };
  for (const key of ['emoji', 'banner', 'icon', 'symbol'] as const) {
    const value = changes[key];
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return { [COVER_NAMESPACE]: next };
}

/** The attachment an image banner shows, if the cover has one. */
export const bannerAttachment = (cover: ShownCover) =>
  cover.banner.kind === 'image' ? cover.banner.attachmentId : null;

/**
 * The cover changes a copy needs when it keeps only the attachments in
 * `kept`: a banner or icon as written, accepted here or not, that names
 * another attachment would be left behind, so the copy shows the theme
 * gradient, or no icon, instead. Empty when the copy keeps them all.
 */
export function coverLeftBehind(
  extensions: PagePayload['extensions'],
  kept: ReadonlySet<string>,
): CoverChanges {
  const cover = extensions[COVER_NAMESPACE];
  const behind = (part: Json | undefined) => {
    if (!isObject(part) || !('attachmentId' in part)) return false;
    const id = part['attachmentId'];
    return typeof id !== 'string' || !kept.has(id);
  };
  if (!isObject(cover)) return {};
  return {
    ...(behind(cover['banner']) && { banner: { kind: 'theme' } }),
    ...(behind(cover['icon']) && { icon: null }),
  };
}

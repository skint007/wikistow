// A page's banner and emoji, kept in the `wikistow.cover` payload extension
// so they belong to the version like any other edit. An image banner names
// one of the page's own attachments by ID; its key stays in the attachment
// list, so publishing re-encrypts it with the rest (section 5.5).
import { z } from 'zod';
import { AttachmentId } from './ids.ts';
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
  }),
]);
export type Banner = z.infer<typeof Banner>;

/** The extension as written. Loose, so fields a newer client adds survive an edit here. */
export const Cover = z.looseObject({
  format: z.literal(1),
  emoji: PageEmoji.optional(),
  banner: Banner.optional(),
});
export type Cover = z.infer<typeof Cover>;

/** The cover as shown: the theme gradient and no emoji unless the version says otherwise. */
export type ShownCover = { emoji: string | null; banner: Banner };

const THEME: Banner = { kind: 'theme' };

/**
 * The cover a version shows. Each part falls back on its own: an emoji this
 * app doesn't accept is left out, and a banner of a kind it doesn't know,
 * or an image the version doesn't list, shows the theme gradient.
 */
export function coverOf(payload: Pick<PagePayload, 'extensions' | 'attachments'>): ShownCover {
  const raw = z
    .looseObject({
      format: z.literal(1),
      emoji: z.unknown().optional(),
      banner: z.unknown().optional(),
    })
    .safeParse(payload.extensions[COVER_NAMESPACE]);
  if (!raw.success) return { emoji: null, banner: THEME };
  const emoji = PageEmoji.safeParse(raw.data.emoji);
  const banner = Banner.safeParse(raw.data.banner);
  const listed =
    banner.success &&
    (banner.data.kind !== 'image' ||
      payload.attachments.some((ref) => ref.id === banner.data.attachmentId));
  return {
    emoji: emoji.success ? emoji.data : null,
    banner: banner.success && listed ? banner.data : THEME,
  };
}

/** A banner this app writes. */
export type BannerChoice =
  | { kind: 'theme' }
  | { kind: 'preset'; name: BannerPreset }
  | { kind: 'image'; attachmentId: AttachmentId; focal: number };

type Json = PagePayload['extensions'][string];
type JsonObject = { [key: string]: Json };

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The extension namespace with `changes` applied over what the version had,
 * fields this app doesn't know included: pass it as `extensions` to
 * `revisePayload`. Null removes the emoji or banner. Throws on an emoji or
 * banner that isn't valid; what was there before is kept as it was.
 */
export function reviseCover(
  extensions: PagePayload['extensions'],
  changes: { emoji?: string | null; banner?: BannerChoice | null },
): { [COVER_NAMESPACE]: Json } {
  if (changes.emoji) PageEmoji.parse(changes.emoji);
  if (changes.banner) Banner.parse(changes.banner);
  // Spread the original rather than Zod's copy, which would drop a key named "__proto__".
  const old = extensions[COVER_NAMESPACE];
  const kept = isObject(old) && old['format'] === 1 ? old : {};
  const next: JsonObject = { ...kept, format: 1 };
  for (const key of ['emoji', 'banner'] as const) {
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
 * Whether the banner as written, accepted here or not, names an attachment
 * other than those in `kept`: a copy that leaves its image behind.
 */
export function bannerLeftBehind(
  extensions: PagePayload['extensions'],
  kept: ReadonlySet<string>,
): boolean {
  const cover = extensions[COVER_NAMESPACE];
  const banner = isObject(cover) ? cover['banner'] : undefined;
  if (!isObject(banner) || !('attachmentId' in banner)) return false;
  const id = banner['attachmentId'];
  return typeof id !== 'string' || !kept.has(id);
}

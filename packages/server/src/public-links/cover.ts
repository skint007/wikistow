// A public page's cover (ADR 0005, decision 7): the banner and badge its
// published version shows, as the app shows them (`coverOf`, `PageBadge`).
// What a copy is staged with is checked here, and what fails shows as the
// app shows it: the theme's gradient, or the next kind of badge.
import { BANNER_PRESETS, isEmoji, SymbolName } from '@wikistow/client';
import type { publicLinkRoutes } from '@wikistow/contracts';
import { icons } from 'lucide';
import { z } from 'zod';
import { RASTER_TYPES } from './segments.ts';

/** A copy's cover as stored: only what a public page can show. */
export const PublicCover = z.strictObject({
  emoji: z.string().nullable(),
  symbol: z.string().nullable(),
  banner: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('theme') }),
    z.strictObject({ kind: z.literal('preset'), name: z.enum(BANNER_PRESETS) }),
    z.strictObject({
      kind: z.literal('image'),
      attachmentId: z.string(),
      focal: z.number().int().min(0).max(100),
      height: z.number().int().min(0).max(100).optional(),
      fade: z.number().int().min(0).max(100).optional(),
    }),
  ]),
  icon: z.string().nullable(),
});
export type PublicCover = z.infer<typeof PublicCover>;

/** A page with no cover: the theme's gradient, and no badge. */
export const NO_COVER: PublicCover = {
  emoji: null,
  symbol: null,
  banner: { kind: 'theme' },
  icon: null,
};

/**
 * The cover a copy is staged with, as a public page can show it: an emoji
 * that is one, an icon the icon set has, a preset there is, and images
 * only of the copy's attachments that show inline (`RASTER_TYPES`).
 */
export function acceptCover(
  cover: publicLinkRoutes.CopyCover | undefined,
  attachments: readonly { id: string; mediaType: string }[],
): PublicCover {
  if (!cover) return NO_COVER;
  const raster = new Set(attachments.flatMap((a) => (RASTER_TYPES.has(a.mediaType) ? [a.id] : [])));
  const image = (id: string | undefined) => (id !== undefined && raster.has(id) ? id : null);
  const { banner } = cover;
  const preset = BANNER_PRESETS.find((name) => name === banner?.name);
  const bannerImage = image(banner?.attachmentId);
  return {
    emoji: cover.emoji !== undefined && isEmoji(cover.emoji) ? cover.emoji : null,
    symbol: cover.symbol !== undefined && symbolNode(cover.symbol) ? cover.symbol : null,
    banner:
      banner?.kind === 'preset' && preset
        ? { kind: 'preset', name: preset }
        : banner?.kind === 'image' && bannerImage && banner.focal !== undefined
          ? {
              kind: 'image',
              attachmentId: bannerImage,
              focal: banner.focal,
              ...(banner.height !== undefined && { height: banner.height }),
              ...(banner.fade !== undefined && { fade: banner.fade }),
            }
          : { kind: 'theme' },
    icon: image(cover.icon),
  };
}

/** The attachments a cover shows: its banner image, then its image. */
export const coverFiles = (cover: PublicCover) => [
  ...(cover.banner.kind === 'image' ? [cover.banner.attachmentId] : []),
  ...(cover.icon ? [cover.icon] : []),
];

type IconNode = [tag: string, attrs: Record<string, string | number | undefined>][];

/** `square-terminal` as the icon set's exports name it: `SquareTerminal`. */
const exportName = (name: string) =>
  name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

/**
 * The drawing of the icon `name` names in the icon set (Lucide, the version
 * the app's `lucide-react` is), or null for a name it hasn't.
 */
export function symbolNode(name: string): IconNode | null {
  if (!SymbolName.safeParse(name).success) return null;
  const key = exportName(name);
  const set: Record<string, IconNode> = icons;
  return Object.hasOwn(set, key) ? (set[key] ?? null) : null;
}

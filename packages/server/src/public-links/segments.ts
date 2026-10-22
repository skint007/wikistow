import { z } from 'zod';

/**
 * A link to another public page in a rendering (ADR 0005, decision 6): the
 * key its target row is found by, the text it shows, as written, and the
 * heading it goes to, if any.
 */
export const Gap = z.strictObject({
  key: z.string(),
  text: z.string(),
  hash: z.string().optional(),
});
export type Gap = z.infer<typeof Gap>;

/** A stored rendering: sanitized HTML, with a gap between each part. */
export const Segment = z.union([z.string(), Gap]);
export type Segment = z.infer<typeof Segment>;

/**
 * The version of the server's reader. Bump it whenever rendering changes
 * (a fix to the sanitizing, say): copies rendered by another version are
 * rendered again after the server starts, and say they are being updated
 * until then.
 */
export const READER_VERSION = 1;

/** The key of a gap for a link to a page's address (`/s/<space>/p/<page>`): no wikilink's key has a `#`. */
export const pageKey = (pageId: string) => `#page:${pageId}`;

/** The page a gap's key names by address, or null for a wikilink's. */
export const pageOfKey = (key: string) => (key.startsWith('#page:') ? key.slice(6) : null);

/** Images a public page shows inline, and serves as themselves. Any other file is a download. */
export const RASTER_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

// Public links (ADR 0005): a readable copy of a page's published version,
// which the server renders and serves at `/p/<id>`. Every route here is
// for people only, never agents.
import { z } from 'zod';
import { AttachmentId, PageId, RevisionId, SpaceId } from '../records/ids.ts';
import type { RouteDef } from '../route.ts';
import { MAX_ATTACHMENTS, MAX_MARKDOWN_BYTES } from './pages.ts';

/** A link's id: 16 random bytes in base64url, new each time the link is turned on. */
export const LinkId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}$/)
  .brand<'PublicLinkId'>();
export type LinkId = z.infer<typeof LinkId>;

/** A copy, staged or live. The server makes its ID. */
export const CopyId = z.uuid().brand<'PublicCopyId'>();
export type CopyId = z.infer<typeof CopyId>;

/** A copy's file is at most this, or the server's upload limit if that is lower. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** A copy's files together are at most this. Past it, the rest are left out. */
export const MAX_COPY_BYTES = 100 * 1024 * 1024;

/** The longest wikilink target key a copy may name (`targets`). */
export const MAX_TARGET_KEY = 4096;

const PageParams = z.object({ pageId: PageId });

/**
 * Turn the page's link on, with a new id, or answer the one it has. For a
 * person who can publish the page, which must be published.
 */
export const turnOn = {
  method: 'POST',
  path: '/api/pages/:pageId/public-link',
  params: PageParams,
  response: z.strictObject({ id: LinkId }),
} as const satisfies RouteDef;

/** Turn the page's link off, deleting every copy of it. No error if it is off already. */
export const turnOff = {
  method: 'DELETE',
  path: '/api/pages/:pageId/public-link',
  params: PageParams,
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * A copy's cover as its published version shows it (`coverOf`): its emoji,
 * the name of its icon from the icon set, its banner, and the image shown
 * in place of the emoji. A banner image or the image names one of the
 * copy's `attachments`. Loose, so a newer app's kind of banner reaches an
 * older server: the server shows what it accepts of a cover, as the app
 * does, and the theme's gradient, or no badge, for the rest.
 */
export const CopyCover = z.object({
  emoji: z.string().max(64).optional(),
  symbol: z.string().max(64).optional(),
  banner: z
    .object({
      kind: z.string().max(32),
      name: z.string().max(64).optional(),
      attachmentId: AttachmentId.optional(),
      focal: z.number().int().min(0).max(100).optional(),
    })
    .optional(),
  icon: AttachmentId.optional(),
});
export type CopyCover = z.infer<typeof CopyCover>;

/**
 * Stage a copy of the page's published version `revisionId`, which must be
 * its published head, while its link is on: its title, its Markdown without
 * the frontmatter, its `cover`, the attachments the cover and body show or
 * link to, and its wikilinks' targets (`linkKey` → page) that name, by
 * published title alone, a page whose link is on. The server renders it and
 * answers which of the attachments it needs (`files`), each to upload at
 * `FILE_UPLOAD_PATH`, before `commit` makes the copy live.
 */
export const stage = {
  method: 'POST',
  path: '/api/pages/:pageId/public-copies',
  params: PageParams,
  body: z.object({
    revisionId: RevisionId,
    title: z.string().max(10_000),
    markdown: z
      .string()
      .max(MAX_MARKDOWN_BYTES)
      .refine((text) => new TextEncoder().encode(text).length <= MAX_MARKDOWN_BYTES, {
        message: 'Too long',
      }),
    attachments: z
      .array(
        z.object({
          id: AttachmentId,
          name: z.string().max(1024),
          mediaType: z.string().max(255),
          size: z.number().int().nonnegative(),
        }),
      )
      .max(MAX_ATTACHMENTS),
    targets: z.array(z.object({ key: z.string().max(MAX_TARGET_KEY), pageId: PageId })).max(10_000),
    cover: CopyCover.optional(),
  }),
  response: z.strictObject({ copyId: CopyId, files: z.array(AttachmentId) }),
  status: 201,
} as const satisfies RouteDef;

/**
 * One file of a staged copy, as raw bytes, at most the size its staging
 * declared: only by whoever staged it, while they can publish the page.
 */
export const FILE_UPLOAD_PATH = '/api/public-copies/:copyId/files/:attachmentId';
export const FileParams = z.object({ copyId: CopyId, attachmentId: AttachmentId });
export const FileUploadResult = z.strictObject({ ok: z.literal(true) });

/**
 * Make a staged copy live, once every file it needs has arrived, deleting
 * the page's other copies. Every check of `stage` runs again.
 */
export const commit = {
  method: 'POST',
  path: '/api/public-copies/:copyId/live',
  params: z.object({ copyId: CopyId }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * A page of the space with a link on, as the caller sees it: the link's id
 * only if they can publish the page, and whether a copy is live, so the
 * app can say the public page is out of date.
 */
export const ListedLink = z.strictObject({
  pageId: PageId,
  id: LinkId.nullable(),
  live: z.boolean(),
});
export type ListedLink = z.infer<typeof ListedLink>;

/** The space's pages with a link on that the caller can see (`ListedLink`). */
export const list = {
  method: 'GET',
  path: '/api/spaces/:spaceId/public-links',
  params: z.object({ spaceId: SpaceId }),
  response: z.strictObject({ links: z.array(ListedLink) }),
} as const satisfies RouteDef;

/** Where a public page is served, and its files. Not under `/api`: no session, no app. */
export const PAGE_PATH = '/p/:id';
export const PAGE_FILE_PATH = '/p/:id/files/:attachmentId';

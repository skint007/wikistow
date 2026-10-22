// Public links (ADR 0005): the routes that turn a page's link on and off
// and upload its copy, for people only, and the public pages themselves,
// for anyone with a link, with no session.
import { publicLinkRoutes } from '@wikistow/contracts';
import {
  commitCopy,
  fileLimit,
  FILE_CSP,
  listLinks,
  notFoundHtml,
  openPublicFile,
  openPublicPage,
  PAGE_CSP,
  publicFilePart,
  RASTER_TYPES,
  publicPageHtml,
  stageCopy,
  turnOffLink,
  turnOnLink,
  updatingPageHtml,
  uploadCopyFile,
  type Database,
  type Renderer,
} from '@wikistow/server';
import type { Context } from 'hono';
import type { Config } from '../config.ts';
import { ApiError } from '../http/errors.ts';
import type { AppEnv } from '../http/env.ts';
import type { Routes } from '../http/mount.ts';
import { toApiError } from './content.ts';

// Turning a link on or off, and committing a copy, as a person clicks.
const WRITE_LIMIT = { windowSeconds: 60, max: 60 };
// Staging renders the page on the server: 20 a minute per person.
const STAGE_LIMIT = { windowSeconds: 60, max: 20 };
// Every file of a copy, for a few copies a minute.
const FILE_UPLOAD_LIMIT = { windowSeconds: 60, max: 400 };
const LIST_LIMIT = { windowSeconds: 60, max: 120 };
// A public page, opened a few times a minute from one place.
const PAGE_LIMIT = { windowSeconds: 60, max: 120 };
// High enough for a page full of images, opened a few times.
const PAGE_FILE_LIMIT = { windowSeconds: 60, max: 600 };
// A staged body is at most 256 KiB of Markdown, which JSON can write longer.
const STAGE_BODY = 2 * 1024 * 1024;
// Files are read from the database a part at a time, as the client takes them.
const FILE_PART = 256 * 1024;

/** Headers on every public page and file: never cached, never indexed. */
const PRIVATE = { 'cache-control': 'no-store' };

/** A public page's headers: its own policy, and noindex. */
const PAGE_HEADERS = {
  ...PRIVATE,
  'content-security-policy': PAGE_CSP,
  'x-robots-tag': 'noindex, nofollow',
};

const notFound = (c: Context<AppEnv>) => c.html(notFoundHtml(), 404, PAGE_HEADERS);

export function mountPublicLinkRoutes(
  routes: Routes,
  { db, renderer, limits }: { db: Database; renderer: Renderer; limits: Config['limits'] },
) {
  routes.account(
    publicLinkRoutes.turnOn,
    async ({ params }, { principal }) =>
      turnOnLink(db, principal.accountId, params.pageId).catch(toApiError),
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(
    publicLinkRoutes.turnOff,
    async ({ params }, { principal }) => {
      await turnOffLink(db, principal.accountId, params.pageId).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(
    publicLinkRoutes.stage,
    async ({ params, body }, { principal }) =>
      stageCopy(db, renderer, {
        accountId: principal.accountId,
        pageId: params.pageId,
        uploadBytes: limits.uploadBytes,
        ...body,
      }).catch(toApiError),
    { rateLimit: STAGE_LIMIT, bodyLimit: STAGE_BODY },
  );

  // Only the person who staged a copy adds to it: the account comes from
  // the session, and the copy must be theirs.
  routes.upload(
    publicLinkRoutes.FILE_UPLOAD_PATH,
    fileLimit(limits.uploadBytes),
    async (bytes, { c, principal }) => {
      const params = publicLinkRoutes.FileParams.safeParse(c.req.param());
      if (!params.success) throw new ApiError('not-found', 'Not found');
      await uploadCopyFile(db, {
        accountId: principal.accountId,
        ...params.data,
        bytes,
        storageBytes: limits.storageBytes,
      }).catch(toApiError);
      return c.json(publicLinkRoutes.FileUploadResult.parse({ ok: true }));
    },
    { rateLimit: FILE_UPLOAD_LIMIT },
  );

  routes.account(
    publicLinkRoutes.commit,
    async ({ params }, { principal }) => {
      await commitCopy(db, principal.accountId, params.copyId).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(
    publicLinkRoutes.list,
    async ({ params }, { principal }) => ({
      links: await listLinks(db, principal.accountId, params.spaceId).catch(toApiError),
    }),
    { rateLimit: LIST_LIMIT },
  );

  // The public pages: no session, and the app's `Referrer-Policy:
  // no-referrer` stays, so the id doesn't reach the sites a page links to.
  routes.publicFile(
    publicLinkRoutes.PAGE_PATH,
    async (c) => {
      const page = await openPublicPage(db, c.req.param('id') ?? '');
      if (page.kind === 'not-found') return notFound(c);
      const html =
        page.kind === 'page' ? publicPageHtml(page.title, page.body) : updatingPageHtml();
      return c.html(html, 200, PAGE_HEADERS);
    },
    { rateLimit: PAGE_LIMIT },
  );

  routes.publicFile(
    publicLinkRoutes.PAGE_FILE_PATH,
    async (c) => {
      const attachmentId = c.req.param('attachmentId') ?? '';
      const file = await openPublicFile(db, c.req.param('id') ?? '', attachmentId);
      if (!file) return notFound(c);
      // Only a raster image shows as itself; anything else, SVG and HTML
      // included, is a download, so it can't run as a page here.
      const inline = RASTER_TYPES.has(file.mediaType);
      const headers = {
        ...PRIVATE,
        'content-type': inline ? file.mediaType : 'application/octet-stream',
        'content-length': String(file.size),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'content-security-policy': FILE_CSP,
        'x-robots-tag': 'noindex',
      };
      // Hono answers HEAD with the GET handler, dropping any body unread.
      if (c.req.method === 'HEAD' || file.size === 0) return c.body(null, 200, headers);
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const part = await publicFilePart(db, { ...file, attachmentId }, offset, FILE_PART);
          if (!part?.byteLength) {
            controller.error(new Error('The file went while it was being sent'));
            return;
          }
          controller.enqueue(part);
          offset += part.byteLength;
          if (offset >= file.size) controller.close();
        },
      });
      return c.body(body, 200, headers);
    },
    { rateLimit: PAGE_FILE_LIMIT },
  );
}

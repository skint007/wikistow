// Importing notes in batches (wikistow.md, Import; #399): many folders and
// pages made, saved and published in one request, each with every check its
// own route makes.
import { z } from 'zod';
import { FolderId, PageId, RevisionId } from '../records/ids.ts';
import type { RouteDef } from '../route.ts';
import { Commit, createPage, publish } from './pages.ts';
import { createFolder } from './structure.ts';

/** The most pages one batch carries. */
export const MAX_BATCH_PAGES = 10;

/** The most folders one batch carries. A folder's name is a small record. */
export const MAX_BATCH_FOLDERS = 100;

/**
 * Bytes one batch may carry. Each page is at most three versions, a draft
 * made, saved over and published, some 2.1 MB at the largest, so one always
 * fits.
 */
export const MAX_BATCH_BODY = 8 * 1024 * 1024;

/** How much an app puts in one batch before starting the next, but always one page. */
export const BATCH_BYTES = 4 * 1024 * 1024;

/**
 * One page of a batch: `create` makes it with its first draft, as
 * `createPage` does; `draft` saves a draft on top of its draft head, the one
 * `create` just made or one already there, as `saveDraft` does, never a
 * restore; and `publish` publishes the draft head then, as `publish` does.
 * At least one of them.
 */
export const BatchPage = z
  .object({
    pageId: PageId,
    create: createPage.body.omit({ pageId: true }).nullable(),
    draft: z.object(Commit).nullable(),
    publish: publish.body.nullable(),
  })
  .refine((page) => page.create !== null || page.draft !== null || page.publish !== null, {
    message: 'A page in a batch makes, saves or publishes something',
  });

/**
 * Make folders, then make, save and publish pages, all in one space, as
 * one change: everything lands, or nothing does. Each folder and each step
 * of each page is checked as its own route checks it, in the order sent, so
 * a folder comes before what goes in it, and a page's create before its
 * save before its publish. The first refusal, as that route would refuse
 * it, answers for the batch. A page listed twice is `invalid-request`. It
 * counts once against the write rate limit, and takes an
 * `Idempotency-Key`. Servers older than it answer `not-found`; they don't
 * say `importBatches` in `installation`.
 */
export const batch = {
  method: 'POST',
  path: '/api/spaces/:spaceId/import',
  params: createFolder.params,
  body: z.object({
    folders: z.array(createFolder.body).max(MAX_BATCH_FOLDERS),
    pages: z.array(BatchPage).max(MAX_BATCH_PAGES),
  }),
  response: z.strictObject({
    folders: z.array(FolderId),
    pages: z.array(
      z.strictObject({
        pageId: PageId,
        draftHead: RevisionId,
        publishedHead: RevisionId.nullable(),
      }),
    ),
  }),
} as const satisfies RouteDef;

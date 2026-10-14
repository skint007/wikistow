// Publishing chosen versions of a page into a page in another space
// (protocol section 13).
import { z } from 'zod';
import { FolderId, PageId, RevisionId, SpaceId } from '../records/ids.ts';
import type { RouteDef } from '../route.ts';
import { Commit, CommitResult } from './pages.ts';

/**
 * A source page's live publication in one other space, as its publisher
 * needs it: `pending`, a destination page made but whose first version
 * never arrived, and the folder it is in; `live`, a page with versions the
 * caller can publish at; or `blocked`, one they can't publish at, which
 * they may end (`end`) but are told nothing else of.
 */
export const Publication = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('pending'), pageId: PageId, parentId: FolderId.nullable() }),
  z.strictObject({ state: z.literal('live'), pageId: PageId }),
  z.strictObject({ state: z.literal('blocked') }),
]);

/**
 * The page's live publication in `spaceId`, or null, for someone who can
 * publish the page; anyone else is refused. A pending one the caller can't
 * publish at is null: opening a publication anywhere else replaces it, as
 * it does a pending one the caller can publish at in another folder.
 */
export const lookup = {
  method: 'GET',
  path: '/api/pages/:pageId/publications/:spaceId',
  params: z.object({ pageId: PageId, spaceId: SpaceId }),
  response: z.strictObject({ publication: Publication.nullable() }),
} as const satisfies RouteDef;

/**
 * One of a source page's live publications, as `list` gives it: as
 * `Publication`, with the space it is in, and for a `live` one the folder
 * it is in too, which the caller can publish at.
 */
export const ListedPublication = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('pending'),
    spaceId: SpaceId,
    pageId: PageId,
    parentId: FolderId.nullable(),
  }),
  z.strictObject({
    state: z.literal('live'),
    spaceId: SpaceId,
    pageId: PageId,
    parentId: FolderId.nullable(),
  }),
  z.strictObject({ state: z.literal('blocked'), spaceId: SpaceId }),
]);

/**
 * Every live publication of the page in another space, oldest first, for
 * someone who can publish the page, as `lookup` would give each; anyone
 * else is refused. So a pending one the caller can't publish at is left
 * out, and of one with versions there they learn only the space. Deleting
 * a page ends its publications, so a page made later with its ID lists none.
 */
export const list = {
  method: 'GET',
  path: '/api/pages/:pageId/publications',
  params: z.object({ pageId: PageId }),
  response: z.strictObject({ publications: z.array(ListedPublication) }),
} as const satisfies RouteDef;

/**
 * End the page's live publication in `spaceId`, for someone who can
 * publish the page, even where they can't see its copy: a copy with
 * versions stays there as a page of its own, for its publishers there to
 * detach; an opening nobody finished is removed. `ended` is false when
 * there was none.
 */
export const end = {
  method: 'POST',
  path: '/api/pages/:pageId/publications/:spaceId/end',
  params: z.object({ pageId: PageId, spaceId: SpaceId }),
  response: z.strictObject({ ended: z.boolean() }),
} as const satisfies RouteDef;

/**
 * Open a publication of `sourcePageId` into another space: make its
 * destination page `pageId` under `parentId`, where the caller can publish,
 * with no version yet, so its attachments can be uploaded. Nobody sees it
 * until its first version arrives. `permissionVersion` is the parent's.
 * Only someone who can publish the source page opens one. If the page
 * already has a live publication there, it is `stale-head`, unless that one
 * is pending in another folder: then it is replaced.
 */
export const open = {
  method: 'POST',
  path: '/api/publications',
  body: z.object({
    sourcePageId: PageId,
    destinationSpaceId: SpaceId,
    pageId: PageId,
    parentId: FolderId.nullable(),
    permissionVersion: z.number().int(),
  }),
  response: z.strictObject({ pageId: PageId }),
  status: 201,
} as const satisfies RouteDef;

/**
 * Send a copy of the source version `sourceRevisionId` as the destination
 * page's next published version (`revision.record.basedOn` null), if its
 * published head is still `expectedPublishedHead`.
 */
export const send = {
  method: 'POST',
  path: '/api/publications/:pageId/versions',
  params: z.object({ pageId: PageId }),
  body: z.object({
    ...Commit,
    sourceRevisionId: RevisionId,
    expectedPublishedHead: RevisionId.nullable(),
  }),
  response: CommitResult,
} as const satisfies RouteDef;

/**
 * Make the destination page an independent page: its first draft
 * (`revision.record.basedOn` null), made from its latest publication, ends
 * the publication if the source's publisher hasn't already. Only someone
 * who can publish there detaches it.
 */
export const detach = {
  method: 'POST',
  path: '/api/publications/:pageId/detach',
  params: z.object({ pageId: PageId }),
  body: z.object(Commit),
  response: CommitResult,
} as const satisfies RouteDef;

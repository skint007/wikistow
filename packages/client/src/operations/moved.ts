// Old addresses of what a move took into another space (protocol section
// 10, "Old addresses"): where a page or folder went, for someone who can
// open it there.
import { copyRoutes, type FolderId, type PageId, type SpaceId } from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import { FolderId as FolderIdSchema, PageId as PageIdSchema } from '../ids.ts';
import type { MovedPage } from '../link-table.ts';
import type { ClientContext } from './session.ts';

/** Where a page or folder a move took into another space is now. */
export type MovedPlace =
  | { kind: 'page'; spaceId: SpaceId; nodeId: PageId }
  | { kind: 'folder'; spaceId: SpaceId; nodeId: FolderId };

/**
 * Where the node of an old address (`/s/<spaceId>/p/<nodeId>` or
 * `/s/<spaceId>/f/<nodeId>`) is now, after every move since, when a move
 * took it into another space and this person can open it there; else null,
 * as for a node that never existed.
 */
export async function movedTo(
  ctx: ClientContext,
  old: { spaceId: SpaceId; nodeId: string },
): Promise<MovedPlace | null> {
  try {
    const place = await ctx.api.call(copyRoutes.moved, { params: old });
    return place.kind === 'page'
      ? { kind: 'page', spaceId: place.spaceId, nodeId: PageIdSchema.parse(place.nodeId) }
      : { kind: 'folder', spaceId: place.spaceId, nodeId: FolderIdSchema.parse(place.nodeId) };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not-found') return null;
    throw error;
  }
}

/**
 * For publishing a page of `spaceId` (`LinkWrite.moved`): the pages of
 * `pageIds` a move took from it that this person can open where they are
 * now. One that can't be looked up counts as not moved, and its entry goes
 * as an entry for any page the writer doesn't see does.
 */
export const movedPagesFor =
  (ctx: ClientContext, spaceId: SpaceId) =>
  async (pageIds: readonly PageId[]): Promise<ReadonlyMap<PageId, MovedPage>> => {
    const found = await Promise.all(
      pageIds.map(async (pageId) => {
        const place = await movedTo(ctx, { spaceId, nodeId: pageId }).catch(() => null);
        return place?.kind === 'page'
          ? [[pageId, { spaceId: place.spaceId, pageId: place.nodeId }] as const]
          : [];
      }),
    );
    return new Map(found.flat());
  };

// The trash (protocol section 10, "The trash"): what was deleted in the
// spaces this person owns, kept for `TRASH_DAYS` days, which they can
// restore or delete for good. Agents never see it.
import { pageRoutes, type FolderId, type PageId, type SpaceId } from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { FolderId as FolderIdSchema, PageId as PageIdSchema } from '../ids.ts';
import { pageLabels } from './pages.ts';
import { openName } from './records.ts';
import type { ClientContext } from './session.ts';

/** Something in the trash, its title or folder name opened (null if it can't be). */
export type TrashEntry = {
  trashId: string;
  spaceId: SpaceId;
  nodeId: FolderId | PageId;
  kind: 'folder' | 'page';
  deletedAt: string;
  /** Who deleted it, by the name the server has; null once their account is gone. */
  deletedBy: string | null;
  title: string | null;
  emoji: string | null;
};

/** The result, or null when it fails a cryptographic check. */
async function unlessUnreadable<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CryptoError) return null;
    throw error;
  }
}

/** Everything in the trash of the spaces this person owns, newest first. */
export async function loadTrash(ctx: ClientContext): Promise<TrashEntry[]> {
  const listed = await ctx.api.call(pageRoutes.listTrash);
  const items = listed.items.map((item) => ({
    ...item,
    nodeId:
      item.kind === 'page' ? PageIdSchema.parse(item.nodeId) : FolderIdSchema.parse(item.nodeId),
  }));
  const titles = new Map<string, { title: string | null; emoji: string | null }>();
  // Pages open as a list does, through their head version.
  const pages = items.filter((item) => item.kind === 'page');
  for (const [spaceId, inSpace] of Map.groupBy(pages, (item) => item.spaceId)) {
    const summaries = inSpace.flatMap((item) =>
      item.draftHead || item.publishedHead
        ? [
            {
              id: PageIdSchema.parse(item.nodeId),
              parentId: null,
              permissionVersion: 0,
              draftHead: item.draftHead,
              publishedHead: item.publishedHead,
              draftChanges: false,
            },
          ]
        : [],
    );
    const labels = await pageLabels(ctx, spaceId, summaries, { trash: true });
    for (const [pageId, label] of labels) {
      titles.set(pageId, { title: label?.title ?? null, emoji: label?.emoji ?? null });
    }
  }
  return Promise.all(
    items.map(async (item) => {
      const { name } = item;
      const subject = {
        spaceId: item.spaceId,
        subjectKind: 'folder' as const,
        subjectId: item.nodeId,
      };
      const folder = name
        ? await unlessUnreadable(async () => {
            const { opened } = await openName(ctx, subject, name);
            return opened.kind === 'current' ? opened.metadata : null;
          })
        : null;
      const label = titles.get(item.nodeId);
      return {
        trashId: item.trashId,
        spaceId: item.spaceId,
        nodeId: item.nodeId,
        kind: item.kind,
        deletedAt: item.deletedAt,
        deletedBy: item.deletedBy,
        title: folder?.name ?? label?.title ?? null,
        emoji: folder?.emoji ?? label?.emoji ?? null,
      };
    }),
  );
}

/**
 * Put something back from the trash: under the folder it was in, or the top
 * of the space or of its shared folder if that folder is in the trash too.
 * Where it went.
 */
export async function restoreTrash(ctx: ClientContext, trashId: string) {
  return ctx.api.call(pageRoutes.restoreTrash, { params: { trashId } });
}

/**
 * Undo deleting a page or folder: restore the trash item it is, if it is
 * still there. Where it went.
 */
export async function restoreDeleted(ctx: ClientContext, nodeId: FolderId | PageId) {
  const { items } = await ctx.api.call(pageRoutes.listTrash);
  const item = items.find((entry) => entry.nodeId === nodeId);
  if (!item) throw new ApiError(404, 'not-found', 'It isn’t in the trash any more');
  return restoreTrash(ctx, item.trashId);
}

/** Delete something in the trash for good. */
export async function purgeTrash(ctx: ClientContext, trashId: string): Promise<void> {
  await ctx.api.call(pageRoutes.purgeTrash, { params: { trashId } });
}

/** Delete for good everything in one space's trash, or in all of this person's. How many went. */
export async function emptyTrash(ctx: ClientContext, spaceId: SpaceId | null): Promise<number> {
  const { removed } = await ctx.api.call(pageRoutes.emptyTrash, { body: { spaceId } });
  return removed;
}

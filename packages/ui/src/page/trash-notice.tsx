import {
  trashOperations,
  type ClientContext,
  type FolderId,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import type { QueryClient } from '@tanstack/react-query';
import { Name } from '@/components/name';
import { contentChanged } from '../data/content-changed';
import { trashQuery } from '../data/queries';
import { showNotice } from './undo-notice';

/** Something just moved to the trash, which the notice offers to put back. */
type Trashed = {
  ctx: ClientContext;
  queryClient: QueryClient;
  spaceId: SpaceId;
  nodeId: FolderId | PageId;
  name: string;
};

/** Say that a page or folder went to the trash, with Undo, which restores it (`UndoNotice`). */
export const noteTrashed = ({ ctx, queryClient, spaceId, nodeId, name }: Trashed) =>
  showNotice({
    ctx,
    message: (
      <>
        Moved “<Name>{name}</Name>” to the trash.
      </>
    ),
    undo: async () => {
      await trashOperations.restoreDeleted(ctx, nodeId);
      await Promise.all([
        contentChanged(queryClient, ctx, { spaceId }),
        queryClient.invalidateQueries({ queryKey: trashQuery(ctx).queryKey }),
      ]);
    },
  });

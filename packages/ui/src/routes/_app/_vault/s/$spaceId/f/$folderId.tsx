import { FolderId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { treeQuery } from '../../../../../../data/queries';
import { FolderCard, FolderView } from '../../../../../../folder/folder-view';
import { Replaceable } from '../../../../../../plugins/places';
import { useArrivedMoved, useOldAddress } from '../../../../../../shell/old-address';
import { useClient } from '../../../../../../vault/store';

export const Route = createFileRoute('/_app/_vault/s/$spaceId/f/$folderId')({
  params: {
    parse: ({ folderId }) => ({ folderId: FolderId.parse(folderId) }),
    stringify: ({ folderId }) => ({ folderId }),
  },
  component: FolderRoute,
});

/**
 * A folder opened from the tree: the pages directly in it, as a list or a
 * table, unless a plugin draws the folder's page, which is given what is
 * in it again as the tree changes. One a move took into another space
 * opens there.
 */
function FolderRoute() {
  const { spaceId, folderId } = Route.useParams();
  const { data: tree, error, dataUpdatedAt } = useQuery(treeQuery(useClient(), spaceId));
  const gone = tree
    ? !tree.folders.some((folder) => folder.id === folderId)
    : error instanceof ApiError && error.code === 'not-found';
  const following = useOldAddress({ spaceId, nodeId: folderId }, gone);
  const movedHere = useArrivedMoved();
  if (following) return <FolderCard>{null}</FolderCard>;
  return (
    <Replaceable name="folder.view" inputs={{ spaceId, folderId }} stamp={dataUpdatedAt}>
      {/* Afresh for each folder, so an open cell or a cell's note doesn't carry over. */}
      <FolderView key={folderId} spaceId={spaceId} folderId={folderId} movedHere={movedHere} />
    </Replaceable>
  );
}

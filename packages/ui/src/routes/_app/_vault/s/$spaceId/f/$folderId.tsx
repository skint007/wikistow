import { FolderId } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { treeQuery } from '../../../../../../data/queries';
import { FolderView } from '../../../../../../folder/folder-view';
import { Replaceable } from '../../../../../../plugins/places';
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
 * in it again as the tree changes.
 */
function FolderRoute() {
  const { spaceId, folderId } = Route.useParams();
  const { dataUpdatedAt } = useQuery(treeQuery(useClient(), spaceId));
  return (
    <Replaceable name="folder.view" inputs={{ spaceId, folderId }} stamp={dataUpdatedAt}>
      {/* Afresh for each folder, so an open cell or a cell's note doesn't carry over. */}
      <FolderView key={folderId} spaceId={spaceId} folderId={folderId} />
    </Replaceable>
  );
}

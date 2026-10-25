import { FolderId } from '@wikistow/client';
import { createFileRoute } from '@tanstack/react-router';
import { FolderView } from '../../../../../../folder/folder-view';

export const Route = createFileRoute('/_app/_vault/s/$spaceId/f/$folderId')({
  params: {
    parse: ({ folderId }) => ({ folderId: FolderId.parse(folderId) }),
    stringify: ({ folderId }) => ({ folderId }),
  },
  component: FolderRoute,
});

/** A folder opened from the tree: the pages directly in it, as a list or a table. */
function FolderRoute() {
  const { spaceId, folderId } = Route.useParams();
  // Afresh for each folder, so an open cell or a cell's note doesn't carry over.
  return <FolderView key={folderId} spaceId={spaceId} folderId={folderId} />;
}

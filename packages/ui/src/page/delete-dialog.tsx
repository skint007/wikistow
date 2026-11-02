import { pageOperations, type FolderId, type PageId, type SpaceId } from '@wikistow/client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { searchIndexChanged, trashQuery, treeQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { useClient } from '../vault/store';
import { noteTrashed } from './trash-notice';

/** Delete page, from the page's menu or its row in the sidebar. */
export function DeletePageDialog({
  page,
  title,
  open,
  onOpenChange,
  onDone,
}: {
  page: pageOperations.PageRef;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Delete “<Name>{title}</Name>”?
          </DialogTitle>
          <DialogDescription>{TRASH_NOTE}</DialogDescription>
        </DialogHeader>
        <DeleteButton spaceId={page.spaceId} nodeId={page.pageId} name={title} onDone={onDone} />
      </DialogContent>
    </Dialog>
  );
}

/** What deleting does, for the dialogs that ask first. */
export const TRASH_NOTE =
  'It goes to the trash with everything in it, and stays there for 30 days. You can restore it from Trash until then. Any public link to it ends.';

/**
 * Moves a page or folder to the trash, then refreshes the tree and says so,
 * with Undo (`TrashNotice`).
 */
export function DeleteButton({
  spaceId,
  nodeId,
  name,
  onDone,
}: {
  spaceId: SpaceId;
  nodeId: FolderId | PageId | null;
  name: string;
  onDone: () => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (!nodeId) return;
    setBusy(true);
    setError(null);
    try {
      await pageOperations.deleteNode(ctx, { spaceId, nodeId });
      searchIndexChanged(queryClient);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: trashQuery(ctx).queryKey }),
      ]);
      noteTrashed({ ctx, spaceId, nodeId, name });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
          Move to trash
        </Button>
      </DialogFooter>
    </>
  );
}

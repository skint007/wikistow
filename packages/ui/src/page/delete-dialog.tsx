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
import { searchIndexChanged, treeQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { useClient } from '../vault/store';

/** Delete page, from the page's menu or its row in the sidebar. */
export function DeletePageDialog({
  page,
  title,
  publishedCount,
  open,
  onOpenChange,
  onDone,
}: {
  page: pageOperations.PageRef;
  title: string;
  publishedCount: number;
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
          <DialogDescription>
            This deletes the page with its draft, all {publishedCount} published version(s), and
            every attachment. It can’t be undone.
          </DialogDescription>
        </DialogHeader>
        <DeleteButton spaceId={page.spaceId} nodeId={page.pageId} onDone={onDone} />
      </DialogContent>
    </Dialog>
  );
}

/** Deletes a page or folder for good, then refreshes the tree. */
export function DeleteButton({
  spaceId,
  nodeId,
  onDone,
}: {
  spaceId: SpaceId;
  nodeId: FolderId | PageId | null;
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
      await queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
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
          Delete for good
        </Button>
      </DialogFooter>
    </>
  );
}

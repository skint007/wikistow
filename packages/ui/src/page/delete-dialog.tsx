import type { FolderId, PageId, pageOperations, SpaceId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { contentChanged } from '../data/content-changed';
import { pageChange, pageWriter, queueQuery } from '../data/offline-changes';
import { trashQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { useAvailability } from '../shell/availability';
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
  const ctx = useClient();
  const { offline, waiting } = useAvailability();
  const { data: entries } = useQuery(queueQuery(ctx));
  const change = pageChange(entries, page.pageId);
  const made = waiting(page.pageId) === 'made';
  const [dropChanges, setDropChanges] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Delete “<Name>{title}</Name>”?
          </DialogTitle>
          <DialogDescription>{deleteNote({ made, offline })}</DialogDescription>
        </DialogHeader>
        {change && !made && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={dropChanges}
              onChange={(event) => setDropChanges(event.target.checked)}
            />
            <span>
              Drop my changes saved on this device, not sent yet. Otherwise they’re sent first, and
              go to the trash with it.
            </span>
          </label>
        )}
        <DeleteButton
          spaceId={page.spaceId}
          nodeId={page.pageId}
          node="page"
          name={title}
          dropChanges={dropChanges}
          onDone={onDone}
        />
      </DialogContent>
    </Dialog>
  );
}

/** What deleting does, for the dialogs that ask first. */
export const TRASH_NOTE =
  'It goes to the trash with everything in it, and stays there for 30 days. You can restore it from Trash until then. Any public link to it ends.';

/**
 * What deleting a page or folder does: into the trash, once back online if
 * offline, or for one made offline and not sent, gone for good with what
 * is in it (ADR 0009, decision 7).
 */
export const deleteNote = ({ made, offline }: { made: boolean; offline: boolean }) =>
  made
    ? 'It was made on this device and isn’t sent yet, so it goes for good, with everything in it.'
    : offline
      ? `${TRASH_NOTE} You’re offline: it goes to the trash once you’re back online.`
      : TRASH_NOTE;

/**
 * Moves a page or folder to the trash, then refreshes the tree and says so,
 * with Undo (`TrashNotice`). Offline, or after changes waiting for it, it
 * waits on this device, and the queue refreshes the tree.
 */
export function DeleteButton({
  spaceId,
  nodeId,
  node,
  name,
  dropChanges = false,
  onDone,
}: {
  spaceId: SpaceId;
  nodeId: FolderId | PageId | null;
  node: 'page' | 'folder';
  name: string;
  /** Drop the page's draft waiting on this device first. */
  dropChanges?: boolean;
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
      const deleted = await pageWriter(ctx).deleteNode({
        spaceId,
        nodeId,
        node,
        name,
        dropChanges,
      });
      if (deleted === 'trashed') {
        await Promise.all([
          contentChanged(queryClient, ctx, { spaceId }),
          queryClient.invalidateQueries({ queryKey: trashQuery(ctx).queryKey }),
        ]);
        noteTrashed({ ctx, spaceId, nodeId, name });
      }
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

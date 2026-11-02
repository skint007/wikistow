import {
  trashOperations,
  type ClientContext,
  type FolderId,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { searchIndexChanged, trashQuery, treeQuery } from '../data/queries';
import { errorMessage } from '../errors';

/** Something just moved to the trash, which the notice offers to put back. */
type Trashed = {
  ctx: ClientContext;
  spaceId: SpaceId;
  nodeId: FolderId | PageId;
  name: string;
};

let shown: Trashed | null = null;
const listeners = new Set<() => void>();
const show = (next: Trashed | null) => {
  shown = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Say that a page or folder went to the trash, with Undo. */
export const noteTrashed = (trashed: Trashed) => show(trashed);

// How long the notice stays.
const SHOWN_MS = 10_000;

/**
 * The notice after a delete, in the bottom corner: what went to the trash,
 * and Undo, which restores it. It goes after a while, or when the vault
 * session it was made in ends.
 */
export function TrashNotice({ ctx }: { ctx: ClientContext }) {
  const trashed = useSyncExternalStore(subscribe, () => shown);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (!trashed) return;
    const timer = setTimeout(() => shown === trashed && show(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [trashed]);
  if (!trashed || trashed.ctx !== ctx) return null;

  async function undo(item: Trashed) {
    setBusy(true);
    setError(null);
    try {
      await trashOperations.restoreDeleted(item.ctx, item.nodeId);
      searchIndexChanged(queryClient, { spaceIds: [item.spaceId] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: treeQuery(item.ctx, item.spaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: trashQuery(item.ctx).queryKey }),
      ]);
      show(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-card bg-card py-2 pr-2 pl-4 text-sm shadow-card min-[900px]:left-20"
    >
      <span className="min-w-0">
        {error ?? (
          <>
            Moved “<Name>{trashed.name}</Name>” to the trash.
          </>
        )}
      </span>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void undo(trashed)}>
        Undo
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={() => show(null)}>
        <X strokeWidth={1.75} />
      </Button>
    </div>
  );
}

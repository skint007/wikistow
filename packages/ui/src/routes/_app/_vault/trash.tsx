import { trashOperations, type SpaceId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { pageRoutes } from '@wikistow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { FileText, Folder } from 'lucide-react';
import { useState } from 'react';
import { Name, plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { searchIndexChanged, spacesQuery, trashQuery, treeQuery } from '../../../data/queries';
import { errorMessage } from '../../../errors';
import { useClient } from '../../../vault/store';

export const Route = createFileRoute('/_app/_vault/trash')({ component: Trash });

type Entry = trashOperations.TrashEntry;

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (time: number) => new Date(time).toLocaleDateString(undefined, { dateStyle: 'medium' });

// What can't be restored, in this app's words.
function restoreMessage(error: unknown, entries: readonly Entry[]) {
  if (error instanceof ApiError && error.code === 'region-mismatch') {
    const folder = entries.find((entry) => entry.nodeId === error.detail.nodeIds?.[0]);
    if (folder)
      return `Restore “${folder.title ?? 'that folder'}” first: it held the shared folder this was in.`;
    return 'Who can see where it was changed since it was deleted, so it can’t go back there.';
  }
  return errorMessage(error);
}

/**
 * Trash (protocol section 10): what was deleted in the spaces this person
 * owns, grouped by space, newest first. Each item can be restored or
 * deleted for good, and a space's trash, or all of it, emptied.
 */
function Trash() {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { data: entries, error } = useQuery(trashQuery(ctx));
  const { data: spaces } = useQuery(spacesQuery(ctx));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null);
  // What Delete for good or Empty trash asks about first.
  const [asking, setAsking] = useState<
    { kind: 'item'; entry: Entry } | { kind: 'space'; spaceId: SpaceId | null } | null
  >(null);

  const spaceName = (spaceId: SpaceId) => {
    const metadata = spaces?.find((space) => space.id === spaceId)?.metadata;
    return metadata?.opened.kind === 'current' ? metadata.opened.metadata.name : 'A space';
  };
  const bySpace = Map.groupBy(entries ?? [], (entry) => entry.spaceId);

  async function act(run: () => Promise<string>, spaceIds: readonly SpaceId[]) {
    setBusy(true);
    setSaid(null);
    try {
      setSaid({ text: await run(), failed: false });
    } catch (caught) {
      setSaid({ text: restoreMessage(caught, entries ?? []), failed: true });
    } finally {
      setBusy(false);
      searchIndexChanged(queryClient, { spaceIds });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trashQuery(ctx).queryKey }),
        ...spaceIds.map((spaceId) =>
          queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey }),
        ),
      ]);
    }
  }
  const restore = (entry: Entry) =>
    act(async () => {
      await trashOperations.restoreTrash(ctx, entry.trashId);
      return `Restored “${entry.title ?? 'it'}”.`;
    }, [entry.spaceId]);
  const purge = (entry: Entry) =>
    act(async () => {
      await trashOperations.purgeTrash(ctx, entry.trashId);
      return `Deleted “${entry.title ?? 'it'}” for good.`;
    }, []);
  const empty = (spaceId: SpaceId | null) =>
    act(async () => {
      const removed = await trashOperations.emptyTrash(ctx, spaceId);
      return removed === 1 ? 'Deleted 1 item for good.' : `Deleted ${removed} items for good.`;
    }, []);

  return (
    <section className="h-full min-h-0 overflow-y-auto rounded-card bg-card shadow-card">
      <div className="mx-auto grid w-full max-w-[720px] gap-6 px-11 py-10 max-[899px]:px-[18px] max-[899px]:py-8">
        <header className="flex flex-wrap items-end gap-3">
          <div className="grid flex-1 gap-1">
            <h1 className="text-[32px] leading-tight font-extrabold">Trash</h1>
            <p className="text-sm text-muted-foreground">
              What was deleted in the spaces you own. Each item is deleted for good after{' '}
              {pageRoutes.TRASH_DAYS} days.
            </p>
          </div>
          {bySpace.size > 0 && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setAsking({ kind: 'space', spaceId: null })}
            >
              Empty trash
            </Button>
          )}
        </header>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(error)}
          </p>
        )}
        {said && (
          <p
            role={said.failed ? 'alert' : 'status'}
            className={said.failed ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
          >
            {said.text}
          </p>
        )}
        {entries?.length === 0 && (
          <p className="text-sm text-muted-foreground">The trash is empty.</p>
        )}
        {[...bySpace].map(([spaceId, inSpace]) => (
          <section key={spaceId} aria-label={plainText(spaceName(spaceId))} className="grid gap-3">
            <div className="flex items-center gap-3">
              <h2 className="flex-1 truncate text-lg font-extrabold">
                <Name>{spaceName(spaceId)}</Name>
              </h2>
              {bySpace.size > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setAsking({ kind: 'space', spaceId })}
                >
                  Empty this space’s trash
                </Button>
              )}
            </div>
            <ul className="grid gap-2">
              {inSpace.map((entry) => (
                <TrashRow
                  key={entry.trashId}
                  entry={entry}
                  busy={busy}
                  onRestore={() => void restore(entry)}
                  onPurge={() => setAsking({ kind: 'item', entry })}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <Dialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {asking?.kind === 'item' ? (
                <>
                  Delete “<Name>{asking.entry.title ?? 'this'}</Name>” for good?
                </>
              ) : asking?.spaceId ? (
                <>
                  Empty the trash of “<Name>{spaceName(asking.spaceId)}</Name>”?
                </>
              ) : (
                'Empty the trash?'
              )}
            </DialogTitle>
            <DialogDescription>
              {asking?.kind === 'item'
                ? 'It is deleted with everything that was in it, every version and attachment.'
                : 'Everything in it is deleted, with every version and attachment.'}{' '}
              It can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const now = asking;
                setAsking(null);
                if (now?.kind === 'item') void purge(now.entry);
                else if (now) void empty(now.spaceId);
              }}
            >
              Delete for good
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TrashRow({
  entry,
  busy,
  onRestore,
  onPurge,
}: {
  entry: Entry;
  busy: boolean;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const Icon = entry.kind === 'folder' ? Folder : FileText;
  const deleted = Date.parse(entry.deletedAt);
  const title = entry.title ?? (entry.kind === 'folder' ? 'A folder' : 'A page');
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-control border p-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-tile bg-muted text-lg">
        {entry.emoji ?? <Icon className="size-5" strokeWidth={1.75} />}
      </span>
      <span className="grid min-w-0 flex-1 basis-56">
        <span className="truncate font-extrabold">
          <Name>{title}</Name>
        </span>
        <span className="text-sm text-muted-foreground">
          Deleted
          {entry.deletedBy && (
            <>
              {' '}
              by <Name>{entry.deletedBy}</Name>
            </>
          )}{' '}
          on {day(deleted)}. Kept until {day(deleted + pageRoutes.TRASH_DAYS * DAY_MS)}.
        </span>
      </span>
      <span className="ml-auto flex shrink-0 gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={onRestore}>
          Restore
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onPurge}>
          Delete for good
        </Button>
      </span>
    </li>
  );
}

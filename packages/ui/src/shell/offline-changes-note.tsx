import {
  queueOperations,
  reviseMetadata,
  type ClientContext,
  type spaceOperations,
} from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
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
import { queueChoices, queueQuery } from '../data/offline-changes';
import { queueOf, spaceOrderQuery, treeQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { FolderTile, folderLook } from './folder-look';

type Entry = queueOperations.QueueEntry;

function nameOf(entry: Entry): string {
  switch (entry.kind) {
    case 'page':
      return entry.payload.title || 'Untitled';
    case 'folder':
      return entry.metadata.name;
    case 'rename':
      return queueOperations.renamedMetadata(entry).name;
    case 'delete':
    case 'move':
      return entry.name || 'Untitled';
    case 'publish':
      return entry.title || 'Untitled';
  }
}

/** What the note says of a change the server refused as gone or out of reach. */
function goneText(entry: Entry): string {
  switch (entry.kind) {
    case 'page':
      return entry.newPage
        ? 'The folder this was made in was deleted, or you lost access to it, while you were offline.'
        : 'This page was deleted, or you lost access to it, while you were offline.';
    case 'folder':
      return 'The folder this was made in was deleted, or you lost access to it, while you were offline.';
    case 'rename':
      return 'This folder was deleted, or you lost access to it, while you were offline, so it wasn’t renamed.';
    case 'delete':
      return 'This was deleted already, or you lost access to it.';
    case 'move':
      return 'This, or the folder it was moved to, was deleted, or you lost access to it, while you were offline, so it wasn’t moved.';
    case 'publish':
      return 'This page was deleted, or you can no longer publish it, so it wasn’t published.';
  }
}

/** What the note says of a change the server refused for another reason, before its reason. */
const REFUSED: Record<Entry['kind'], string> = {
  page: 'Couldn’t be saved.',
  folder: 'Couldn’t be saved.',
  rename: 'Couldn’t be saved.',
  delete: 'Couldn’t be saved.',
  move: 'Couldn’t be moved.',
  publish: 'Wasn’t published.',
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The changes made offline that stopped and wait for the person (ADR 0009,
 * decision 7), in the bottom corner while the vault is open: pages someone
 * changed meanwhile, which open to the conflict prompt; folders someone
 * renamed meanwhile, with both names to choose from; pages or folders
 * gone or out of reach, with Try again, Save as a new page in my space,
 * Copy text and Discard, or for a rename, delete or move, which has nothing
 * left to save, only OK; and changes the server refused, with its reason,
 * only OK for a publish, which the person publishes again once they've looked.
 */
export function OfflineChangesNote({ ctx }: { ctx: ClientContext }) {
  const { data: entries } = useQuery(queueQuery(ctx));
  const { data: order } = useQuery(spaceOrderQuery(ctx));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<queueOperations.QueuedPage | null>(null);
  const stopped = entries?.filter((entry) => entry.failure !== null) ?? [];
  const queue = queueChoices(ctx);
  if (stopped.length === 0 || !queue) return null;
  const conflicts = stopped.filter(
    (entry): entry is queueOperations.QueuedPage =>
      entry.kind === 'page' && entry.failure?.kind === 'conflict',
  );
  const renamed = stopped.filter(
    (entry): entry is queueOperations.QueuedRename =>
      entry.kind === 'rename' && entry.failure?.kind === 'conflict',
  );
  const others = stopped.filter((entry) => entry.failure?.kind !== 'conflict');
  // Nothing is left to save of a rename, delete or move of what's gone: the
  // person is told, and it goes. Nor of a publish: sent again, it would
  // stop again, so the person publishes it again once they've looked.
  const nothingLeft = (entry: Entry) =>
    entry.kind === 'publish' ||
    ((entry.kind === 'rename' || entry.kind === 'delete' || entry.kind === 'move') &&
      entry.failure?.kind === 'gone');
  const copy = (entry: queueOperations.QueuedPage) =>
    navigator.clipboard.writeText(queueOperations.changeText(entry.payload));
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <section
      aria-label="Changes made offline"
      className="fixed right-4 bottom-4 z-50 grid max-h-[60svh] w-[min(24rem,calc(100vw-2rem))] gap-3 overflow-y-auto rounded-card bg-card p-4 text-sm shadow-card"
    >
      {conflicts.length > 0 && (
        <div className="grid gap-1">
          <p className="font-bold">
            {plural(conflicts.length, 'page', 'pages')} changed while you were offline{' '}
            {conflicts.length === 1 ? 'needs' : 'need'} a choice
          </p>
          <ul className="grid gap-2">
            {conflicts.map((entry) => (
              <li key={entry.id} className="grid gap-1">
                <Link
                  to="/s/$spaceId/p/$pageId"
                  params={{ spaceId: entry.spaceId, pageId: entry.id }}
                  search={{ view: 'draft' }}
                  className="underline underline-offset-2"
                >
                  <Name>{nameOf(entry)}</Name>
                </Link>
                {/* For a page that went, or can't be edited, since: Try again says so. */}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void act(() => queue.retry(entry))}
                  >
                    Try again
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void act(() => copy(entry))}>
                    Copy text
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void act(() => queue.discard(entry))}
                  >
                    Discard
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {renamed.map((entry) => (
        <RenameConflict
          key={entry.id}
          ctx={ctx}
          entry={entry}
          onMine={(theirs) => void act(() => queue.renameOnTop(entry.id, theirs))}
          onTheirs={() => void act(() => queue.discard(entry))}
        />
      ))}
      {others.map((entry) => (
        <div key={`${entry.kind} ${entry.id}`} className="grid gap-2">
          <p>
            <span className="font-bold">
              <Name>{nameOf(entry)}</Name>
            </span>{' '}
            {entry.failure?.kind === 'gone'
              ? goneText(entry)
              : `${REFUSED[entry.kind]} ${entry.failure?.kind === 'refused' ? entry.failure.message : ''}`}
          </p>
          {nothingLeft(entry) ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void act(() => queue.discard(entry))}
              >
                OK
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void act(() => queue.retry(entry))}
              >
                Try again
              </Button>
              {entry.kind === 'page' && entry.failure?.kind === 'gone' && order?.homeId && (
                <Button size="sm" variant="outline" onClick={() => setSaving(entry)}>
                  Save as a new page in my space
                </Button>
              )}
              {entry.kind === 'page' && (
                <Button size="sm" variant="outline" onClick={() => void act(() => copy(entry))}>
                  Copy text
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void act(() => queue.discard(entry))}
              >
                Discard
              </Button>
            </div>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {saving && order?.homeId && (
        <SaveAsNewDialog
          ctx={ctx}
          entry={saving}
          homeId={order.homeId}
          onClose={() => setSaving(null)}
        />
      )}
    </section>
  );
}

/**
 * A folder renamed offline that someone changed meanwhile: both names, and
 * which stays. Theirs is the tree's, which leaves the waiting rename out
 * while it waits for this choice.
 */
function RenameConflict({
  ctx,
  entry,
  onMine,
  onTheirs,
}: {
  ctx: ClientContext;
  entry: queueOperations.QueuedRename;
  onMine: (theirs: spaceOperations.LoadedMetadata) => void;
  onTheirs: () => void;
}) {
  const { data: tree } = useQuery(treeQuery(ctx, entry.spaceId));
  const theirs = tree?.folders.find((folder) => folder.id === entry.id)?.metadata ?? null;
  // As Yours sends it: the changes on top of theirs.
  const mine: spaceOperations.LoadedMetadata = {
    ...entry.base,
    opened: {
      kind: 'current',
      metadata:
        theirs?.opened.kind === 'current'
          ? reviseMetadata(theirs.opened, entry.changes)
          : queueOperations.renamedMetadata(entry),
    },
  };
  return (
    <div className="grid gap-2">
      <p>
        <span className="font-bold">A folder you changed offline</span> was changed by someone else
        meanwhile. Which stays?
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!theirs}
          onClick={() => theirs && onMine(theirs)}
        >
          Yours: <Look metadata={mine} />
        </Button>
        <Button size="sm" variant="outline" onClick={onTheirs}>
          Theirs
          {theirs && (
            <>
              : <Look metadata={theirs} />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

/** A folder's tile and name, as the sidebar shows them, so a change of look alone shows too. */
function Look({ metadata }: { metadata: spaceOperations.LoadedMetadata }) {
  if (metadata.opened.kind !== 'current') return null;
  const { emoji, tint } = folderLook(metadata.opened.metadata);
  return (
    <span className="inline-flex items-center gap-1.5">
      <FolderTile metadata={metadata} emoji={emoji} tint={tint} className="size-5 text-xs" />
      <Name>{metadata.opened.metadata.name}</Name>
    </span>
  );
}

/**
 * Save as a new page in my space: the change's title, text and the files
 * this device has, as a new page at the top of the home space. The files it
 * doesn't have are named first, and left out.
 */
function SaveAsNewDialog({
  ctx,
  entry,
  homeId,
  onClose,
}: {
  ctx: ClientContext;
  entry: queueOperations.QueuedPage;
  homeId: queueOperations.QueuedPage['spaceId'];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: files } = useQuery({
    queryKey: ['offline-change-files', entry.id, entry.version],
    queryFn: () => queueOf(ctx)?.filesHere(ctx, entry) ?? null,
    gcTime: 0,
  });
  async function save() {
    const queue = queueChoices(ctx);
    if (!queue) return;
    setBusy(true);
    setError(null);
    try {
      const pageId = await queue.saveAsNewPage(ctx, entry.id, homeId);
      onClose();
      await navigate({
        to: '/s/$spaceId/p/$pageId',
        params: { spaceId: homeId, pageId },
        search: { view: 'draft' },
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as a new page in my space</DialogTitle>
          <DialogDescription>
            “<Name>{nameOf(entry)}</Name>” goes at the top of your own space, with its text and the
            files this device has.
          </DialogDescription>
        </DialogHeader>
        {files && files.missing.length > 0 && (
          <div className="grid gap-1 text-sm">
            <p>These files aren’t on this device, so they are left out:</p>
            <ul className="list-disc pl-5">
              {files.missing.map((ref) => (
                <li key={ref.id}>
                  <Name>{ref.name}</Name>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !files} onClick={() => void save()}>
            Save as a new page
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { queueOperations, type ClientContext } from '@wikistow/client';
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
import { queueOf, queueQuery } from '../data/offline-changes';
import { spaceOrderQuery } from '../data/queries';
import { errorMessage } from '../errors';

type Entry = queueOperations.QueueEntry;

const nameOf = (entry: Entry) =>
  (entry.kind === 'page' ? entry.payload.title : entry.metadata.name) || 'Untitled';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The changes made offline that stopped and wait for the person (ADR 0009,
 * decision 7), in the bottom corner while the vault is open: pages someone
 * changed meanwhile, which open to the conflict prompt; pages or folders
 * gone or out of reach, with Try again, Save as a new page in my space,
 * Copy text and Discard; and changes the server refused, with its reason.
 */
export function OfflineChangesNote({ ctx }: { ctx: ClientContext }) {
  const { data: entries } = useQuery(queueQuery(ctx));
  const { data: order } = useQuery(spaceOrderQuery(ctx));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<queueOperations.QueuedPage | null>(null);
  const stopped = entries?.filter((entry) => entry.failure !== null) ?? [];
  const queue = queueOf(ctx);
  if (stopped.length === 0 || !queue) return null;
  const conflicts = stopped.filter(
    (entry): entry is queueOperations.QueuedPage => entry.failure?.kind === 'conflict',
  );
  const others = stopped.filter((entry) => entry.failure?.kind !== 'conflict');
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
          <ul className="grid gap-1">
            {conflicts.map((entry) => (
              <li key={entry.id}>
                <Link
                  to="/s/$spaceId/p/$pageId"
                  params={{ spaceId: entry.spaceId, pageId: entry.id }}
                  search={{ view: 'draft' }}
                  className="underline underline-offset-2"
                >
                  <Name>{nameOf(entry)}</Name>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {others.map((entry) => (
        <div key={entry.id} className="grid gap-2">
          <p>
            <span className="font-bold">
              <Name>{nameOf(entry)}</Name>
            </span>{' '}
            {entry.failure?.kind === 'gone'
              ? entry.kind === 'folder' || entry.newPage
                ? 'The folder this was made in was deleted, or you lost access to it, while you were offline.'
                : 'This page was deleted, or you lost access to it, while you were offline.'
              : `Couldn’t be saved. ${entry.failure?.kind === 'refused' ? entry.failure.message : ''}`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void act(() => queue.retry(entry.id))}
            >
              Try again
            </Button>
            {entry.kind === 'page' && entry.failure?.kind === 'gone' && order?.homeId && (
              <Button size="sm" variant="outline" onClick={() => setSaving(entry)}>
                Save as a new page in my space
              </Button>
            )}
            {entry.kind === 'page' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void act(() =>
                    navigator.clipboard.writeText(queueOperations.changeText(entry.payload)),
                  )
                }
              >
                Copy text
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void act(() => queue.discard(entry.id))}
            >
              Discard
            </Button>
          </div>
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
  const queue = queueOf(ctx);
  const { data: files } = useQuery({
    queryKey: ['offline-change-files', entry.id, entry.version],
    queryFn: () => queue?.filesHere(ctx, entry) ?? null,
    gcTime: 0,
  });
  async function save() {
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

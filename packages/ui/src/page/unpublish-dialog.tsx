import type { pageOperations, RevisionId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
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
import { runCommand } from '../commands/command';
import { unpublishPage } from '../commands/page-commands';
import { requirementsHere } from '../commands/ui-commands';
import { publishedCopiesQuery, searchIndexChanged, type ListedCopy } from '../data/queries';
import { PLAIN, useClient } from '../vault/store';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from '../sharing/use-action';
import { unpublishMessage } from './messages';
import { Place, usePlaces } from './published-copies';

/**
 * Unpublish a page (protocol section 11), for someone who can publish it:
 * readers lose it and its history, but not what they already have. Its
 * copies in other spaces are other pages, which stay as they are (section
 * 13), and the dialog lists them.
 */
export function UnpublishDialog({
  page,
  title,
  publishedHead,
  permissionVersion,
  copy,
  open,
  onOpenChange,
  onDone,
}: {
  page: pageOperations.PageRef;
  title: string;
  /** The publication the person sees: unpublishing anything newer is refused. */
  publishedHead: RevisionId;
  /** The page's permission version the person sees: a change of access since refuses it too. */
  permissionVersion: number;
  /** A copy of another page, which has no draft here (section 13). */
  copy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void> | void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { locked, hold } = useHoldOpen();
  // Who can unpublish a page can learn where it is published.
  const { data, isError, isFetching } = useQuery({
    ...publishedCopiesQuery(ctx, page),
    enabled: open,
  });
  const copies = isError ? null : data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent locked={locked}>
        <HoldOpen value={hold}>
          <Confirm
            title={title}
            copy={copy}
            copies={copies}
            checking={isFetching}
            onCancel={() => onOpenChange(false)}
            unpublish={async () => {
              try {
                await runCommand(
                  unpublishPage,
                  { ...page, publishedHead, permissionVersion },
                  { satisfies: requirementsHere({ editor: true }), ctx },
                );
              } catch (caught) {
                // Shown as it is now, should the person look again.
                await queryClient.invalidateQueries({ queryKey: [PLAIN, 'page'] });
                throw caught;
              }
              searchIndexChanged(queryClient);
              await Promise.all(
                ['page', 'tree', 'history'].map((kind) =>
                  queryClient.invalidateQueries({ queryKey: [PLAIN, kind] }),
                ),
              );
              onOpenChange(false);
              await onDone();
            }}
          />
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

const NONE: ListedCopy[] = [];

function Confirm({
  title,
  copy,
  copies,
  checking,
  onCancel,
  unpublish,
}: {
  title: string;
  copy: boolean;
  /** Where the page is published in other spaces: undefined while loading, null if that failed. */
  copies: ListedCopy[] | null | undefined;
  /** Whether it is being checked, even with a list already shown. */
  checking: boolean;
  onCancel: () => void;
  unpublish: () => Promise<void>;
}) {
  const { busy, error, run } = useAction(unpublishMessage);
  const id = useId();
  const places = usePlaces(copies ?? NONE, true);
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          Unpublish “<Name>{title}</Name>”?
        </DialogTitle>
        <DialogDescription>
          Readers lose access to the page and its published history.
        </DialogDescription>
      </DialogHeader>
      <p role="note" className="rounded-control bg-muted p-3 text-sm">
        <strong>Copies can’t be recalled.</strong> Anyone who already read the page, or downloaded
        it or its attachments, keeps what they have. Copies published to other spaces stay there,
        for their readers.
      </p>
      {checking || places === null ? (
        <p className="text-sm text-muted-foreground">Checking where else it’s published…</p>
      ) : (
        copies === null && (
          <p className="text-sm text-muted-foreground">Couldn’t check where else it’s published.</p>
        )
      )}
      {copies && places && copies.length > 0 && (
        <section aria-labelledby={`${id}-copies`} className="grid gap-2">
          <h3 id={`${id}-copies`} className="text-sm font-bold text-subtle-foreground">
            It’s published in{' '}
            {copies.length === 1 ? 'another space' : `${copies.length} other spaces`}
          </h3>
          <ul className="grid list-disc gap-1 pl-5 text-sm">
            {copies.map((published) => (
              <li key={published.spaceId}>
                <Place steps={places.get(published.spaceId) ?? []} />
                {published.copy.state === 'blocked' && ', somewhere you can’t publish'}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Unpublishing here doesn’t change them. To stop one being updated from this page, end it
            from “Published in …” near the top of the page.
          </p>
        </section>
      )}
      <p className="text-sm text-muted-foreground">
        {copy
          ? 'You and the other editors keep every version. Readers can see it again once its source is published to it again (while it is still that page’s copy here), or once someone detaches it and publishes it. Readers then see only what is published from then on.'
          : 'You and the other editors keep the draft and every version. If you publish it again, readers see only what you publish from then on.'}
      </p>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={busy} onClick={() => void run(unpublish)}>
          Unpublish
        </Button>
      </DialogFooter>
    </div>
  );
}

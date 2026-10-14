import type { pageOperations } from '@wikistow/client';
import { useQueryClient } from '@tanstack/react-query';
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
import { detachPage } from '../commands/page-commands';
import { requirementsHere } from '../commands/ui-commands';
import { searchIndexChanged } from '../data/queries';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from '../sharing/use-action';
import { PLAIN, useClient } from '../vault/store';
import { detachMessage } from './messages';

/**
 * Detach a page published from another page (protocol section 13), for
 * someone who can publish it: it becomes a page of its own, with a draft
 * made from its latest publication, and its source can't send it versions
 * any more.
 */
export function DetachDialog({
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
  onDone: () => Promise<void> | void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { locked, hold } = useHoldOpen();
  const { busy, error, run } = useAction(detachMessage);
  const detach = () =>
    run(async () => {
      try {
        await runCommand(detachPage, page, {
          satisfies: requirementsHere({ editor: true }),
          ctx,
        });
      } finally {
        // Shown as it is now, whether or not it went through.
        searchIndexChanged(queryClient);
        await Promise.all(
          ['page', 'tree', 'history'].map((kind) =>
            queryClient.invalidateQueries({ queryKey: [PLAIN, kind] }),
          ),
        );
      }
      onOpenChange(false);
      await onDone();
    });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent locked={locked}>
        <HoldOpen value={hold}>
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>
                Detach “<Name>{title}</Name>” from its source?
              </DialogTitle>
              <DialogDescription>
                It becomes a page of its own here, which you and the other editors can change.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Its draft starts from its latest published version. Nobody can publish to it from the
              page it came from any more; publishing that page here again makes a new page. Readers
              keep seeing what is published now, still labelled with where it came from, until
              someone publishes the draft.
            </p>
            <ErrorLine error={error} />
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={() => void detach()}>
                Detach
              </Button>
            </DialogFooter>
          </div>
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

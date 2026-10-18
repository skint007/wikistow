import { sharingOperations } from '@wikistow/client';
import { useQueryClient } from '@tanstack/react-query';
import { submitData } from '@/components/form/submit';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PLAIN, useClient } from '../vault/store';
import type { Person } from './people';
import { ErrorLine, useAction } from './use-action';

/** Whether a person's menu offers Rename…: someone else this app names by their label. */
export const canRename = (person: Person) => !person.self && !person.nameless && !!person.pinned;

/**
 * Rename a contact (protocol section 8.2): the name this person's apps show
 * for them. The server's current name for them, when it differs, shows
 * beside the field, marked as the server's, and is never filled in.
 */
export function RenameContact({
  person,
  onCancel,
  onDone,
}: {
  person: Person;
  onCancel: () => void;
  onDone: (name: string) => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { busy, error, run } = useAction();
  const served = person.entry?.name;
  return (
    <form
      onSubmit={submitData(async (form) => {
        const next = form.get('name');
        if (typeof next !== 'string' || !next.trim()) return;
        const name = next.trim();
        const renamed = await run(async () => {
          await sharingOperations.renameContact(ctx, person.id, name);
          // Everything that names people by their label.
          await Promise.all(
            ['people', 'shared-with-me'].map((kind) =>
              queryClient.invalidateQueries({ queryKey: [PLAIN, kind] }),
            ),
          );
        });
        if (renamed) onDone(name);
      })}
      className="grid gap-4"
    >
      <div className="grid gap-2">
        <Label htmlFor="contact-name">Name</Label>
        <Input
          id="contact-name"
          name="name"
          required
          autoFocus
          maxLength={100}
          defaultValue={person.name}
        />
        {served && served !== person.name && (
          <p className="text-sm text-muted-foreground">
            The server calls them{' '}
            <span title="Their name as the server has it">
              “<Name>{served}</Name>”
            </span>{' '}
            now. Type it above to use it.
          </p>
        )}
      </div>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}

/** `RenameContact` in a dialog of its own, for pages. Open while `person` is set. */
export function RenameContactDialog({
  person,
  onClose,
}: {
  person: Person | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={person !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent dialogClassName="sm:max-w-md" className="grid gap-4">
        <DialogHeader>
          <DialogTitle>Rename contact</DialogTitle>
          <DialogDescription>
            {person?.email ? (
              <>
                How your apps name <Name>{person.email}</Name>. Only you see it.
              </>
            ) : (
              'How your apps name them. Only you see it.'
            )}
          </DialogDescription>
        </DialogHeader>
        {person && <RenameContact person={person} onCancel={onClose} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

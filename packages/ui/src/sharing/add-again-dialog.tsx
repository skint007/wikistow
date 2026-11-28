import { CryptoError, fingerprint, type DirectoryEntry, type SpaceId } from '@wikistow/client';
import { useQueryClient } from '@tanstack/react-query';
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
import { runCommand } from '../commands/command';
import { addCoOwner } from '../commands/sharing-commands';
import { refreshAccess } from '../data/queries';
import { useClient } from '../vault/store';
import { sharingMessage } from './messages';
import { useOwnerRequirements } from './owner-standing';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from './use-action';

/**
 * Add a co-owner again after they replaced their keys (protocol sections
 * 4.6 and 7.6): every key of the space sealed to their new key, and an
 * owner statement naming it, so the space's members accept them again.
 * Until then nobody but them opens what they seal, and this app seals
 * nothing in the space.
 */
export function AddAgainDialog({
  spaceId,
  spaceName,
  owner,
  name,
  onRemove,
  onClose,
  onDone,
}: {
  spaceId: SpaceId;
  spaceName: string;
  /** The owner at the new key the app followed, as the directory lists them. */
  owner: DirectoryEntry;
  name: string;
  /** Remove them as an owner instead, in the owner dialog. */
  onRemove: () => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const satisfies = useOwnerRequirements(spaceId);
  // A folder still at keys only their old key made can't be passed on to
  // their new key: their own app moves it when they finish (section 4.6).
  const { busy, error, run } = useAction((caught) =>
    caught instanceof CryptoError && caught.code === 'key-version'
      ? `A shared folder here still uses keys ${plainText(name)}’s old key made. Ask them to finish replacing their keys in Settings, restoring it first if it’s in the trash, then add them again.`
      : sharingMessage(caught),
  );
  const { locked, hold } = useHoldOpen();
  const [progress, setProgress] = useState<string | null>(null);
  const add = () =>
    run(async () => {
      await runCommand(
        addCoOwner,
        { spaceId, person: { ...owner, foundBy: null } },
        {
          satisfies,
          ctx,
          onProgress: ({ records, total }) => setProgress(`Sealing keys: ${records} of ${total}`),
        },
      );
      await refreshAccess(queryClient, ctx);
      onDone();
    });
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent dialogClassName="sm:max-w-lg" locked={locked || busy}>
        <HoldOpen value={hold}>
          <DialogHeader>
            <DialogTitle>
              Add <Name>{name}</Name> again as an owner?
            </DialogTitle>
            <DialogDescription>
              <Name>{name}</Name> replaced their keys. Until an owner adds them again, nobody in{' '}
              <Name>{spaceName}</Name> opens what they share there with their new keys, and this app
              shares nothing new there.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            Check with them, by phone or in person, that their new key’s fingerprint is:
          </p>
          <p className="font-mono text-sm break-all" data-testid="add-again-fingerprint">
            {fingerprint(owner.identity)}
          </p>
          <p className="text-sm">
            If they didn’t replace their keys, don’t add them: someone else may hold their old key.
            You can remove them as an owner instead. Every shared folder then gets new keys without
            them, unless they already gave a folder keys with their new key, which this app can’t
            open: then only adding them again works.
          </p>
          {progress && busy && (
            <p role="status" className="text-sm font-bold">
              {progress}
            </p>
          )}
          <ErrorLine error={error} />
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Not now
            </Button>
            <Button variant="outline" disabled={busy} onClick={onRemove}>
              Remove them instead
            </Button>
            <Button disabled={busy} onClick={() => void add()}>
              Add again
            </Button>
          </DialogFooter>
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

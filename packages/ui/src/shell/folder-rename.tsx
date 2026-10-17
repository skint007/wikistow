import { spaceOperations, type FolderId, type SpaceId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { submitData } from '@/components/form/submit';
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
import { Name } from '@/components/name';
import { searchIndexChanged, treeQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { useClient } from '../vault/store';

/** The folder menu's Rename…: changes a folder's name for everyone who can see it. */
export function FolderRenameDialog({
  spaceId,
  folderId,
  onOpenChange,
}: {
  spaceId: SpaceId;
  /** Null while closed. */
  folderId: FolderId | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={folderId !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {folderId && (
          <RenameForm
            key={folderId}
            spaceId={spaceId}
            folderId={folderId}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  spaceId,
  folderId,
  onDone,
}: {
  spaceId: SpaceId;
  folderId: FolderId;
  onDone: () => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  // Read from the tree each time, so a save after a refusal is based on what it reloaded.
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const loaded = tree?.folders.find((f) => f.id === folderId)?.metadata;
  const opened = loaded?.opened.kind === 'current' ? loaded.opened.metadata : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loaded || !opened) {
    return (
      <DialogHeader>
        <DialogTitle>Rename folder</DialogTitle>
        <DialogDescription>
          {loaded?.opened.kind === 'newer-format'
            ? 'This folder was saved by a newer version of WikiStow. Update the app to change it.'
            : 'This app can’t read this folder, so it can’t rename it.'}
        </DialogDescription>
      </DialogHeader>
    );
  }

  async function save(form: FormData) {
    const name = form.get('name');
    if (!loaded || typeof name !== 'string' || !name.trim()) return;
    if (name.trim() === opened?.name) return onDone();
    setBusy(true);
    setError(null);
    try {
      // Only the name: the emoji, colour, image and anything else stay as they are.
      await spaceOperations.updateMetadata(ctx, {
        spaceId,
        subject: { kind: 'folder', folderId },
        current: loaded,
        changes: { name: name.trim() },
      });
      // Search shows each page's folders.
      searchIndexChanged(queryClient);
      await queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
      onDone();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'stale-head') {
        // The title shows what the other change made it; what was typed stays.
        await queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
        setError(
          'Someone changed this folder meanwhile, so nothing changed. Save again to rename it.',
        );
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submitData(save)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          Rename “<Name>{opened.name}</Name>”
        </DialogTitle>
        <DialogDescription>
          Everyone who can see the folder sees the new name. It’s encrypted.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="rename-name">Name</Label>
        <Input
          id="rename-name"
          name="name"
          required
          autoFocus
          maxLength={200}
          defaultValue={opened.name}
          onFocus={(event) => event.currentTarget.select()}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

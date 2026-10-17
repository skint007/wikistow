import { folderIconChange, folderIconOf, spaceOperations, type SpaceId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { initials } from '@/components/avatar';
import { IconImage } from '@/components/icon-image';
import { plainText } from '@/components/name';
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
import { cn } from '@/lib/utils';
import { searchIndexChanged, spacesQuery, treeQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { EmojiPopover } from '../page/cover/emoji-picker';
import { iconImage } from '../page/cover/icon-image';
import { useClient, vaultStore } from '../vault/store';
import { pickedIcon, useFolderIcon, type PickedImage } from './folder-look';

/**
 * What fills a space's tile: its image, else its emoji, else the initials
 * of its name. The tile around it is `overflow-hidden`, so the image takes
 * its corners.
 */
export function SpaceIcon({
  metadata,
  name,
}: {
  metadata: spaceOperations.LoadedMetadata | null | undefined;
  name: string;
}) {
  const url = useFolderIcon(metadata);
  const emoji = metadata?.opened.kind === 'current' ? metadata.opened.metadata.emoji : undefined;
  return <IconImage src={url} fallback={emoji ?? initials(plainText(name))} />;
}

/** The space menu's Name and look…, for owners: renames a space and changes its emoji or image. */
export function SpaceLookDialog({
  spaceId,
  open,
  onOpenChange,
}: {
  spaceId: SpaceId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && <LookForm spaceId={spaceId} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** A space's name, emoji (null for none) and image, which is its own (`kept`), none, or one picked here. */
type SpaceChoice = { name: string; emoji: string | null; image: 'kept' | PickedImage | null };

function LookForm({ spaceId, onDone }: { spaceId: SpaceId; onDone: () => void }) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  // Read from the tree each time, so a save after a refusal is based on what it reloaded.
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const loaded = tree?.space?.metadata;
  const opened = loaded?.opened.kind === 'current' ? loaded.opened.metadata : null;
  const kept = useFolderIcon(loaded);
  // What the person changed, until they save; null shows the space as it is.
  const [picked, setPicked] = useState<SpaceChoice | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tile = useRef<HTMLButtonElement>(null);

  if (!loaded || !opened) {
    return (
      <DialogHeader>
        <DialogTitle>Name and look</DialogTitle>
        <DialogDescription>
          {loaded?.opened.kind === 'newer-format'
            ? 'This space was saved by a newer version of WikiStow. Update the app to change it.'
            : 'This app can’t read this space’s name, so it can’t change it.'}
        </DialogDescription>
      </DialogHeader>
    );
  }
  const current: SpaceChoice = {
    name: opened.name,
    emoji: opened.emoji ?? null,
    image: folderIconOf(opened) && 'kept',
  };
  const look = picked ?? current;
  const image = look.image === 'kept' ? kept : (look.image?.url ?? null);

  async function save() {
    if (!loaded) return;
    const name = look.name.trim();
    if (!name) return;
    // Only what was changed, so the rest stays as another owner may have left it.
    const changes = {
      ...(name === current.name ? {} : { name }),
      ...(look.emoji === current.emoji ? {} : { emoji: look.emoji }),
      ...(look.image === current.image ? {} : { extensions: folderIconChange(pickedIcon(look)) }),
    };
    if (Object.keys(changes).length === 0) return onDone();
    setBusy(true);
    setError(null);
    // The rail and pickers read the spaces list; the header and breadcrumbs, the tree.
    const refresh = () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey }),
        queryClient.invalidateQueries({ queryKey: spacesQuery(ctx).queryKey }),
      ]);
    try {
      await spaceOperations.updateMetadata(ctx, {
        spaceId,
        subject: { kind: 'space' },
        current: loaded,
        changes,
      });
      // Search shows the space's name first in each page's path.
      if ('name' in changes) searchIndexChanged(queryClient);
      await refresh();
      onDone();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'stale-head') {
        // Show what the other change made it, to choose again from.
        await refresh();
        setPicked(null);
        setError('Another owner changed this space meanwhile, so nothing changed. Choose again.');
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>Name and look</DialogTitle>
        <DialogDescription>
          Everyone in the space sees them. They’re encrypted like everything in it.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="space-look-name">Name</Label>
        <Input
          id="space-look-name"
          required
          autoFocus
          maxLength={200}
          value={look.name}
          onChange={(event) => setPicked({ ...look, name: event.target.value })}
        />
      </div>
      <div className="grid justify-items-start gap-2">
        <span className="text-sm font-medium">Emoji or image</span>
        <EmojiPopover
          current={look.emoji}
          open={picking}
          onOpenChange={setPicking}
          // Choosing an emoji drops the image; choosing an image keeps the emoji to fall back on.
          onPick={(emoji) => setPicked({ ...look, emoji, image: null })}
          onRemove={() => setPicked({ ...look, emoji: null })}
          image={{
            current: image,
            onPick: async (file) => {
              const icon = await iconImage(file);
              const url = vaultStore.objectUrl(icon.bytes, icon.mediaType, vaultStore.epoch());
              setPicked({ ...look, image: { icon, url } });
            },
            onRemove: () => setPicked({ ...look, image: null }),
          }}
        >
          <button
            ref={tile}
            type="button"
            aria-label={
              image
                ? 'Change image'
                : look.emoji
                  ? `Change emoji ${look.emoji}`
                  : 'Choose an emoji or image'
            }
            className={cn(
              'grid size-12 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-tile bg-linear-to-br from-primary-2 to-primary text-lg leading-none font-extrabold text-primary-foreground',
              // Opacity, not tint, which would replace the gradient.
              'outline-2 outline-offset-[3px] outline-border outline-dashed hover:opacity-90 focus-visible:outline-ring active:opacity-80',
              look.emoji && !image && 'text-2xl',
            )}
          >
            <IconImage src={image} fallback={look.emoji ?? initials(plainText(look.name))} />
          </button>
        </EmojiPopover>
        {(look.emoji !== null || look.image !== null) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setPicked({ ...look, emoji: null, image: null });
              // This button goes once it's done its work; focus stays in the fields.
              tile.current?.focus();
            }}
          >
            Back to initials
          </Button>
        )}
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

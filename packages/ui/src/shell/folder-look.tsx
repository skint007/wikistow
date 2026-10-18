import {
  DEFAULT_FOLDER_LOOK,
  FOLDER_TINTS,
  folderIconChange,
  folderIconOf,
  folderSymbolChange,
  folderSymbolOf,
  ICON_NAMESPACE,
  spaceOperations,
  type FolderIcon,
  type FolderId,
  type FolderLook,
  type NodeMetadata,
  type SpaceId,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Picture, SymbolIcon, symbolWords } from '@/components/symbol-icon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Name } from '@/components/name';
import { cn } from '@/lib/utils';
import { treeQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { EmojiPopover } from '../page/cover/emoji-picker';
import { iconImage } from '../page/cover/icon-image';
import { PLAIN, useClient, vaultStore } from '../vault/store';

// Written out in full so Tailwind finds each class.
const TINTS: Record<string, string> = {
  green: 'bg-folder-green',
  orange: 'bg-folder-orange',
  blue: 'bg-folder-blue',
  pink: 'bg-folder-pink',
  purple: 'bg-folder-purple',
};

/** A folder's look from its metadata, ⭐ on blue for what it doesn't name. */
export const folderLook = ({ emoji, tint }: NodeMetadata): FolderLook => ({
  emoji: emoji ?? DEFAULT_FOLDER_LOOK.emoji,
  tint: tint ?? DEFAULT_FOLDER_LOOK.tint,
});

/** An image picked in the folder or space fields and not yet saved, with a `blob:` URL to show it. */
export type PickedImage = { icon: FolderIcon; url: string };

/**
 * What the folder fields show and change: a look, an icon of the icon set
 * by name, or none, and an image, which is the folder's own (`kept`), none,
 * or one picked here. Picking an icon drops the image and the other way
 * round.
 */
export type LookChoice = FolderLook & {
  symbol: string | null;
  image: 'kept' | PickedImage | null;
};

/** How a new folder starts: ⭐ on blue, no icon or image. */
export const DEFAULT_CHOICE: LookChoice = { ...DEFAULT_FOLDER_LOOK, symbol: null, image: null };

const sameLook = (a: LookChoice, b: LookChoice) =>
  a.emoji === b.emoji && a.tint === b.tint && a.symbol === b.symbol && a.image === b.image;

/** The image picked in the fields to save, if any. */
export const pickedIcon = ({ image }: Pick<LookChoice, 'image'>) =>
  image === 'kept' || image === null ? null : image.icon;

/** The `extensions` change for the icon and image picked, from what was `current`. */
export const pictureChange = (
  look: Pick<LookChoice, 'symbol' | 'image'>,
  current: Pick<LookChoice, 'symbol' | 'image'>,
): NodeMetadata['extensions'] => ({
  ...(look.symbol === current.symbol ? {} : folderSymbolChange(look.symbol)),
  ...(look.image === current.image ? {} : folderIconChange(pickedIcon(look))),
});

/** A folder's tile: its emoji, icon or image, on its tint. A tint this app doesn't know shows blue. */
export const tileClass = (tint: string) =>
  cn(
    'grid shrink-0 place-items-center overflow-hidden rounded-folder leading-none',
    TINTS[tint] ?? TINTS['blue'],
  );

/**
 * A `blob:` URL for a folder's or space's image, or null for none. Made once
 * for each version of its metadata, not on each tree load, and kept until
 * the vault locks. It needs no network: the image came with the metadata.
 */
export function useFolderIcon(
  loaded: spaceOperations.LoadedMetadata | null | undefined,
): string | null {
  const metadata = loaded?.opened.kind === 'current' ? loaded.opened.metadata : null;
  const { data } = useQuery({
    // A version's metadata never changes, so its ID is enough.
    queryKey: [PLAIN, 'folder-icon', loaded?.head],
    enabled: metadata?.extensions[ICON_NAMESPACE] != null,
    staleTime: Infinity,
    gcTime: Infinity,
    networkMode: 'always',
    retry: false,
    queryFn: () => {
      const icon = metadata && folderIconOf(metadata);
      return icon ? vaultStore.objectUrl(icon.bytes, icon.mediaType, vaultStore.epoch()) : null;
    },
  });
  return data ?? null;
}

/** A folder's tile in the tree: its image, else its icon, else its emoji, on its tint. */
export function FolderTile({
  metadata,
  emoji,
  tint,
  className,
}: {
  metadata: spaceOperations.LoadedMetadata | null;
  emoji: string;
  tint: string;
  className?: string;
}) {
  const url = useFolderIcon(metadata);
  const symbol =
    metadata?.opened.kind === 'current' ? folderSymbolOf(metadata.opened.metadata) : null;
  return (
    <span aria-hidden className={cn(tileClass(tint), className)}>
      <Picture image={url} symbol={symbol} emoji={emoji} />
    </span>
  );
}

/** The label of a tile that opens the picker, for what it shows. */
export const pictureLabel = ({
  image,
  symbol,
  emoji,
}: {
  image: string | null;
  symbol: string | null;
  emoji: string | null;
}) =>
  image
    ? 'Change image'
    : symbol
      ? `Change icon ${symbolWords(symbol)}`
      : emoji
        ? `Change emoji ${emoji}`
        : 'Choose an emoji, icon or image';

/**
 * A folder's emoji, icon or image, from the page emoji picker, and its
 * colour, one of the design's tints, with a way back to ⭐ on blue. For a
 * new folder and for changing one. `kept` is the folder's own image, if any.
 */
export function FolderLookFields({
  look,
  kept,
  onChange,
}: {
  look: LookChoice;
  kept: string | null;
  onChange: (look: LookChoice) => void;
}) {
  const [picking, setPicking] = useState(false);
  const tile = useRef<HTMLButtonElement>(null);
  const image = look.image === 'kept' ? kept : (look.image?.url ?? null);
  return (
    <div className="grid gap-4">
      <div className="grid justify-items-start gap-2">
        <span className="text-sm font-medium">Emoji, icon or image</span>
        <EmojiPopover
          current={look.emoji}
          open={picking}
          onOpenChange={setPicking}
          // Choosing an emoji drops the icon or image; choosing either keeps the emoji to fall back on.
          onPick={(emoji) => onChange({ ...look, emoji, symbol: null, image: null })}
          symbol={{
            current: look.symbol,
            onPick: (symbol) => onChange({ ...look, symbol, image: null }),
            onRemove: () => onChange({ ...look, symbol: null }),
          }}
          image={{
            current: image,
            onPick: async (file) => {
              const icon = await iconImage(file);
              const url = vaultStore.objectUrl(icon.bytes, icon.mediaType, vaultStore.epoch());
              onChange({ ...look, symbol: null, image: { icon, url } });
            },
            onRemove: () => onChange({ ...look, image: null }),
          }}
        >
          <button
            ref={tile}
            type="button"
            aria-label={pictureLabel({ image, symbol: look.symbol, emoji: look.emoji })}
            className={cn(
              tileClass(look.tint),
              'size-12 cursor-pointer text-2xl outline-2 outline-offset-[3px] outline-border outline-dashed hover:tint focus-visible:outline-ring active:tint-strong',
            )}
          >
            <Picture image={image} symbol={look.symbol} emoji={look.emoji} />
          </button>
        </EmojiPopover>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Colour</legend>
        <div className="flex flex-wrap gap-3">
          {FOLDER_TINTS.map((tint) => {
            const current = look.tint === tint;
            return (
              <button
                key={tint}
                type="button"
                aria-pressed={current}
                onClick={() => onChange({ ...look, tint })}
                className="group grid justify-items-center gap-1 rounded-row text-xs font-bold text-subtle-foreground outline-offset-2 hover:text-foreground"
              >
                <span
                  aria-hidden
                  className={cn(
                    tileClass(tint),
                    'size-9 text-base ring-offset-2 ring-offset-card group-active:opacity-80',
                    current
                      ? 'ring-2 ring-primary'
                      : 'group-hover:ring-2 group-hover:ring-foreground/25',
                  )}
                >
                  {look.symbol ? (
                    <SymbolIcon name={look.symbol} fallback={look.emoji} />
                  ) : (
                    look.emoji
                  )}
                </span>
                {tint[0]?.toUpperCase() + tint.slice(1)}
              </button>
            );
          })}
        </div>
      </fieldset>
      {!sameLook(look, DEFAULT_CHOICE) && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() => {
            onChange(DEFAULT_CHOICE);
            // This button goes once it's done its work; focus stays in the fields.
            tile.current?.focus();
          }}
        >
          Back to ⭐ on blue
        </Button>
      )}
    </div>
  );
}

/** The folder menu's Emoji and colour…: changes a folder's look for everyone who can see it. */
export function FolderLookDialog({
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
          <LookForm
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

function LookForm({
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
  const kept = useFolderIcon(loaded);
  // What the person picked, until they save; null shows the folder as it is.
  const [picked, setPicked] = useState<LookChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loaded || !opened) {
    return (
      <DialogHeader>
        <DialogTitle>Emoji and colour</DialogTitle>
        <DialogDescription>
          {loaded?.opened.kind === 'newer-format'
            ? 'This folder was saved by a newer version of WikiStow. Update the app to change it.'
            : 'This app can’t read this folder, so it can’t change its emoji or colour.'}
        </DialogDescription>
      </DialogHeader>
    );
  }
  const current: LookChoice = {
    ...folderLook(opened),
    symbol: folderSymbolOf(opened),
    image: folderIconOf(opened) && 'kept',
  };
  const look = picked ?? current;

  async function save() {
    if (!loaded || sameLook(look, current)) return onDone();
    setBusy(true);
    setError(null);
    try {
      const { emoji, tint } = look;
      await spaceOperations.updateMetadata(ctx, {
        spaceId,
        subject: { kind: 'folder', folderId },
        current: loaded,
        changes: { emoji, tint, extensions: pictureChange(look, current) },
      });
      await queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
      onDone();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'stale-head') {
        // Show what the other change made it, to choose again from.
        await queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
        setPicked(null);
        setError('Someone changed this folder meanwhile, so nothing changed. Choose again.');
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          Emoji and colour for “<Name>{opened.name}</Name>”
        </DialogTitle>
        <DialogDescription>
          Everyone who can see the folder sees them. They’re encrypted like its name.
        </DialogDescription>
      </DialogHeader>
      <FolderLookFields look={look} kept={kept} onChange={setPicked} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button disabled={busy} onClick={() => void save()}>
          Save
        </Button>
      </DialogFooter>
    </div>
  );
}

import { ImageUp, SmilePlus } from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { IconImage } from '@/components/icon-image';
import { Picture, symbolWords } from '@/components/symbol-icon';
import { Button, uploadButtonClass } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  type useReturnFocus,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { errorMessage } from '../../errors';
import { badgeClass } from './cover-band';
import { ICON_ACCEPT } from './icon-image';

const EmojiGrid = lazy(() => import('./emoji-grid'));
const IconGrid = lazy(() => import('./icon-grid'));

/** What the picker's Image tab shows and does. */
export type ImageChoice = {
  /** The image in use, as a `blob:` URL, or null for none. */
  current: string | null;
  /**
   * Prepare and keep a chosen file, such as with `iconImage`. The tab stays
   * open until it resolves, and shows the message of a rejection.
   */
  onPick: (file: File) => Promise<void>;
  /** Offers Remove image while there is one. */
  onRemove?: () => void;
  /** The upload button's label while `onPick` runs; Resizing… unless given. */
  working?: string;
};

/** What the picker's Icons tab shows and does: an icon of the icon set, by name. */
export type SymbolChoice = {
  /** The icon in use, or null for none. */
  current: string | null;
  onPick: (name: string) => void;
  /** Offers Remove icon while there is one. */
  onRemove: () => void;
};

/**
 * The emoji picker, which pages, folders and spaces share: a popover opened
 * by `children`, its trigger button, with tabs for an emoji, an icon of the
 * icon set and an image. It opens on the one in use. Picking closes it.
 */
export function EmojiPopover({
  current,
  open,
  onOpenChange,
  onPick,
  onRemove,
  symbol,
  image,
  returnFocus,
  children,
}: {
  current: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (emoji: string) => void;
  /** Offers Remove emoji while there is one. */
  onRemove?: () => void;
  symbol: SymbolChoice;
  image: ImageChoice;
  /** Where focus goes on closing, when opened from elsewhere; the trigger otherwise. */
  returnFocus?: ReturnType<typeof useReturnFocus>['content'] | undefined;
  children: ReactNode;
}) {
  const close = () => onOpenChange(false);
  const emoji = (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading emoji…</p>}>
      <EmojiGrid
        current={current}
        onPick={(emoji) => {
          onPick(emoji);
          close();
        }}
        onRemove={
          onRemove &&
          (() => {
            onRemove();
            close();
          })
        }
      />
    </Suspense>
  );
  const icons = (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading icons…</p>}>
      <IconGrid
        current={symbol.current}
        onPick={(name) => {
          symbol.onPick(name);
          close();
        }}
        onRemove={() => {
          symbol.onRemove();
          close();
        }}
      />
    </Suspense>
  );
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-[316px]" {...returnFocus}>
        <Tabs
          initial={image.current ? 'image' : symbol.current ? 'icons' : 'emoji'}
          emoji={emoji}
          icons={icons}
          image={<ImageTab image={image} onDone={close} />}
        />
      </PopoverContent>
    </Popover>
  );
}

const TABS = [
  { kind: 'emoji', label: 'Emoji' },
  { kind: 'icons', label: 'Icons' },
  { kind: 'image', label: 'Image' },
] as const;
type Tab = (typeof TABS)[number]['kind'];

// Mounted on each opening, so it opens on the kind in use.
function Tabs({ initial, ...content }: { initial: Tab } & Record<Tab, ReactNode>) {
  const [tab, setTab] = useState(initial);
  return (
    <div className="grid gap-3">
      <div
        role="group"
        aria-label="Icon"
        className="inline-flex justify-self-start rounded-control border border-input p-0.5"
      >
        {TABS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            aria-pressed={kind === tab}
            onClick={() => setTab(kind)}
            className={cn(
              'rounded-row px-2.5 py-1 text-sm font-bold text-muted-foreground hover:tint hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:tint-strong',
              kind === tab && 'bg-muted text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {content[tab]}
    </div>
  );
}

function ImageTab({ image, onDone }: { image: ImageChoice; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File) {
    setBusy(true);
    setError(null);
    try {
      await image.onPick(file);
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      {image.current && (
        <div className="flex items-center gap-3">
          <span className="grid size-16 shrink-0 overflow-hidden rounded-tile bg-muted">
            <IconImage src={image.current} fallback={null} />
          </span>
          {image.onRemove && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                image.onRemove?.();
                onDone();
              }}
            >
              Remove image
            </Button>
          )}
        </div>
      )}
      <label className={uploadButtonClass}>
        <ImageUp className="size-4" strokeWidth={1.75} />
        {busy ? (image.working ?? 'Resizing…') : 'Upload an image…'}
        <input
          type="file"
          accept={ICON_ACCEPT}
          className="sr-only"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void pick(file);
            event.target.value = '';
          }}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        PNG, JPEG, WebP, GIF or SVG. It’s resized to fit.
      </p>
    </div>
  );
}

/**
 * The draft view's badge, which opens the picker, or an Add emoji button in
 * its place when the page has no emoji, icon or image.
 */
export function EmojiPicker({
  emoji,
  hasImage,
  symbol,
  image,
  open,
  onOpenChange,
  onPick,
  returnFocus,
}: {
  emoji: string | null;
  /** Whether the page has an image, which `image.current` shows once it's decrypted. */
  hasImage: boolean;
  symbol: SymbolChoice;
  image: ImageChoice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null removes the emoji. */
  onPick: (emoji: string | null) => void;
  /** Where focus goes on closing, when opened from elsewhere; the badge otherwise. */
  returnFocus?: ReturnType<typeof useReturnFocus>['content'];
}) {
  return (
    <EmojiPopover
      current={emoji}
      open={open}
      onOpenChange={onOpenChange}
      onPick={onPick}
      onRemove={() => onPick(null)}
      symbol={symbol}
      image={image}
      returnFocus={returnFocus}
    >
      {emoji || hasImage || symbol.current ? (
        <button
          type="button"
          aria-label={
            hasImage
              ? 'Change image'
              : symbol.current
                ? `Change icon ${symbolWords(symbol.current)}`
                : `Change emoji ${emoji}`
          }
          className={cn(
            badgeClass,
            'cursor-pointer outline-2 outline-offset-[3px] outline-border outline-dashed hover:tint focus-visible:outline-ring active:tint-strong',
          )}
        >
          <Picture image={image.current} symbol={symbol.current} emoji={emoji} />
        </button>
      ) : (
        <button
          type="button"
          className="glass absolute bottom-3 left-11 flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold hover:tint active:tint-strong max-[899px]:left-[18px]"
        >
          <SmilePlus className="size-4" strokeWidth={1.75} /> Add emoji
        </button>
      )}
    </EmojiPopover>
  );
}

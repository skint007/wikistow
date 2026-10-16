import { SmilePlus } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  type useReturnFocus,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { badgeClass } from './cover-band';

const EmojiGrid = lazy(() => import('./emoji-grid'));

/**
 * The emoji picker, which pages and folders share: a popover opened by
 * `children`, its trigger button, holding the emoji grid. Picking closes it.
 */
export function EmojiPopover({
  current,
  open,
  onOpenChange,
  onPick,
  onRemove,
  returnFocus,
  children,
}: {
  current: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (emoji: string) => void;
  /** Offers Remove emoji while there is one. */
  onRemove?: () => void;
  /** Where focus goes on closing, when opened from elsewhere; the trigger otherwise. */
  returnFocus?: ReturnType<typeof useReturnFocus>['content'] | undefined;
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-[316px]" {...returnFocus}>
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading emoji…</p>}>
          <EmojiGrid
            current={current}
            onPick={(emoji) => {
              onPick(emoji);
              onOpenChange(false);
            }}
            onRemove={
              onRemove &&
              (() => {
                onRemove();
                onOpenChange(false);
              })
            }
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The draft view's emoji badge, which opens the picker, or an Add emoji
 * button in its place when the page has none.
 */
export function EmojiPicker({
  emoji,
  open,
  onOpenChange,
  onPick,
  returnFocus,
}: {
  emoji: string | null;
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
      returnFocus={returnFocus}
    >
      {emoji ? (
        <button
          type="button"
          aria-label={`Change emoji ${emoji}`}
          className={cn(
            badgeClass,
            'cursor-pointer outline-2 outline-offset-[3px] outline-border outline-dashed hover:tint focus-visible:outline-ring active:tint-strong',
          )}
        >
          {emoji}
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

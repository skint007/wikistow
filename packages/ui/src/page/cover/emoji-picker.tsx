import { SmilePlus } from 'lucide-react';
import { lazy, Suspense } from 'react';
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
  const pick = (chosen: string | null) => {
    onPick(chosen);
    onOpenChange(false);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {emoji ? (
          <button
            type="button"
            aria-label={`Change emoji ${emoji}`}
            className={cn(
              badgeClass,
              'cursor-pointer outline-2 outline-offset-[3px] outline-border outline-dashed focus-visible:outline-ring',
            )}
          >
            {emoji}
          </button>
        ) : (
          <button
            type="button"
            className="glass absolute bottom-3 left-11 flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold max-[899px]:left-[18px]"
          >
            <SmilePlus className="size-4" strokeWidth={1.75} /> Add emoji
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[316px]" {...returnFocus}>
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading emoji…</p>}>
          <EmojiGrid current={emoji} onPick={pick} onRemove={() => pick(null)} />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}

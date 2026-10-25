import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import type { LinkCompletion } from './completion';

const WIDTH = 288;
const GAP = 4;

/**
 * The options for the link being typed, under its `[[`, kept on screen.
 * The editor keeps focus: it moves through the list and takes an option,
 * and a click takes one too.
 */
export function CompletionListbox({ completion }: { completion: LinkCompletion }) {
  const list = useSyncExternalStore(completion.subscribe, completion.list);
  const box = useRef<HTMLUListElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // Below the link, or above it when there's no room below; never off the side.
  useLayoutEffect(() => {
    const element = box.current;
    if (!list || !element) return;
    const height = element.offsetHeight;
    const below = list.at.bottom + GAP;
    const top = below + height > window.innerHeight ? list.at.top - GAP - height : below;
    const left = Math.max(GAP, Math.min(list.at.left, window.innerWidth - WIDTH - GAP));
    setPlace({ left, top: Math.max(GAP, top) });
  }, [list]);

  useEffect(() => {
    if (!list) return;
    box.current?.children[list.active]?.scrollIntoView({ block: 'nearest' });
  }, [list]);

  // Scrolling moves the link; the list goes until typing brings it back.
  useEffect(() => {
    if (!list) return;
    const close = () => setPlace(null);
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [list]);

  if (!list) return null;
  const firstNew = list.options.findIndex((option) => option.type === 'create');
  return createPortal(
    <ul
      ref={box}
      id={list.id}
      role="listbox"
      aria-label={list.label}
      className={cn(
        'fixed z-50 max-h-72 w-72 overflow-y-auto rounded-control border bg-popover p-1 text-sm text-popover-foreground shadow-md',
        !place && 'invisible',
      )}
      style={place ?? undefined}
    >
      {list.options.map((option, i) => (
        <li
          key={`${option.type}-${option.label}-${i}`}
          id={`${list.id}-${i}`}
          role="option"
          aria-selected={i === list.active}
          // Keep the editor focused; the click takes the option.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => completion.accept(i)}
          className={cn(
            'flex cursor-pointer items-baseline gap-2 rounded-row px-2 py-1.5',
            i === list.active && 'bg-accent',
            i === firstNew && i > 0 && 'mt-1 border-t pt-2',
          )}
        >
          <span className="min-w-0 truncate">{option.displayLabel}</span>
          {option.detail && (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{option.detail}</span>
          )}
        </li>
      ))}
    </ul>,
    document.body,
  );
}

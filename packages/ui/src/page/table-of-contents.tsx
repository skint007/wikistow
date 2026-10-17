import { useLocation } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

/** A heading of the page as the reader shows it, with the unique id `headingIds` gave it. */
export type Heading = { id: string; text: string; level: number };

// Not the reader's hidden Footnotes heading.
const HEADINGS = '.page-body :is(h1, h2, h3, h4, h5, h6)[id]:not(.sr-only)';

const same = (a: Heading[], b: Heading[]) =>
  a.length === b.length &&
  a.every((h, i) => h.id === b[i]?.id && h.text === b[i]?.text && h.level === b[i]?.level);

/**
 * The headings of the page body shown in `root`, in order, read again as
 * it's drawn: the body is read in a worker and shown once it's back.
 */
export function useHeadings(root: HTMLElement | null): Heading[] {
  const [headings, setHeadings] = useState<Heading[]>([]);
  useEffect(() => {
    if (!root) return;
    const read = () => {
      const next = Array.from(root.querySelectorAll(HEADINGS), (element) => ({
        id: element.id,
        text: element.textContent?.trim() ?? '',
        level: Number(element.tagName.slice(1)),
      }));
      setHeadings((shown) => (same(shown, next) ? shown : next));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [root]);
  return headings;
}

// The line, this far below the top of the page in view, a section's
// heading has passed when the reader is in that section.
const LINE = 80;

/**
 * The last heading at or above `LINE`, or the last one with the page
 * scrolled to its end. `card` scrolls in itself, or with the window on
 * phones.
 */
function readingOf(headings: Heading[], card: HTMLElement) {
  const box = card.scrollHeight > card.clientHeight ? card : document.documentElement;
  // A phone's window grows as its address bar hides; the root's clientHeight doesn't.
  const height = box === card ? card.clientHeight : window.innerHeight;
  if (box.scrollHeight > height && box.scrollTop + height >= box.scrollHeight - 1)
    return headings.at(-1)?.id ?? null;
  const line = Math.max(card.getBoundingClientRect().top, 0) + LINE;
  let reading: string | null = null;
  for (const { id } of headings) {
    const top = document.getElementById(id)?.getBoundingClientRect().top;
    if (top === undefined || top > line) break;
    reading = id;
  }
  return reading;
}

/**
 * The id of the heading whose section the reader is in, as the page's
 * `card` scrolls, and `choose` for an entry clicked. A heading just gone
 * to, by an entry or a link opened, stays current until the reader
 * scrolls or clicks again, as one near the end can't scroll up to the line.
 */
function useCurrentHeading(headings: Heading[], card: HTMLElement | null) {
  const hash = useLocation({ select: (location) => location.hash });
  const [chosen, setChosen] = useState<string | null>(hash || null);
  const [reading, setReading] = useState<string | null>(null);
  useEffect(() => setChosen(hash || null), [hash]);
  useEffect(() => {
    if (!card) return;
    const read = () => setReading(readingOf(headings, card));
    const unchoose = () => setChosen(null);
    read();
    const resized = new ResizeObserver(read);
    resized.observe(card);
    card.addEventListener('scroll', read, { passive: true });
    window.addEventListener('scroll', read, { passive: true });
    // On the window: keys scroll the page with the focus anywhere.
    const moves = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
    for (const move of moves) window.addEventListener(move, unchoose, { passive: true });
    return () => {
      resized.disconnect();
      card.removeEventListener('scroll', read);
      window.removeEventListener('scroll', read);
      for (const move of moves) window.removeEventListener(move, unchoose);
    };
  }, [headings, card]);
  return {
    current: chosen && headings.some((h) => h.id === chosen) ? chosen : reading,
    // Clicking the entry already gone to scrolls back to it, with no new hash.
    choose: setChosen,
  };
}

/**
 * Beside the page, a long list scrolls in its own column: scroll that,
 * not the page, to bring `link` into view.
 */
function keepInColumn(link: Element, card: HTMLElement | null) {
  let column = link.parentElement;
  while (column && getComputedStyle(column).overflowY === 'visible') column = column.parentElement;
  if (!column || column === card) return;
  const { top, bottom } = link.getBoundingClientRect();
  const box = column.getBoundingClientRect();
  if (top < box.top) column.scrollTop -= box.top - top;
  else if (bottom > box.bottom) column.scrollTop += bottom - box.bottom;
}

// Each level below the page's top one, one step further in.
const INDENT = ['', 'pl-4', 'pl-8', 'pl-12', 'pl-16', 'pl-20'];

/**
 * Links to the page's headings, nested by level. Beside the page it's a
 * list; `collapsed`, for narrow windows, it's a disclosure above the body.
 */
export function TableOfContents({
  headings,
  card,
  collapsed = false,
  className,
}: {
  headings: Heading[];
  /** The page's card, whose scrolling says which section is being read. */
  card: HTMLElement | null;
  collapsed?: boolean;
  className?: string;
}) {
  // Its own state, so the page body isn't drawn again as the section changes.
  const { current, choose } = useCurrentHeading(headings, card);
  const shown = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const link = shown.current?.querySelector('[aria-current]');
    if (!collapsed && link) keepInColumn(link, card);
  }, [current, collapsed, card]);
  const top = Math.min(...headings.map((h) => h.level));
  const list = (
    <ol ref={shown} className="grid gap-0.5 text-sm">
      {headings.map((heading) => (
        <li
          key={heading.id}
          aria-level={heading.level - top + 1}
          className={INDENT[heading.level - top]}
        >
          <a
            href={`#${heading.id}`}
            aria-current={heading.id === current ? 'location' : undefined}
            onClick={() => choose(heading.id)}
            className="block rounded-row px-2 py-1 text-subtle-foreground outline-offset-[-2px] hover:tint hover:text-foreground active:tint-strong aria-[current=location]:bg-primary-soft aria-[current=location]:text-primary-ink aria-[current=location]:shadow-[inset_3px_0_0_var(--primary-ink)]"
          >
            {heading.text}
          </a>
        </li>
      ))}
    </ol>
  );
  if (collapsed)
    return (
      <nav aria-label="On this page" className={className}>
        <details className="group rounded-control bg-muted px-2 py-1">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-row px-2 py-1 text-sm font-bold hover:tint active:tint-strong [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-4 transition-transform group-open:rotate-90"
              strokeWidth={1.75}
            />
            On this page
          </summary>
          <div className="pb-1">{list}</div>
        </details>
      </nav>
    );
  return (
    <nav aria-label="On this page" className={cn('grid content-start gap-2', className)}>
      <p className="px-2 text-xs font-bold tracking-wide text-muted-foreground uppercase">
        On this page
      </p>
      {list}
    </nav>
  );
}

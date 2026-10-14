import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
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

// Each level below the page's top one, one step further in.
const INDENT = ['', 'pl-4', 'pl-8', 'pl-12', 'pl-16', 'pl-20'];

/**
 * Links to the page's headings, nested by level. Beside the page it's a
 * list; `collapsed`, for narrow windows, it's a disclosure above the body.
 */
export function TableOfContents({
  headings,
  collapsed = false,
  className,
}: {
  headings: Heading[];
  collapsed?: boolean;
  className?: string;
}) {
  const top = Math.min(...headings.map((h) => h.level));
  const list = (
    <ol className="grid gap-0.5 text-sm">
      {headings.map((heading) => (
        <li
          key={heading.id}
          aria-level={heading.level - top + 1}
          className={INDENT[heading.level - top]}
        >
          <a
            href={`#${heading.id}`}
            className="block rounded-row px-2 py-1 text-subtle-foreground hover:bg-accent hover:text-foreground"
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
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-sm font-bold [&::-webkit-details-marker]:hidden">
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

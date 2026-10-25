import { searchFilter } from '@wikistow/client';
import { Link } from '@tanstack/react-router';
import { createContext, use, type MouseEvent, type ReactNode } from 'react';

/** Opens search with a query, from the app shell (`AppShell`); null outside it. */
export const SearchOpener = createContext<((query: string) => void) | null>(null);

/**
 * A link that opens search with `query`. A click in the app opens it where
 * the page is, without leaving it, so a draft's unsaved changes aren't
 * asked about. Its address is the page's own with `?q=` (which `AppShell`
 * opens search from, then takes out of the address), so opening it in
 * another tab, or copying it, opens search there too. `filterQuery` writes
 * a filter's query.
 */
export function SearchLink({
  query,
  className,
  children,
}: {
  query: string;
  className?: string;
  children: ReactNode;
}) {
  const open = use(SearchOpener);
  const onClick = (event: MouseEvent) => {
    const plain =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (!open || !plain) return;
    // Left to the link otherwise: a new tab, a window, or a download.
    event.preventDefault();
    open(query);
  };
  return (
    <Link
      to="."
      search={(prev) => ({ ...prev, q: query })}
      onClick={onClick}
      {...(className === undefined ? {} : { className })}
    >
      {children}
    </Link>
  );
}

/**
 * The query for a filter (`searchFilter`): `tag:soup`, `status:"in
 * progress"`. A key no filter can name gives an empty query, which opens
 * search empty.
 */
export const filterQuery = (key: string, value: string) => searchFilter(key, value) ?? '';

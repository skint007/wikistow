import { searchFilter } from '@wikistow/client';
import { Link } from '@tanstack/react-router';
import { createContext, use, type MouseEvent, type ReactNode } from 'react';

/** Opens search with a query, from the app shell (`AppShell`); null outside it. */
export const SearchOpener = createContext<((query: string) => void) | null>(null);

/**
 * A link that opens search with `query`. A click in the app opens it where
 * the page is, without leaving it, so a draft's unsaved changes aren't
 * asked about. Its address is the page's own with `#search=` and the query
 * (`searchHash`), which `AppShell` opens search from, then takes out of the
 * address, so opening it in another tab, or copying it, opens search there
 * too, after signing in or unlocking if those come first
 * (`withoutSearchHash`). The query stays in the fragment, which the browser
 * never sends: it comes from pages the server can't read. `filterQuery`
 * writes a filter's query.
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
      search
      hash={searchHash(query)}
      onClick={onClick}
      {...(className === undefined ? {} : { className })}
    >
      {children}
    </Link>
  );
}

const PREFIX = 'search=';

/** The fragment, `#` left out, of an address that opens search with `query`. */
export const searchHash = (query: string) => PREFIX + encodeURIComponent(query);

/** The query an address's fragment (`#` or not) opens search with, or null for any other. */
export function linkedSearch(hash: string): string | null {
  const fragment = hash.replace(/^#/, '');
  if (!fragment.startsWith(PREFIX)) return null;
  try {
    return decodeURIComponent(fragment.slice(PREFIX.length)).slice(0, 1000);
  } catch {
    return null;
  }
}

// A search an address asked for, held while signing in or unlocking comes
// first: in memory only, never in the address those pages return to, which
// the browser sends, nor in the browser's storage.
let held: string | null = null;

/**
 * `href` without a search fragment, for an address to return to after
 * signing in or unlocking. The query is held instead, for `takeHeldSearch`.
 */
export function withoutSearchHash(href: string): string {
  const at = href.indexOf('#');
  const query = at < 0 ? null : linkedSearch(href.slice(at));
  if (query === null) return href;
  held = query;
  return href.slice(0, at);
}

/** The search `withoutSearchHash` held, once, or null. */
export function takeHeldSearch(): string | null {
  const query = held;
  held = null;
  return query;
}

/**
 * The query for a filter (`searchFilter`): `tag:soup`, `status:"in
 * progress"`. A key no filter can name gives an empty query, which opens
 * search empty.
 */
export const filterQuery = (key: string, value: string) => searchFilter(key, value) ?? '';

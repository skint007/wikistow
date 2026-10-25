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
 * too, after unlocking if that comes first (`withoutSearchHash`). The query stays in the fragment, which the browser
 * never sends: it comes from pages the server can't read. `filterQuery`
 * writes a filter's query. `hint` says what it opens, where its text alone
 * doesn't, as a hint and to a screen reader.
 */
export function SearchLink({
  query,
  hint,
  className,
  children,
}: {
  query: string;
  hint?: string;
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
      // The page's own address, which isn't the page as it is (`aria-current`) by its fragment.
      activeOptions={{ includeHash: true }}
      onClick={onClick}
      {...(hint === undefined
        ? {}
        : // Above it, as a link's hint (`linkHint`), where the pointer doesn't cover it.
          { 'data-hint': hint, 'data-hint-side': 'top', 'aria-description': hint })}
      {...(className === undefined ? {} : { className })}
    >
      {children}
    </Link>
  );
}

const PREFIX = 'search=';

/**
 * The fragment, `#` left out, of an address that opens search with `query`.
 * A lone surrogate, which a property's escapes can make, can't be encoded,
 * so it becomes U+FFFD.
 */
export const searchHash = (query: string) => PREFIX + encodeURIComponent(query.toWellFormed());

/**
 * The query an address's fragment (`#` or not) opens search with, or null
 * for any other fragment. One that doesn't decode, as typed by hand, opens
 * search empty, so it still leaves the address.
 */
export function linkedSearch(hash: string): string | null {
  const fragment = hash.replace(/^#/, '');
  if (!fragment.startsWith(PREFIX)) return null;
  try {
    return decodeURIComponent(fragment.slice(PREFIX.length)).slice(0, 1000);
  } catch {
    return '';
  }
}

// A search an address asked for, held while unlocking comes first: in
// memory only, never in the address unlocking returns to, which the browser
// sends, nor in the browser's storage. Unlocking is the same account's, and
// signing out drops it; signing in may be someone else's, so isn't held for.
let held: string | null = null;

/**
 * `href` without a search fragment, for an address to return to after
 * unlocking, or with `hold` false, signing in. The query is held for
 * `takeHeldSearch` when unlocking; signing in drops it, with any held.
 */
export function withoutSearchHash(href: string, { hold = true }: { hold?: boolean } = {}): string {
  if (!hold) held = null;
  const at = href.indexOf('#');
  const query = at < 0 ? null : linkedSearch(href.slice(at));
  if (query === null) return href;
  if (hold) held = query;
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

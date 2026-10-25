import { searchFilter } from '@wikistow/client';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/**
 * A link that opens search with `query`, on the page it's on: `?q=` added
 * to the URL, which the app shell opens search from and then lets go
 * (`AppShell`). It replaces the URL rather than adding to history, so Back
 * doesn't open search again. `filterQuery` writes a filter's query.
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
  return (
    <Link
      to="."
      search={(prev) => ({ ...prev, q: query })}
      replace
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

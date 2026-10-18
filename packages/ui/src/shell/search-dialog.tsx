import type { ClientContext, Marked, SearchHit, searchOperations } from '@wikistow/client';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useDeferredValue, useEffect, useId, useMemo, useState } from 'react';
import { plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { notCredential } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { searchIndexQuery, searchProgressKey } from '../data/queries';
import { errorMessage } from '../errors';
import { breadcrumb, markedParts, searchStatus } from './search-model';

type Hit = SearchHit<searchOperations.SearchPage>;

/**
 * Search across every space, from the rail or Ctrl+K (Cmd+K on Apple). The index is built
 * on this device from the pages this person can read (`searchIndexQuery`),
 * with its progress shown until it is ready. Up and down move through the
 * results, Enter or a click opens one: its draft, for a draft hit. A copy
 * unpublished where it is opens as its page does, at its last publication.
 */
export function SearchDialog({
  ctx,
  open,
  onOpenChange,
}: {
  ctx: ClientContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dialogClassName="sm:max-w-xl" className="grid gap-3 p-4 pt-5">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Titles and text of the pages you can read, searched on this device.
        </DialogDescription>
        <SearchBody ctx={ctx} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function SearchBody({ ctx, onDone }: { ctx: ClientContext; onDone: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const index = useQuery(searchIndexQuery(ctx, queryClient));
  const { data: progress } = useQuery<searchOperations.IndexProgress>({
    queryKey: searchProgressKey,
    queryFn: skipToken,
  });
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const results = useMemo(
    () => index.data?.search(deferred, { limit: 50 }) ?? [],
    [index.data, deferred],
  );
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [results]);
  const ids = useId();
  const optionId = (i: number) => `${ids}-${i}`;
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  });

  function openHit({ doc }: Hit) {
    onDone();
    void navigate({
      to: '/s/$spaceId/p/$pageId',
      params: { spaceId: doc.spaceId, pageId: doc.pageId },
      search: doc.draft ? { view: 'draft' } : {},
    });
  }

  const status = index.isError
    ? null
    : searchStatus({ index: index.data, progress, query: deferred, results: results.length });
  return (
    <>
      <div className="relative mr-8">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.75}
        />
        <input
          role="combobox"
          aria-label="Search pages"
          aria-expanded={results.length > 0}
          aria-controls={`${ids}-results`}
          aria-activedescendant={results.length > 0 ? optionId(active) : undefined}
          aria-autocomplete="list"
          autoFocus
          {...notCredential}
          spellCheck={false}
          placeholder="Search pages"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((at) => Math.min(Math.max(at + step, 0), results.length - 1));
            } else if (event.key === 'Enter') {
              const hit = results[active];
              if (hit) {
                event.preventDefault();
                openHit(hit);
              }
            }
          }}
          className="h-10 w-full rounded-control border border-input bg-transparent pr-3 pl-9 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {status}
        {index.data && index.isFetching && progress && progress.total > 0 && (
          <span className="sr-only">
            Updating: {progress.pages} of {progress.total}
          </span>
        )}
      </p>
      {index.isError && (
        <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
          <span className="flex-1">Couldn’t index your pages: {errorMessage(index.error)}</span>
          <Button variant="outline" size="sm" onClick={() => void index.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {results.length > 0 && (
        <ul
          id={`${ids}-results`}
          role="listbox"
          aria-label="Results"
          className="-mx-1 grid max-h-[min(60vh,28rem)] gap-0.5 overflow-y-auto px-1"
        >
          {results.map((hit, i) => (
            <ResultRow
              key={`${hit.doc.spaceId}/${hit.doc.pageId}`}
              hit={hit}
              id={optionId(i)}
              active={i === active}
              onOpen={() => openHit(hit)}
              onHover={() => setActive(i)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** One result. Its snippet is built here, once per hit, so only rows shown pay for one. */
function ResultRow({
  hit,
  id,
  active,
  onOpen,
  onHover,
}: {
  hit: Hit;
  id: string;
  active: boolean;
  onOpen: () => void;
  onHover: () => void;
}) {
  const snippet = useMemo(() => hit.snippet(), [hit]);
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      onClick={onOpen}
      onMouseMove={onHover}
      className={cn(
        'grid cursor-pointer gap-0.5 rounded-row px-2.5 py-2',
        active && 'bg-primary-soft',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn('min-w-0 flex-1 truncate font-extrabold', active && 'text-primary-ink')}
        >
          {hit.title.text.trim() ? <Highlighted {...hit.title} /> : 'Untitled'}
        </span>
        {(hit.doc.draft || hit.doc.unpublished) && (
          <span
            title={hit.doc.unpublished ? 'Readers can’t see this copy.' : undefined}
            className="shrink-0 rounded-full bg-status-draft px-2 text-xs font-bold text-status-draft-foreground"
          >
            {hit.doc.draft ? 'Draft' : 'Unpublished'}
          </span>
        )}
      </span>
      {hit.doc.path.length > 0 && (
        <span className="truncate text-xs text-muted-foreground">
          <bdi>{plainText(breadcrumb(hit.doc.path))}</bdi>
        </span>
      )}
      {snippet.text && (
        <span className="line-clamp-2 text-sm text-subtle-foreground">
          <Highlighted {...snippet} />
        </span>
      )}
    </li>
  );
}

/** Page text with its matches marked: text, never HTML, with its controls shown. */
function Highlighted(marked: Marked) {
  return (
    <bdi>
      {markedParts(marked).map((part, i) =>
        part.mark ? (
          <mark key={i} className="rounded-xs bg-note px-px text-note-foreground">
            {plainText(part.text)}
          </mark>
        ) : (
          <span key={i}>{plainText(part.text)}</span>
        ),
      )}
    </bdi>
  );
}

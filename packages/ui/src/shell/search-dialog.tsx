import type { ClientContext, Marked, SearchHit, searchOperations } from '@wikistow/client';
import { useNavigate } from '@tanstack/react-router';
import { ChevronRight, Search } from 'lucide-react';
import {
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { notCredential } from '@/components/ui/input';
import { ariaShortcut, shortcutLabel } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { usePaletteList } from '../commands/palette-entries';
import {
  isPaletteKey,
  paletteRows,
  recentCommands,
  useRecentCommands,
  type PaletteRow,
} from '../commands/palette';
import { usePageIndex } from '../data/page-index';
import { errorMessage } from '../errors';
import type { MeaningHit } from '../meaning/meaning-index';
import { passageSnippet, useMeaningSearch } from '../meaning/search';
import { Replaceable } from '../plugins/places';
import { usePlugins } from '../plugins/runtime';
import {
  breadcrumb,
  commandStatus,
  isApple,
  isSearchKey,
  looksFor,
  markedParts,
  searchStatus,
} from './search-model';

type Hit = SearchHit<searchOperations.SearchPage>;

const hitKey = ({ doc }: Hit) => `${doc.spaceId}/${doc.pageId}`;

/** A page found by meaning, as a row shows it: no word marked, and the start of its passage. */
const meaningRow = ({ page, passage, score }: MeaningHit): Hit => ({
  doc: page.doc,
  score,
  title: { text: page.title, highlights: [] },
  snippet: () => ({ text: passageSnippet(page.text, passage.start), highlights: [] }),
});

/**
 * Search across every space, from the rail or Ctrl+K (Cmd+K on Apple), or
 * opened with `query` from a link (`SearchLink`). Words search titles and
 * text, and filters properties: `tag:soup`, `status:"in progress"`
 * (`parseSearch`). The index is built on this device from the pages this
 * person can read (`usePageIndex`), with its progress shown until it is
 * ready. Up and down move through the results, Enter or a click opens one:
 * its draft, for a draft hit. A copy unpublished where it is opens as its
 * page does, at its last publication.
 *
 * Where search by meaning is on (ADR 0016), a **By meaning** section
 * below the word matches lists up to five other pages close in meaning
 * (`useMeaningSearch`), narrowed by the same filters, with how far the
 * vectors have got on the status line while pages are left. Up and down
 * move through both, its label naming its group, not a stop.
 *
 * Typed first, `>` turns it into the command palette (`paletteRows`): the
 * commands offered where the person is (`usePaletteEntries`), recent ones
 * first. Ctrl+Shift+P (Cmd+Shift+P on Apple) or F1 opens it so.
 *
 * A plugin can draw the results of a word search in place of the list
 * (`search.results`, ADR 0011); the box, the line under it, the commands
 * and **By meaning**, below the plugin's view, stay the app's. The view opens a result with
 * `host.app.navigate`, which closes search (`AppShell`).
 */
export function SearchDialog({
  ctx,
  open,
  query = '',
  onOpenChange,
}: {
  ctx: ClientContext;
  open: boolean;
  /** What it opens with. */
  query?: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dialogClassName="sm:max-w-xl" className="grid gap-3 p-4 pt-5">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Titles, text and properties of the pages you can read, searched on this device.
        </DialogDescription>
        {/* Opened again with another query, as by a link, it starts over with it. */}
        <SearchBody key={query} ctx={ctx} initial={query} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function SearchBody({
  ctx,
  initial,
  onDone,
}: {
  ctx: ClientContext;
  initial: string;
  onDone: () => void;
}) {
  const navigate = useNavigate();
  const { index, progress, error, updating, retry } = usePageIndex(ctx);
  const [query, setQuery] = useState(initial);
  const deferred = useDeferredValue(query);
  // `>` first lists commands instead; deleting it searches again.
  const commanding = query.startsWith('>');
  const searching = deferred.startsWith('>') ? '' : deferred;
  const results = useMemo(
    () => (searching ? (index?.search(searching, { limit: 50 }) ?? []) : []),
    [index, searching],
  );
  const listed = useMemo(() => results.map(hitKey), [results]);
  const meaning = useMeaningSearch(index, searching, listed);
  const byMeaning = useMemo(() => (meaning?.hits ?? []).map(meaningRow), [meaning?.hits]);
  // What a plugin drawing the results is given of them.
  const searchResults = useMemo(
    () =>
      results.map(({ doc, title }) => ({
        spaceId: doc.spaceId,
        pageId: doc.pageId,
        title: title.text,
        draft: doc.draft,
      })),
    [results],
  );
  const offered = usePaletteList();
  const recent = useRecentCommands();
  const commands = commanding ? paletteRows(offered, query.slice(1), recent) : [];
  const chosenCommand = useChosen(
    commands.map(({ entry }) => entry.command.id),
    query,
  );
  // Up, down and Enter move through the app's own list, not a plugin's drawn in its place.
  // Set as the list mounts (`Own`), so search opened with a query a plugin draws never has it.
  const [ownShown, setOwnShown] = useState(false);
  // One list for the keys: the word matches, then those by meaning.
  const rows = useMemo(
    () => [...(ownShown ? results : []), ...byMeaning],
    [ownShown, results, byMeaning],
  );
  const hits = useChosen(rows.map(hitKey), deferred);
  const list = commanding ? chosenCommand : hits;
  const count = commanding ? commands.length : rows.length;
  const { active } = list;
  const ids = useId();
  const optionId = (i: number) => `${ids}-${i}`;
  // Only when the row chosen changes: a rebuild or progress mustn't scroll the list.
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [list.shown]);

  // Opened with a query, as `>` from Ctrl+Shift+P, typing goes on after it.
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const end = box.current?.value.length ?? 0;
    box.current?.setSelectionRange(end, end);
  }, []);

  // A word search's results, which a plugin may draw in place of the list (`search.results`).
  const replaced =
    usePlugins().replaced['search.results'] !== null &&
    !commanding &&
    index !== undefined &&
    index.size > 0 &&
    looksFor(deferred);

  function openHit({ doc }: Hit) {
    onDone();
    void navigate({
      to: '/s/$spaceId/p/$pageId',
      params: { spaceId: doc.spaceId, pageId: doc.pageId },
      search: doc.draft ? { view: 'draft' } : {},
    });
  }

  function runCommandRow({ entry }: PaletteRow) {
    // Dimmed, it does nothing, as its own control doesn't.
    if (entry.waiting) return;
    recentCommands.used(entry.command.id);
    onDone();
    // Once this box has closed and put the focus back: what the command
    // opens then gives it back there too.
    setTimeout(entry.run);
  }

  const listProps = {
    id: `${ids}-results`,
    role: 'listbox',
    className: '-mx-1 grid max-h-[min(60vh,28rem)] gap-0.5 overflow-y-auto px-1',
  };
  const rowOf = (hit: Hit, i: number) => (
    <ResultRow
      key={hitKey(hit)}
      hit={hit}
      id={optionId(i)}
      active={!commanding && i === active}
      onOpen={() => openHit(hit)}
      onHover={() => hits.choose(hitKey(hit))}
    />
  );
  // After the word matches the app lists, or alone below a plugin's.
  const meaningFrom = ownShown ? results.length : 0;
  const meaningGroup = byMeaning.length > 0 && (
    <li role="group" aria-label="By meaning" className="grid gap-0.5">
      <span
        aria-hidden
        className="px-2.5 pt-2 pb-0.5 text-xs font-bold tracking-wide text-muted-foreground uppercase"
      >
        By meaning
      </span>
      <ul role="presentation" className="grid gap-0.5">
        {byMeaning.map((hit, i) => rowOf(hit, meaningFrom + i))}
      </ul>
    </li>
  );
  const resultList = (
    <Own onShown={setOwnShown}>
      {(results.length > 0 || (!replaced && meaningGroup)) && (
        <ul {...listProps} aria-label="Results">
          {results.map(rowOf)}
          {!replaced && meaningGroup}
        </ul>
      )}
    </Own>
  );

  const status = commanding
    ? commandStatus(commands.length)
    : error
      ? null
      : searchStatus({
          index,
          progress,
          query: deferred,
          results: results.length,
          meaning: byMeaning.length,
        });
  // Not announced: it changes with each page indexed.
  const meaningProgress =
    !commanding && !error && index && index.size > 0 && meaning?.asks ? meaning.progress : null;
  return (
    <>
      <div className="relative mr-8">
        {commanding ? (
          <ChevronRight
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.75}
          />
        ) : (
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.75}
          />
        )}
        <input
          role="combobox"
          aria-label={commanding ? 'Run a command' : 'Search pages'}
          aria-expanded={count > 0}
          aria-controls={replaced ? `${ids}-results ${ids}-meaning` : `${ids}-results`}
          aria-activedescendant={count > 0 ? optionId(active) : undefined}
          aria-autocomplete="list"
          ref={box}
          autoFocus
          {...notCredential}
          spellCheck={false}
          maxLength={1000}
          placeholder="Search pages"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // The palette's keys in search turn to commands, and search's
            // key among commands back to pages; the shell leaves them be.
            const apple = isApple();
            if (isPaletteKey(event, apple) || isSearchKey(event, apple)) {
              event.preventDefault();
              setQuery(
                isPaletteKey(event, apple) ? (commanding ? query : '>') : commanding ? '' : query,
              );
              return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              list.step(event.key === 'ArrowDown' ? 1 : -1);
            } else if (event.key === 'Enter' && count > 0) {
              const row = commanding ? commands[active] : rows[active];
              if (!row) return;
              event.preventDefault();
              if ('entry' in row) runCommandRow(row);
              else openHit(row);
            }
          }}
          className="h-10 w-full rounded-control border border-input bg-transparent pr-3 pl-9 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </div>
      <p className="text-sm text-muted-foreground">
        <span role="status">
          {status}
          {/* Once a rebuild, not at each step: pages others change rebuild it. */}
          {!commanding && index && updating && <span className="sr-only">Updating</span>}
        </span>
        {meaningProgress && <span> · {meaningProgress}</span>}
      </p>
      {!commanding && error && (
        <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
          <span className="flex-1">Couldn’t index your pages: {errorMessage(error)}</span>
          <Button variant="outline" size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
      {commanding ? (
        commands.length > 0 && (
          <ul {...listProps} aria-label="Commands">
            {commands.map((row, i) => (
              <CommandRow
                key={row.entry.command.id}
                row={row}
                id={optionId(i)}
                active={i === active}
                onRun={() => runCommandRow(row)}
                onHover={() => chosenCommand.choose(row.entry.command.id)}
              />
            ))}
          </ul>
        )
      ) : replaced ? (
        <>
          <div className="-mx-1 flex max-h-[min(60vh,28rem)] min-h-0 flex-col px-1 empty:hidden">
            <Replaceable
              name="search.results"
              inputs={{ query: deferred, results: searchResults }}
              keep
            >
              {resultList}
            </Replaceable>
          </div>
          {meaningGroup && (
            <ul
              {...listProps}
              id={`${ids}-meaning`}
              aria-label="More results"
              className="-mx-1 grid max-h-[min(30vh,16rem)] gap-0.5 overflow-y-auto px-1"
            >
              {meaningGroup}
            </ul>
          )}
        </>
      ) : (
        resultList
      )}
    </>
  );
}

/** The app's own list, saying while it is shown, so the box's keys move through it then. */
function Own({ onShown, children }: { onShown: (shown: boolean) => void; children: ReactNode }) {
  useLayoutEffect(() => {
    onShown(true);
    return () => onShown(false);
  }, [onShown]);
  return children;
}

/**
 * The row chosen among `keys` for `query`, by its key, so a list changing
 * under it (the index rebuilding as pages change) doesn't move it; a new
 * query starts at its first row. `shown` changes only when the row shown
 * chosen does.
 */
function useChosen(keys: readonly string[], query: string) {
  const [chosen, setChosen] = useState<{ query: string; key: string } | null>(null);
  const found = chosen?.query === query ? keys.indexOf(chosen.key) : -1;
  const active = Math.max(found, 0);
  const choose = (key: string | undefined) => {
    if (key !== undefined) setChosen({ query, key });
  };
  return {
    active,
    choose,
    step: (by: 1 | -1) => choose(keys[Math.min(Math.max(active + by, 0), keys.length - 1)]),
    shown: `${query}\n${keys[active] ?? ''}`,
  };
}

/** A command: its title, with what the query matched marked, why it can't run now, its plugin and its keys. */
function CommandRow({
  row: { entry, title },
  id,
  active,
  onRun,
  onHover,
}: {
  row: PaletteRow;
  id: string;
  active: boolean;
  onRun: () => void;
  onHover: () => void;
}) {
  const waiting = entry.waiting ?? undefined;
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={waiting ? true : undefined}
      onClick={onRun}
      onMouseMove={onHover}
      className={cn(
        'flex min-w-0 cursor-pointer items-center gap-3 rounded-row px-2.5 py-2',
        active && 'bg-primary-soft',
        waiting && 'cursor-default',
      )}
    >
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-bold',
          active && 'text-primary-ink',
          waiting && 'opacity-60',
        )}
      >
        <Highlighted {...title} />
      </span>
      {/* Written out, not a hint: the focus stays in the box, so a hint would show only on hover. */}
      {waiting && <span className="shrink-0 text-xs text-muted-foreground">{waiting}</span>}
      {entry.plugin && (
        <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
          <bdi>{plainText(entry.plugin)}</bdi>
        </span>
      )}
      {entry.keys && (
        <kbd
          aria-keyshortcuts={ariaShortcut(entry.keys)}
          className="shrink-0 font-sans text-xs text-muted-foreground"
        >
          {shortcutLabel(entry.keys)}
        </kbd>
      )}
    </li>
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
            data-hint={hit.doc.unpublished ? 'Readers can’t see this copy.' : undefined}
            aria-description={hit.doc.unpublished ? 'Readers can’t see this copy.' : undefined}
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

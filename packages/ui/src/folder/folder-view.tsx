import {
  deviceTag,
  findProperty,
  linkablePages,
  linkTableOf,
  readProperties,
  splitFrontmatter,
  type FolderId,
  type LinkablePage,
  type PageId,
  type Property,
  type PropertyData,
  type RevisionId,
  type searchOperations,
  type SpaceId,
  type spaceOperations,
} from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { AlertTriangle, Columns3, List, Table2, X } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { usePageIndex } from '../data/page-index';
import { revisionQuery, treeQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { ValueField } from '../page/property-rows';
import { propertyIcon, PropertyValueView, type LinkScope } from '../page/property-value';
import { shareCovering } from '../sharing/model';
import { folderLook, FolderTile } from '../shell/folder-look';
import { PageRowIcon, pageTitle } from '../shell/sidebar';
import { useClient } from '../vault/store';
import { useFolderChoice } from './folder-choice';
import {
  cellKey,
  folderColumns,
  shownVersion,
  withColumn,
  type Column,
  type FolderLayout,
} from './folder-model';
import { useCellEdits, type CellEdits, type SaveProperty } from './use-cell-edits';

// A folder's own view (ADR 0006, decision 8; ui-design, Folder view): the
// pages directly in it as a list or a table of their properties, from the
// viewer's search index, so in the versions search shows them.

type Tree = Awaited<ReturnType<typeof spaceOperations.loadTree>>;
type TreePage = Tree['pages'][number];

/** Narrow enough to be a phone, where the layout is the list unless the person chose. */
const NARROW = '(max-width: 899px)';
const useNarrow = () =>
  useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(NARROW);
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
    () => window.matchMedia(NARROW).matches,
  );

const LAYOUTS = [
  { layout: 'list', label: 'List', Icon: List },
  { layout: 'table', label: 'Table', Icon: Table2 },
] as const satisfies readonly { layout: FolderLayout; label: string; Icon: unknown }[];

export function FolderView({
  spaceId,
  folderId,
  save,
}: {
  spaceId: SpaceId;
  folderId: FolderId;
  /** How a cell's edit is saved; by default as the page's draft. */
  save?: SaveProperty | undefined;
}) {
  const ctx = useClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const { index, progress, error, updating, retry } = usePageIndex(ctx);
  const [choice, setChoice] = useFolderChoice(spaceId, folderId);
  const narrow = useNarrow();
  const layout = choice.layout ?? (narrow ? 'list' : 'table');
  const entries = useMemo(
    () => index?.list({ spaceId, folderId, nested: false }) ?? [],
    [index, spaceId, folderId],
  );
  const keys = useMemo(() => index?.keys({ spaceId, folderId }) ?? [], [index, spaceId, folderId]);
  // Hidden columns are kept as tags, worked out once each.
  const tag = useMemo(() => {
    const tags = new Map<string, string>();
    return (folded: string) => {
      let tagged = tags.get(folded);
      if (tagged === undefined) {
        tagged = deviceTag(ctx.identity, 'wikistow.folder-columns', folded);
        tags.set(folded, tagged);
      }
      return tagged;
    };
  }, [ctx]);
  const columns = useMemo(
    () => folderColumns(keys, choice.hidden, tag),
    [keys, choice.hidden, tag],
  );
  const linkable = useMemo(() => (tree ? linkablePages(tree) : null), [tree]);
  const edits = useCellEdits(spaceId, save);

  if (!tree) return <FolderCard>{null}</FolderCard>;
  const folder = tree.folders.find((f) => f.id === folderId);
  if (!folder) {
    return (
      <FolderCard>
        <div className="grid gap-2 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            This folder isn’t here. It may have moved, or no longer be shared with you.
          </p>
          <Link to="/s/$spaceId" params={{ spaceId }} className="text-sm font-bold text-primary">
            Back to the space
          </Link>
        </div>
      </FolderCard>
    );
  }
  const opened = folder.metadata?.opened;
  const { name, emoji, tint } =
    opened?.kind === 'current'
      ? { name: opened.metadata.name, ...folderLook(opened.metadata) }
      : { name: 'Unreadable folder', emoji: '⚠️', tint: 'orange' };
  const role = shareCovering(tree, folderId)?.role ?? tree.space?.role;
  const canEdit = role === 'editor' || role === 'owner';
  const crumbs = crumbsOf(tree, folder.parentId);
  const shownColumns = columns.filter((column) => !column.hidden);
  const pagesHere = tree.pages.filter((p) => p.parentId === folderId).length;

  return (
    <FolderCard>
      <header className="grid gap-4 px-11 pt-9 pb-5 max-[899px]:px-[18px] max-[899px]:pt-6">
        {crumbs.length > 0 && (
          <nav
            aria-label="Breadcrumbs"
            className="truncate text-sm font-bold text-subtle-foreground"
          >
            {crumbs.map((crumb, i) => (
              <span key={i}>
                <Name>{crumb}</Name>
                {i < crumbs.length - 1 && ' › '}
              </span>
            ))}
          </nav>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <FolderTile
            metadata={folder.metadata}
            emoji={emoji}
            tint={tint}
            className="size-14 rounded-tile text-[28px]"
          />
          <div className="grid min-w-0 flex-1 gap-0.5">
            <h1 className="truncate text-[32px] leading-tight font-extrabold">
              <Name>{name}</Name>
            </h1>
            <p className="text-sm text-muted-foreground">
              {pagesHere === 1 ? '1 page' : `${pagesHere} pages`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {layout === 'table' && columns.length > 0 && (
              <ColumnsMenu
                columns={columns}
                onChange={(key, hide) =>
                  setChoice((current) => withColumn(current, key, hide, tag))
                }
              />
            )}
            <div
              role="group"
              aria-label="Show as"
              className="inline-flex rounded-control border border-input p-0.5 text-sm"
            >
              {LAYOUTS.map(({ layout: each, label, Icon }) => (
                <button
                  key={each}
                  type="button"
                  aria-pressed={each === layout}
                  onClick={() => setChoice((current) => ({ ...current, layout: each }))}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-row px-2.5 py-1 font-bold text-muted-foreground hover:tint hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:tint-strong',
                    each === layout && 'bg-muted text-foreground',
                  )}
                >
                  <Icon aria-hidden className="size-4" strokeWidth={1.75} />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-11 pb-10 max-[899px]:px-[18px] max-[899px]:pb-8">
        <IndexStatus
          building={index === undefined && error === null}
          progress={progress}
          updating={updating}
          error={error}
          onRetry={retry}
        />
        {index &&
          (entries.length === 0 ? (
            <Empty>
              {pagesHere === 0
                ? 'No pages in this folder yet.'
                : 'None of the pages in this folder could be opened.'}
              {pagesHere === 0 && canEdit && ' Make one with New page here in the folder’s menu.'}
            </Empty>
          ) : layout === 'list' ? (
            <PageList
              spaceId={spaceId}
              tree={tree}
              entries={entries}
              columns={shownColumns}
              linkable={linkable}
              canEdit={canEdit}
            />
          ) : (
            <>
              <PropertyTable
                spaceId={spaceId}
                tree={tree}
                entries={entries}
                columns={shownColumns}
                linkable={linkable}
                canEdit={canEdit}
                edits={edits}
              />
              {keys.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  None of these pages has properties yet. Properties added to them show here as
                  columns.
                </p>
              )}
            </>
          ))}
      </div>
    </FolderCard>
  );
}

/** The space's name, when this person holds the space, then each folder's down to `parentId`. */
function crumbsOf(tree: Tree, parentId: FolderId | null): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let id = parentId; id !== null && !seen.has(id);) {
    seen.add(id);
    const folder = tree.folders.find((f) => f.id === id);
    if (!folder) break;
    const opened = folder.metadata?.opened;
    names.unshift(opened?.kind === 'current' ? opened.metadata.name : 'Unreadable folder');
    id = folder.parentId;
  }
  const space = tree.space?.metadata?.opened;
  if (tree.space) names.unshift(space?.kind === 'current' ? space.metadata.name : 'Space');
  return names;
}

/** The folder's card, as a page's is, scrolling within the window. */
function FolderCard({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Folder"
      data-region="folder"
      className="@container relative flex h-full min-h-0 flex-col overflow-y-auto rounded-card bg-card shadow-card"
    >
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-control bg-muted px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * Where the index is: being built the first time, with how far it has got;
 * built again behind the one shown; or failed, with a retry. An index that
 * failed to rebuild still shows the one before.
 */
function IndexStatus({
  building,
  progress,
  updating,
  error,
  onRetry,
}: {
  building: boolean;
  progress: searchOperations.IndexProgress | undefined;
  updating: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const total = progress?.total ?? 0;
  const done = progress?.pages ?? 0;
  return (
    <div role="status" className="empty:hidden">
      {error ? (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control bg-muted px-3 py-2 text-sm"
        >
          <AlertTriangle
            aria-hidden
            className="size-4 shrink-0 text-status-draft-foreground"
            strokeWidth={1.75}
          />
          <span className="min-w-0 flex-1">
            Couldn’t read the pages for this folder. {errorMessage(error)}
          </span>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </p>
      ) : building ? (
        <div className="grid gap-2 rounded-control bg-muted px-4 py-4 text-sm">
          <span>
            Reading your pages to list this folder’s…
            {total > 0 && ` ${done} of ${total}`}
          </span>
          <span className="h-1.5 overflow-hidden rounded-full bg-background" aria-hidden>
            <span
              className="block h-full rounded-full bg-primary transition-[width]"
              style={{ width: total > 0 ? `${(done / total) * 100}%` : '0%' }}
            />
          </span>
        </div>
      ) : updating ? (
        <span className="text-xs text-muted-foreground">Updating…</span>
      ) : null}
    </div>
  );
}

/** Which columns show: each as a checkbox, kept on the device for the folder. */
function ColumnsMenu({
  columns,
  onChange,
}: {
  columns: Column[];
  onChange: (key: string, hide: boolean) => void;
}) {
  const hidden = columns.filter((column) => column.hidden).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <Columns3 strokeWidth={1.75} />
          Columns
          {hidden > 0 && <span className="text-muted-foreground">({hidden} hidden)</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        <DropdownMenuLabel>Show columns</DropdownMenuLabel>
        {columns.map((column) => (
          <DropdownMenuCheckboxItem
            key={column.key}
            checked={!column.hidden}
            // Stays open, to show or hide several.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => onChange(column.key, !checked)}
          >
            {column.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What a page in the folder needs to be shown. */
type Listed = {
  spaceId: SpaceId;
  tree: Tree;
  entries: readonly searchOperations.IndexedEntry[];
  columns: Column[];
  linkable: readonly LinkablePage[] | null;
  canEdit: boolean;
};

const scopeOf = (
  spaceId: SpaceId,
  pageId: PageId,
  linkable: readonly LinkablePage[] | null,
  links: ReadonlyMap<string, string>,
  editor: boolean,
): LinkScope => ({ spaceId, selfId: pageId, pages: linkable, links, editor });

/** A page's title as a link that opens it, with its icon, and for editors whether the values are a draft's. */
function TitleLink({
  spaceId,
  entry,
  treePage,
  className,
}: {
  spaceId: SpaceId;
  entry: searchOperations.IndexedEntry;
  treePage: TreePage | undefined;
  className?: string;
}) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <PageRowIcon
        page={{ spaceId, pageId: entry.pageId }}
        emoji={treePage?.emoji ?? null}
        icon={treePage?.icon ?? null}
        symbol={treePage?.symbol ?? null}
      />
      <Link
        to="/s/$spaceId/p/$pageId"
        params={{ spaceId, pageId: entry.pageId }}
        className="min-w-0 truncate font-bold hover:underline focus-visible:underline"
      >
        <Name>{pageTitle(entry.title)}</Name>
      </Link>
      {entry.draft && (
        <span
          data-hint="Shows the draft. Readers see the published version."
          aria-description="Shows the draft. Readers see the published version."
          className="shrink-0 rounded-full bg-status-draft px-2 py-px text-[11.5px] font-bold text-status-draft-foreground"
        >
          ✎ Draft
        </span>
      )}
      {entry.unpublished && (
        <span
          data-hint="Readers here see no version of this copy."
          aria-description="Readers here see no version of this copy."
          className="shrink-0 rounded-full bg-muted px-2 py-px text-[11.5px] font-bold text-subtle-foreground"
        >
          Not published here
        </span>
      )}
    </span>
  );
}

/** The value of `column` on a page, from what the index holds of it. */
const valueIn = (properties: readonly PropertyData[], column: Column) =>
  findProperty(properties, column.key);

/**
 * The pages as a list: each one's title, then the values it has of the
 * columns shown, read-only. The phone's layout unless the person chose.
 */
function PageList({ spaceId, tree, entries, columns, linkable, canEdit }: Listed) {
  return (
    <ul aria-label="Pages" className="grid gap-1">
      {entries.map((entry) => {
        const scope = scopeOf(spaceId, entry.pageId, linkable, new Map(), canEdit);
        const values = columns
          .map((column) => ({ column, property: valueIn(entry.properties, column) }))
          .filter(
            (cell): cell is { column: Column; property: PropertyData } =>
              cell.property !== undefined,
          );
        return (
          <li
            key={entry.pageId}
            className="grid gap-1.5 rounded-control px-3 py-2.5 [--row:1.5rem] hover:tint"
          >
            <TitleLink
              spaceId={spaceId}
              entry={entry}
              treePage={tree.pages.find((p) => p.id === entry.pageId)}
            />
            {values.length > 0 && (
              <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                {values.map(({ column, property }) => (
                  <div key={column.key} className="flex min-w-0 items-center gap-1.5">
                    <dt className="shrink-0 text-[13px] font-semibold text-muted-foreground">
                      {column.label}
                    </dt>
                    <dd className="min-w-0">
                      <PropertyValueView property={property} scope={scope} />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The version of a page a row's cells read: what the index showed, and the version built on. */
type RowVersion = { indexed: RevisionId; basedOn: RevisionId; markdown: string };

/** Where the focus goes back to after a cell's save: the cell, and its control's label. */
type Refocus = { cell: string; label: string | null };

/** The cell whose field is open, with the version it opened on, which it shows and saves against. */
type OpenCell = { id: string; pageId: PageId; version: RowVersion };

/**
 * The pages as a table: the title, then a column per key, which scrolls
 * sideways where it's wider than the card. Editors edit a cell in place.
 */
function PropertyTable({ edits, ...listed }: Listed & { edits: CellEdits }) {
  const { entries, columns, tree } = listed;
  // One field open at a time.
  const [opened, setOpened] = useState<OpenCell | null>(null);
  // The cell that had the focus when its value was set, and the control in
  // it, which get it back once its page is saved and the cell drawn again.
  const refocus = useRef<Refocus | null>(null);
  return (
    <div className="overflow-x-auto rounded-control border border-border">
      <table className="w-full border-collapse text-sm [--row:2rem]">
        <thead>
          <tr className="bg-table-head text-left">
            <th scope="col" className="sticky left-0 z-[1] bg-table-head px-3 py-2 font-bold">
              Title
            </th>
            {columns.map((column) => (
              <ColumnHead key={column.key} column={column} entries={entries} />
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <PageRow
              key={entry.pageId}
              {...listed}
              entry={entry}
              treePage={tree.pages.find((p) => p.id === entry.pageId)}
              edits={edits}
              opened={opened}
              onOpened={setOpened}
              refocus={refocus}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A column's heading: the icon of the type its first value reads as, and its key in sentence case. */
function ColumnHead({
  column,
  entries,
}: {
  column: Column;
  entries: readonly searchOperations.IndexedEntry[];
}) {
  const first = entries
    .map((entry) => valueIn(entry.properties, column))
    .find((property) => property !== undefined);
  const Icon = propertyIcon(first?.type ?? 'text', column.key);
  return (
    <th scope="col" className="px-3 py-2 font-bold whitespace-nowrap">
      <span
        className="inline-flex items-center gap-1.5"
        {...(column.label === column.key ? {} : { 'data-hint': column.key })}
      >
        <Icon aria-hidden className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
        {column.label}
      </span>
    </th>
  );
}

const EMPTY_LINKS: ReadonlyMap<string, string> = new Map();

/**
 * One page's row. An editor's row reads the draft the index holds, or this
 * view's own write since, for which values can change in place; until it
 * has, its cells show what the index holds. A field open on the row keeps
 * the version it opened on, even if the index moves on meanwhile, so what's
 * typed is saved against what was read, or shows a conflict.
 */
function PageRow({
  spaceId,
  entry,
  treePage,
  columns,
  linkable,
  canEdit,
  edits,
  opened,
  onOpened,
  refocus,
}: Listed & {
  entry: searchOperations.IndexedEntry;
  treePage: TreePage | undefined;
  edits: CellEdits;
  opened: OpenCell | null;
  onOpened: (cell: OpenCell | null) => void;
  refocus: RefObject<Refocus | null>;
}) {
  const ctx = useClient();
  const row = useRef<HTMLTableRowElement>(null);
  const page = { spaceId, pageId: entry.pageId };
  // A copy of another page has no draft to change until it is detached.
  const editable = canEdit && treePage !== undefined && treePage.draftHead !== null;
  const shown = shownVersion(entry.revisionId, edits.own.get(entry.pageId));
  const { data: revision } = useQuery({
    ...revisionQuery(ctx, page, 'draft', shown.revisionId),
    enabled: editable,
  });
  const payload = revision?.opened.kind === 'current' ? revision.opened.payload : null;
  const read = shown.markdown ?? payload?.markdown ?? null;
  const version: RowVersion | null =
    opened?.pageId === entry.pageId
      ? opened.version
      : read === null
        ? null
        : { indexed: entry.revisionId, basedOn: shown.revisionId, markdown: read };
  const saving = edits.saving.get(entry.pageId);
  const markdown = saving ?? version?.markdown ?? null;
  const properties = useMemo(
    () => (markdown === null ? null : readProperties(splitFrontmatter(markdown).frontmatter)),
    [markdown],
  );
  const links = payload ? linkTableOf(payload) : EMPTY_LINKS;
  const scope = scopeOf(spaceId, entry.pageId, linkable, links, canEdit);
  // Back to the control used, or one in its place: the field it opened from,
  // or a list's Add field once the item removed has gone. Only if nothing
  // else took the focus meanwhile, as the control it had is gone.
  useEffect(() => {
    const kept = refocus.current;
    if (saving !== undefined || !kept?.cell.startsWith(`${entry.pageId} `)) return;
    refocus.current = null;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const cell = row.current?.querySelector(`[data-cell="${CSS.escape(kept.cell)}"]`);
    const controls = [...(cell?.querySelectorAll<HTMLElement>('button, input') ?? [])];
    const control =
      controls.find((element) => element.getAttribute('aria-label') === kept.label) ??
      controls.findLast((element) => element instanceof HTMLInputElement) ??
      controls[0];
    control?.focus();
  });
  return (
    <tr
      ref={row}
      className="border-t border-border align-top hover:bg-muted/40"
      aria-busy={saving !== undefined}
    >
      <th
        scope="row"
        className="sticky left-0 z-[1] max-w-[18rem] min-w-[12rem] bg-card px-3 py-1.5 text-left font-normal @min-[40rem]:min-w-[15rem]"
      >
        <span className="flex min-h-(--row) items-center">
          <TitleLink spaceId={spaceId} entry={entry} treePage={treePage} />
        </span>
      </th>
      {columns.map((column) => {
        const id = `${entry.pageId} ${column.key}`;
        const value = valueIn(entry.properties, column);
        const problem = edits.problem(entry.pageId, column.key);
        let cell: ReactNode;
        if (!editable || properties === null || version === null) {
          cell = value ? <PropertyValueView property={value} scope={scope} /> : <Blank />;
        } else if (!properties.ok) {
          cell = (
            <OpensPage spaceId={spaceId} pageId={entry.pageId} why={properties.reason}>
              {value ? <PropertyValueView property={value} scope={scope} /> : <Blank />}
            </OpensPage>
          );
        } else {
          const property = findProperty(properties.properties, column.key) ?? missing(column.key);
          const multiline = typeof property.value === 'string' && /[\r\n]/.test(property.value);
          cell =
            saving !== undefined ? (
              <span className="flex min-h-(--row) items-center opacity-60">
                <PropertyValueView property={property} scope={scope} />
              </span>
            ) : property.editable && !multiline ? (
              <ValueField
                property={property}
                label={`${column.label} of ${pageTitle(entry.title)}`}
                scope={scope}
                opened={opened?.id === id}
                onOpened={(open) => onOpened(open ? { id, pageId: entry.pageId, version } : null)}
                onSet={(next) => {
                  const focused = document.activeElement;
                  refocus.current = row.current
                    ?.querySelector(`[data-cell="${CSS.escape(id)}"]`)
                    ?.contains(focused)
                    ? { cell: id, label: focused?.getAttribute('aria-label') ?? null }
                    : null;
                  edits.edit({
                    pageId: entry.pageId,
                    indexed: version.indexed,
                    basedOn: version.basedOn,
                    markdown: version.markdown,
                    column: column.key,
                    key: cellKey(properties.properties, column.key),
                    value: next,
                  });
                  return true;
                }}
              />
            ) : (
              <OpensPage
                spaceId={spaceId}
                pageId={entry.pageId}
                why="This value can’t be changed in the table."
              >
                <PropertyValueView property={property} scope={{ ...scope, editor: true }} />
              </OpensPage>
            );
        }
        return (
          <td key={column.key} data-cell={id} className="max-w-[20rem] min-w-[9rem] px-3 py-1.5">
            {cell}
            {problem && (
              <CellNote
                spaceId={spaceId}
                pageId={entry.pageId}
                conflict={problem.kind === 'conflict'}
                onDismiss={() => edits.dismiss(entry.pageId, column.key)}
              >
                {problem.kind === 'conflict'
                  ? 'Not saved. This page changed since the table read it.'
                  : `Not saved. ${problem.message}`}
              </CellNote>
            )}
          </td>
        );
      })}
    </tr>
  );
}

/** A page without the key: an empty value, which a cell can fill to add it. */
const missing = (key: string): Property => ({
  key,
  type: 'text',
  value: null,
  keySpan: { start: 0, end: 0 },
  valueSpan: { start: 0, end: 0 },
  editable: true,
});

const Blank = () => (
  <span className="flex min-h-(--row) items-center text-muted-foreground">–</span>
);

/** A value the table can't change, which opens the page's draft to change it there. */
function OpensPage({
  spaceId,
  pageId,
  why,
  children,
}: {
  spaceId: SpaceId;
  pageId: PageId;
  why: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const hint = `${why} Opens the page.`;
  return (
    <button
      type="button"
      data-hint={hint}
      aria-description={hint}
      onClick={() =>
        void navigate({
          to: '/s/$spaceId/p/$pageId',
          params: { spaceId, pageId },
          search: { view: 'draft' },
        })
      }
      className="-mx-2 block min-h-(--row) w-[calc(100%+1rem)] rounded-row px-2 py-1 text-left hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

/** Why a cell's edit wasn't saved, under its value, until dismissed. */
function CellNote({
  spaceId,
  pageId,
  conflict,
  onDismiss,
  children,
}: {
  spaceId: SpaceId;
  pageId: PageId;
  conflict: boolean;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <p
      role="alert"
      className="mt-1 flex w-max max-w-64 min-w-full items-start gap-1.5 rounded-row bg-status-draft px-2 py-1 text-xs whitespace-normal text-status-draft-foreground"
    >
      <AlertTriangle aria-hidden className="mt-px size-3.5 shrink-0" strokeWidth={2} />
      <span className="min-w-0 flex-1">
        {children}{' '}
        {conflict && (
          <Link
            to="/s/$spaceId/p/$pageId"
            params={{ spaceId, pageId }}
            search={{ view: 'draft' }}
            className="font-bold underline underline-offset-2"
          >
            Open the draft
          </Link>
        )}
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="grid size-4 shrink-0 place-items-center rounded-full hover:tint"
      >
        <X className="size-3" strokeWidth={2} />
      </button>
    </p>
  );
}

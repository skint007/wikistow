import {
  PageId,
  parsePageQuery,
  propertyLabel,
  runPageQuery,
  searchOperations,
  SpaceId,
  type ClientContext,
  type LinkablePage,
} from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, type ReactNode } from 'react';
import { usePageIndex } from '../data/page-index';
import { treeQuery } from '../data/queries';
import { linkHint } from '../desktop';
import { PropertyValueView, type LinkScope } from './property-value';

// A query table (`wikistow-query`, ADR 0006 decision 7), as its viewer's
// app runs it: over their own search index, so only pages they can open,
// in the versions search shows them, and again each time the index is
// rebuilt, as after a change to a listed page. The block's text is read
// once per change of it, the query run once per index.

/** Where a query runs, and who sees it. */
export type QueryScope = {
  ctx: ClientContext;
  spaceId: string;
  /** The page the block is in. */
  pageId: string;
  /** The pages the viewer can open in the space, which page links in values resolve against. */
  pages: readonly LinkablePage[] | null;
  /** The viewer edits the page, and so sees links that don't resolve as such. */
  editor: boolean;
};

/** What a block's text reads as: a query, or one line saying why it doesn't. */
export const readQuery = (source: string) => parsePageQuery(source);

/**
 * A query block's result: its table, the page as a link then each value as
 * the rows show it, under a caption of how many pages it lists; while the
 * index is first built, a line saying so; a query that can't run (a folder
 * not found) its reason, as `failed` draws it. A block that doesn't read
 * at all is `failed` too, with no index built for it.
 */
export function QueryTable({
  source,
  scope,
  failed,
}: {
  source: string;
  scope: QueryScope;
  failed: (error: string) => ReactNode;
}) {
  const read = useMemo(() => readQuery(source), [source]);
  const spaceId = SpaceId.parse(scope.spaceId);
  const { index, progress, error } = usePageIndex(scope.ctx, { enabled: read.ok });
  const { data: tree } = useQuery({ ...treeQuery(scope.ctx, spaceId), enabled: read.ok });
  const result = useMemo(() => {
    if (!read.ok || !index || !tree) return null;
    const folders = tree.folders.map((folder) => ({
      id: folder.id,
      parentId: folder.parentId,
      name: searchOperations.nameOf(folder.metadata),
    }));
    return runPageQuery(read.query, { pages: index.list({ spaceId }), folders });
  }, [read, index, tree, spaceId]);
  const links = useMemo<LinkScope>(
    () => ({
      spaceId: scope.spaceId,
      selfId: scope.pageId,
      pages: scope.pages,
      // Values are other pages', whose link tables aren't this one's: by title.
      links: new Map(),
      editor: scope.editor,
    }),
    [scope.spaceId, scope.pageId, scope.pages, scope.editor],
  );

  if (!read.ok) return failed(read.error);
  if (result && !result.ok) return failed(result.error);
  if (!result) {
    return (
      <p role="status" className="query-table-status text-xs text-muted-foreground">
        {error && !index
          ? 'This table can’t be shown: the search index couldn’t be built.'
          : progress && progress.total > 0
            ? `Building the search index for this table… ${progress.pages} of ${progress.total} pages`
            : 'Building the search index for this table…'}
      </p>
    );
  }
  const { columns, rows, total } = result;
  return (
    <figure className="query-table">
      <div className="overflow-x-auto rounded-control">
        <table>
          <thead>
            <tr>
              <th>Page</th>
              {columns.map((column, i) => (
                <th key={i}>{propertyLabel(column)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ page, values }) => (
              <tr key={page.pageId}>
                <td>
                  <Link
                    to="/s/$spaceId/p/$pageId"
                    params={{ spaceId, pageId: PageId.parse(page.pageId) }}
                    {...linkHint(page.title)}
                    className="font-semibold text-primary-ink hover:underline"
                  >
                    {page.title || 'Untitled'}
                  </Link>
                </td>
                {values.map((value, i) => (
                  <td key={i}>{value && <PropertyValueView property={value} scope={links} />}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="mt-1 text-xs text-muted-foreground">
        {total === 0
          ? 'No pages match.'
          : rows.length < total
            ? `The first ${rows.length} of ${total} pages.`
            : total === 1
              ? '1 page.'
              : `${total} pages.`}
      </figcaption>
    </figure>
  );
}

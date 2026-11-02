import type { ClientContext, pageOperations } from '@wikistow/client';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { Name } from '@/components/name';
import { usePageIndex } from '../data/page-index';
import { linkHint } from '../desktop';
import { breadcrumb } from '../shell/search-model';
import { pageTitle } from '../shell/sidebar';

/**
 * The pages in this page's space that link to it (`PageIndex.linksTo`),
 * below the page in the reader and the draft view. Each shows its title,
 * opening it, and the folders it is in. It reads the viewer's own search
 * index, so it lists only pages they can open, each in the version they
 * see: an editor's drafts are labelled. Nothing shows while the index is
 * built, or when no page links here.
 */
export function LinkedFrom({ ctx, page }: { ctx: ClientContext; page: pageOperations.PageRef }) {
  const { index } = usePageIndex(ctx);
  const heading = useId();
  const linking = index?.linksTo(page.spaceId, page.pageId) ?? [];
  if (linking.length === 0) return null;
  return (
    <section aria-labelledby={heading} className="grid gap-2 border-t pt-4">
      <h2 id={heading} className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
        Linked from
      </h2>
      <ul className="grid gap-1 text-sm">
        {linking.map((entry) => {
          // Only the folders: every page here is in this space.
          const folders = entry.path.slice(entry.path.length - entry.folderIds.length);
          return (
            <li key={entry.pageId} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <Link
                to="/s/$spaceId/p/$pageId"
                params={{ spaceId: entry.spaceId, pageId: entry.pageId }}
                // A draft opens as the draft that links here.
                search={entry.draft ? { view: 'draft' } : {}}
                {...linkHint(pageTitle(entry.title))}
                className="font-semibold text-primary-ink hover:underline"
              >
                <Name>{pageTitle(entry.title)}</Name>
              </Link>
              {(entry.draft || entry.unpublished) && (
                <span
                  data-hint={entry.unpublished ? 'Readers can’t see this copy.' : undefined}
                  aria-description={entry.unpublished ? 'Readers can’t see this copy.' : undefined}
                  className="rounded-full bg-status-draft px-2 text-xs font-bold text-status-draft-foreground"
                >
                  {entry.draft ? 'Draft' : 'Unpublished'}
                </span>
              )}
              {folders.length > 0 && (
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  <Name>{breadcrumb(folders)}</Name>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

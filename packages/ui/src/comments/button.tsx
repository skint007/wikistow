import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useNeedsConnection } from '../shell/availability';
import { useClient } from '../vault/store';
import { commentsBadge, countLabel } from './model';
import { pageCommentsQuery } from './queries';
import { commentsStore, useCommentsStore, type CommentsPage } from './store';

/**
 * Tell the comments panel which page and view are on screen while they
 * are (`CommentsPage`), so it shows that page's threads and box.
 */
export function useCommentsPage(page: CommentsPage) {
  const { spaceId, pageId, view, region, editor, published } = page;
  const { revisionId, audience } = page.version;
  useEffect(() => {
    commentsStore.setPage({
      spaceId,
      pageId,
      view,
      region,
      version: { revisionId, audience },
      editor,
      published,
    });
    return () => {
      if (commentsStore.get().page?.pageId === pageId) commentsStore.setPage(null);
    };
  }, [spaceId, pageId, view, region, revisionId, audience, editor, published]);
}

/**
 * The page's **Comments** button (ADR 0014, decisions 8 and 13): how many
 * open threads this person sees, with a dot when any has a comment from
 * someone else since they last opened the page's comments. Offline it says
 * it needs the connection, and still closes the panel.
 */
export function CommentsButton({ page }: { page: CommentsPage }) {
  const ctx = useClient();
  const { open } = useCommentsStore();
  const needs = useNeedsConnection();
  const { data } = useQuery(pageCommentsQuery(ctx, page, { offline: needs.offline }));
  const badge = data
    ? commentsBadge(data.threads, { me: ctx.identity.public.id, seenAt: data.seenAt })
    : { count: 0, fresh: false };
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={open}
      aria-label={countLabel(badge.count) + (badge.fresh ? ', new' : '')}
      className="relative"
      {...(open
        ? { onClick: () => commentsStore.close() }
        : needs.click(() => commentsStore.open()))}
    >
      <MessageSquare strokeWidth={1.75} />
      {/* Beside the chat's column the card is narrow: the icon and count say it. */}
      <span className="max-[899px]:sr-only @max-[760px]:sr-only">Comments</span>
      {badge.count > 0 && <span className="text-subtle-foreground">{badge.count}</span>}
      {badge.fresh && (
        <span aria-hidden className="absolute top-1 right-1 size-2 rounded-full bg-update-dot" />
      )}
    </Button>
  );
}

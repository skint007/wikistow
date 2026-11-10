import { commentOperations, sharingOperations, type SpaceId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { treeQuery } from '../data/queries';
import { peopleQuery } from '../sharing/people';
import { pageTitle } from '../shell/sidebar';
import { sharingMessage } from '../sharing/messages';
import { useClient } from '../vault/store';
import { commentsChanged } from './queries';

/**
 * Under an owner's operation that a comment stopped (ADR 0014, decision
 * 7): which page it is on, and **Delete comment**, which owners may do,
 * after which the operation can be tried again. Nothing for any other
 * failure.
 */
export function UnreadableCommentFix({ failure, spaceId }: { failure: unknown; spaceId: SpaceId }) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  // Only a comment from a newer app is named by its author: its signature
  // checked out. One that didn't open names someone it may not be by.
  const newer =
    failure instanceof sharingOperations.UnreadableComment && failure.newerFormat ? failure : null;
  const { data: people } = useQuery({
    ...peopleQuery(ctx, newer ? [newer.authorId] : []),
    enabled: newer !== null,
  });
  const [state, setState] = useState<{ for: unknown; said: string; failed: boolean } | null>(null);
  if (!(failure instanceof sharingOperations.UnreadableComment)) return null;
  const said = state?.for === failure ? state : null;
  const page = tree?.pages.find((p) => p.id === failure.pageId);
  const author = newer && people?.get(newer.authorId)?.name;
  const remove = async () => {
    try {
      await commentOperations.deleteComment(ctx, failure.commentId);
      commentsChanged(queryClient, [failure.pageId]);
      setState({ for: failure, said: 'Deleted. Try again now.', failed: false });
    } catch (caught) {
      setState({ for: failure, said: sharingMessage(caught), failed: true });
    }
  };
  return (
    <div className="grid gap-2 rounded-control bg-muted p-3 text-sm">
      <p>
        It’s on{' '}
        {page ? (
          <>
            “<Name>{pageTitle(page.title)}</Name>”
          </>
        ) : (
          'a page in the trash'
        )}
        {author && (
          <>
            , by <Name>{author}</Name>
          </>
        )}
        .
      </p>
      {said && !said.failed ? (
        <p role="status">{said.said}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="destructive" onClick={() => void remove()}>
            Delete comment
          </Button>
          {said && (
            <span role="alert" className="text-destructive">
              {said.said}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

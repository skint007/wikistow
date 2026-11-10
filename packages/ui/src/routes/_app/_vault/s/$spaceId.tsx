import { SpaceId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { ChatColumn, useChatColumn } from '../../../../ai/chat-column';
import { CommentsColumn, useCommentsColumn } from '../../../../comments/panel';
import { treeQuery } from '../../../../data/queries';
import { OwnerConfirm } from '../../../../sharing/owner-confirm';
import { useShellSpace } from '../../../../shell/app-shell';
import { useOldAddress } from '../../../../shell/old-address';
import { Sidebar } from '../../../../shell/sidebar';
import { useClient } from '../../../../vault/store';

export const Route = createFileRoute('/_app/_vault/s/$spaceId')({
  params: {
    parse: ({ spaceId }) => ({ spaceId: SpaceId.parse(spaceId) }),
    stringify: ({ spaceId }) => ({ spaceId }),
  },
  component: SpaceLayout,
});

/**
 * The sidebar card beside the page card, and the assistant's or the page's
 * comments beside that while one is open; on phones the sidebar lives in
 * the drawer, and the assistant or comments over the page. A new owner is
 * asked to confirm who added them first.
 */
function SpaceLayout() {
  const { spaceId } = Route.useParams();
  useShellSpace(spaceId);
  useLeaveWhenGone(spaceId);
  const chat = useChatColumn();
  const comments = useCommentsColumn();
  return (
    <div
      className={cn(
        'grid h-full gap-3.5 min-[900px]:grid-cols-[var(--sidebar-width)_1fr]',
        (chat || comments) && 'min-[900px]:grid-cols-[var(--sidebar-width)_1fr_380px]',
      )}
    >
      <div data-region="sidebar" className="hidden min-h-0 min-[900px]:block">
        <Sidebar spaceId={spaceId} />
      </div>
      <Outlet />
      <ChatColumn />
      <CommentsColumn />
      <OwnerConfirm key={spaceId} spaceId={spaceId} />
    </div>
  );
}

/**
 * Send someone viewing a space home once the server no longer shows it to
 * them: deleted, or no longer shared with them. The home route opens their
 * first space, which is their home space. An old address of a page or
 * folder a move took into another space they can open goes there instead
 * (`useOldAddress`, which the page or folder follows).
 */
function useLeaveWhenGone(spaceId: SpaceId) {
  const ctx = useClient();
  const navigate = useNavigate();
  // A cached error stays while the tree loads again, so only a settled one counts.
  const { error, isFetching } = useQuery(treeQuery(ctx, spaceId));
  const gone = !isFetching && error instanceof ApiError && error.code === 'not-found';
  const { pageId, folderId } = useParams({ strict: false });
  const moved = useOldAddress({ spaceId, nodeId: pageId ?? folderId }, gone, { follow: false });
  useEffect(() => {
    if (gone && !moved) void navigate({ to: '/' });
  }, [gone, moved, navigate]);
}

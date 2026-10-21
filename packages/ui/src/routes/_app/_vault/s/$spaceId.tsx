import { SpaceId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { ChatColumn, useChatColumn } from '../../../../ai/chat-column';
import { treeQuery } from '../../../../data/queries';
import { OwnerConfirm } from '../../../../sharing/owner-confirm';
import { useShellSpace } from '../../../../shell/app-shell';
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
 * The sidebar card beside the page card, and the assistant's beside that
 * while it's open; on phones the sidebar lives in the drawer, and the
 * assistant over the page. A new owner is asked to confirm who added them first.
 */
function SpaceLayout() {
  const { spaceId } = Route.useParams();
  useShellSpace(spaceId);
  useLeaveWhenGone(spaceId);
  const chat = useChatColumn();
  return (
    <div
      className={cn(
        'grid h-full gap-3.5 min-[900px]:grid-cols-[280px_1fr]',
        chat && 'min-[900px]:grid-cols-[280px_1fr_380px]',
      )}
    >
      <div data-region="sidebar" className="hidden min-h-0 min-[900px]:block">
        <Sidebar spaceId={spaceId} />
      </div>
      <Outlet />
      <ChatColumn />
      <OwnerConfirm key={spaceId} spaceId={spaceId} />
    </div>
  );
}

/**
 * Send someone viewing a space home once the server no longer shows it to
 * them: deleted, or no longer shared with them. The home route opens their
 * first space, which is their home space.
 */
function useLeaveWhenGone(spaceId: SpaceId) {
  const ctx = useClient();
  const navigate = useNavigate();
  const { error } = useQuery(treeQuery(ctx, spaceId));
  const gone = error instanceof ApiError && error.code === 'not-found';
  useEffect(() => {
    if (gone) void navigate({ to: '/' });
  }, [gone, navigate]);
}

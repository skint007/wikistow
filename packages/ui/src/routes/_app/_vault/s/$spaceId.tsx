import { SpaceId } from '@wikistow/client';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { ChatColumn, useChatColumn } from '../../../../ai/chat-column';
import { OwnerConfirm } from '../../../../sharing/owner-confirm';
import { useShellSpace } from '../../../../shell/app-shell';
import { Sidebar } from '../../../../shell/sidebar';

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

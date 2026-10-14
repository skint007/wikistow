import type { PageId, SpaceId } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { chatStore, useChatStore } from './chat';
import { ChatPanel } from './chat-panel';
import { aiStatusQuery } from './session';

/** Wide enough for the chat beside the page, rather than over it. */
const WIDE = '(min-width: 1200px)';

const useWide = () =>
  useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
    () => window.matchMedia(WIDE).matches,
  );

/** Whether the chat takes a column beside the page now. */
export function useChatColumn(): boolean {
  const { open } = useChatStore();
  return useWide() && open;
}

/** The chat while it's open: a column beside the page on wide screens, else a sheet over it. */
export function ChatColumn() {
  const { open } = useChatStore();
  const wide = useWide();
  if (!open) return null;
  const close = () => chatStore.setOpen(false);
  if (wide) return <ChatPanel onClose={close} />;
  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent side="right" className="h-full p-0" showCloseButton={false}>
        <DialogTitle className="sr-only">Assistant</DialogTitle>
        <ChatPanel onClose={close} />
      </DialogContent>
    </Dialog>
  );
}

/** Opens and closes the chat, when the server has AI. */
export function AssistantButton() {
  const { data } = useQuery(aiStatusQuery);
  const { open } = useChatStore();
  if (!data?.enabled) return null;
  return (
    <Button variant="ghost" size="sm" aria-pressed={open} onClick={() => chatStore.setOpen(!open)}>
      <Sparkles strokeWidth={1.75} /> <span className="max-[899px]:sr-only">Assistant</span>
    </Button>
  );
}

/** Offer the page on screen to the chat while it's shown. It goes only if the person includes it. */
export function useChatPage(spaceId: SpaceId, pageId: PageId, title: string | null) {
  useEffect(() => {
    chatStore.setPage({ spaceId, pageId, title: title ?? 'Untitled' });
    return () => {
      if (chatStore.get().page?.pageId === pageId) chatStore.setPage(null);
    };
  }, [spaceId, pageId, title]);
}

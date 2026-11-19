import type { PagePayload } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { PLAIN, useClient } from '../vault/store';
import { MergeView } from '../page/merge/merge-view';
import { theirsOf } from '../page/merge/open-merge';
import { AgentChat, useChatStore, type Merging } from './chat';

/**
 * Merge… for the chat's approved edits, wherever the chat may be shown:
 * kept apart from the panel, so it opens with the panel closed and lasts
 * while the panel moves between a column and a sheet. `layout` names how
 * the chat is shown; when it changes, Merge… goes back on top of a sheet
 * opened since. Rendered after the panel, so it does so after the sheet opens.
 */
export function ChatMerges({ layout }: { layout: string }) {
  const { chat } = useChatStore();
  return chat instanceof AgentChat ? <AgentMerges chat={chat} layout={layout} /> : null;
}

function AgentMerges({ chat, layout }: { chat: AgentChat; layout: string }) {
  const { merging, agent } = useSyncExternalStore(chat.subscribe, chat.state);
  useEffect(() => chat.holdMerges(), [chat]);
  if (!merging) return null;
  return (
    <ChatMerge
      key={merging.ask}
      merging={merging}
      layout={layout}
      agentName={agent.name}
      onSettle={(payload) => chat.settleMerge(payload)}
    />
  );
}

/**
 * **Merge…** for an approved chat edit that overlaps what changed on the
 * page since it was proposed (ADR 0015 decision 8): the page's own merge
 * view, in a dialog over the chat, with the assistant's edit as the side
 * merged in. **Save merged draft** hands the payload on, to be saved as the
 * assistant's; **Cancel**, Escape or ending the chat saves nothing.
 */
export function ChatMerge({
  merging,
  agentName,
  onSettle,
  layout = '',
}: {
  merging: Merging;
  agentName: string;
  onSettle: (payload: PagePayload | null) => void;
  layout?: string;
}) {
  const inside = useRef<HTMLDivElement>(null);
  // Once: Escape closes the dialog, and its close event, a task later, would close it again.
  const settled = useRef(false);
  const settle = (payload: PagePayload | null) => {
    if (settled.current) return;
    settled.current = true;
    onSettle(payload);
  };
  const shownIn = useRef(layout);
  useEffect(() => {
    if (shownIn.current === layout) return;
    shownIn.current = layout;
    // Opened again at once, it goes on top; its close event, a task later, finds it open and is let be.
    const dialog = inside.current?.closest('dialog');
    if (!dialog?.open) return;
    dialog.close();
    dialog.showModal();
  }, [layout]);
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { opened } = merging;
  const { data: theirs } = useQuery({
    // A contact's name: dropped when the vault locks.
    queryKey: [PLAIN, 'chat-merge-theirs', opened.theirs.authorId, opened.theirs.live],
    queryFn: () => theirsOf(ctx, queryClient, opened.theirs),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && settle(null)}>
      <DialogContent dialogClassName="sm:max-w-3xl" closesOnBackdrop={false}>
        <DialogTitle className="sr-only">Merge {agentName}’s edit</DialogTitle>
        <div ref={inside} hidden />
        {theirs ? (
          <MergeView
            merge={opened.merge}
            theirs={theirs}
            yours={{ kind: 'assistant', name: agentName }}
            pictures={{ ctx, page: opened.page, attachments: opened.attachments }}
            onCancel={() => settle(null)}
            onSave={settle}
          />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Merging…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

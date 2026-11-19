import {
  checkPayloadSize,
  PageTooLarge,
  withoutLinkTable,
  type PagePayload,
} from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { PLAIN, useClient } from '../vault/store';
import { MergeView } from '../page/merge/merge-view';
import { theirsOf } from '../page/merge/open-merge';
import { AgentChat, useChatStore, type Merging } from './chat';

/**
 * Merge… for the chat's approved edits, wherever the chat may be shown:
 * kept apart from the panel, so it opens with the panel closed and lasts
 * while the panel moves between a column and a sheet.
 */
export function ChatMerges() {
  const { chat } = useChatStore();
  return chat instanceof AgentChat ? <AgentMerges chat={chat} /> : null;
}

function AgentMerges({ chat }: { chat: AgentChat }) {
  const { merging, agent } = useSyncExternalStore(chat.subscribe, chat.state);
  useEffect(() => chat.holdMerges(), [chat]);
  if (!merging) return null;
  return (
    <ChatMerge
      key={merging.ask}
      merging={merging}
      agentName={agent.name}
      onSettle={(payload) => chat.settleMerge(payload)}
    />
  );
}

/** Whether the chat's Merge… is open now. */
export function useMergeOpen(): boolean {
  const { chat } = useChatStore();
  const agent = chat instanceof AgentChat ? chat : null;
  const subscribe = useCallback(
    (listener: () => void) => agent?.subscribe(listener) ?? (() => {}),
    [agent],
  );
  return useSyncExternalStore(subscribe, () => (agent?.state().merging ?? null) !== null);
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
}: {
  merging: Merging;
  agentName: string;
  onSettle: (payload: PagePayload | null) => void;
}) {
  // Once: Escape closes the dialog, and its close event, a task later, would close it again.
  const settled = useRef(false);
  // Too large to save, as an Edit… can make it: said here, so what was chosen stays to shorten.
  const [tooLarge, setTooLarge] = useState<string | null>(null);
  const settle = (payload: PagePayload | null) => {
    if (settled.current) return;
    if (payload) {
      try {
        checkPayloadSize(withoutLinkTable(payload));
      } catch (error) {
        if (!(error instanceof PageTooLarge)) throw error;
        setTooLarge(`${error.message} Go back and make it shorter.`);
        return;
      }
    }
    settled.current = true;
    onSettle(payload);
  };
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
        {tooLarge && (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {tooLarge}
          </p>
        )}
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

import type { PagePayload } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useClient } from '../vault/store';
import { MergeView } from '../page/merge/merge-view';
import { theirsOf } from '../page/merge/open-merge';
import type { Merging } from './chat';

/**
 * **Merge…** for an approved chat edit that overlaps what changed on the
 * page since it was proposed (ADR 0015 decision 8): the page's own merge
 * view, in a dialog over the chat, with the assistant's edit as the side
 * merged in. **Save merged draft** hands the payload on, to be saved as the
 * assistant's; **Cancel**, Escape or closing the chat saves nothing.
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
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { opened } = merging;
  const { data: theirs } = useQuery({
    queryKey: ['chat-merge-theirs', opened.theirs.authorId, opened.theirs.live],
    queryFn: () => theirsOf(ctx, queryClient, opened.theirs),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onSettle(null)}>
      <DialogContent dialogClassName="sm:max-w-3xl" closesOnBackdrop={false}>
        <DialogTitle className="sr-only">Merge {agentName}’s edit</DialogTitle>
        {theirs ? (
          <MergeView
            merge={opened.merge}
            theirs={theirs}
            yours={{ kind: 'assistant', name: agentName }}
            pictures={{ ctx, page: opened.page, attachments: opened.attachments }}
            onCancel={() => onSettle(null)}
            onSave={onSettle}
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

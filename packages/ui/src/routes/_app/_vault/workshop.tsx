import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';
import { AgentChat, useChatStore } from '../../../ai/chat';
import { ChatColumn, useChatColumn } from '../../../ai/chat-column';
import { aiStatusQuery } from '../../../ai/session';
import { usePlugins } from '../../../plugins/runtime';
import { draftsQuery, DraftsList } from '../../../workshop/drafts';
import type { Workshop } from '../../../workshop/workshop';
import { WorkshopChat } from '../../../workshop/workshop-chat';
import { WorkshopDisclosure } from '../../../workshop/workshop-panel';
import { WorkshopPreview } from '../../../workshop/workshop-preview';

export const Route = createFileRoute('/_app/_vault/workshop')({
  component: WorkshopPage,
});

/**
 * The plugin workshop (#257, ADR 0004): the person's plugin drafts, then
 * a workshop's preview in the main area, and its conversation in the
 * assistant's column beside it. In the browser and the desktop app, but
 * not in safe mode, where no plugin code runs.
 */
function WorkshopPage() {
  const { chat } = useChatStore();
  const { data: status, error } = useQuery(aiStatusQuery);
  const { safeMode } = usePlugins();
  const column = useChatColumn();
  const workshop = chat instanceof WorkshopChat ? chat : null;
  return (
    <div
      className={cn(
        'grid h-full gap-3.5',
        workshop && column && 'min-[900px]:grid-cols-[1fr_380px]',
      )}
    >
      <section
        data-region="workshop"
        className="h-full min-h-0 overflow-y-auto rounded-card bg-card shadow-card"
      >
        <div className="mx-auto grid w-full max-w-[960px] gap-6 px-11 py-10 max-[899px]:px-[18px] max-[899px]:py-8">
          <h1 className="text-[32px] leading-tight font-extrabold">Plugin workshop</h1>
          {safeMode && !workshop ? (
            <p className="text-sm text-muted-foreground">
              Plugins are off in safe mode, so the workshop is too. Turn them back on in Settings →
              Plugins.
            </p>
          ) : error ? (
            <p className="text-sm text-destructive">Couldn’t check whether AI is set up.</p>
          ) : !status ? null : !status.enabled ? (
            <p className="text-sm text-muted-foreground">
              AI isn’t set up on this server, so there’s no workshop. The person who runs the server
              can connect an AI provider.
            </p>
          ) : (
            <>
              {!workshop && (
                <div className="grid max-w-prose gap-4">
                  <p className="text-sm">
                    Describe a plugin, such as a theme or a calculator block, and the assistant
                    writes it, builds it and runs it here, against sample pages of the workshop’s
                    own. Ask for changes and see each version at once. Your pages don’t change, and
                    nothing is installed until you publish a version yourself.
                  </p>
                  <WorkshopDisclosure host={status.host} />
                  {chat instanceof AgentChat && (
                    <p className="text-sm text-muted-foreground">
                      Opening a draft ends the conversation with your assistant.
                    </p>
                  )}
                </div>
              )}
              <DraftsList open={workshop?.workshop.draftId ?? null} />
              {workshop && (
                <WorkshopDraft key={workshop.workshop.id} workshop={workshop.workshop} />
              )}
            </>
          )}
        </div>
      </section>
      {workshop && <ChatColumn />}
    </div>
  );
}

/** The open workshop's preview; the drafts list follows its saves. */
function WorkshopDraft({ workshop }: { workshop: Workshop }) {
  const queryClient = useQueryClient();
  const { draft } = useSyncExternalStore(workshop.subscribe, workshop.state);
  const changedAt = draft?.updatedAt;
  const name = draft?.name;
  useEffect(() => {
    if (changedAt) void queryClient.invalidateQueries({ queryKey: draftsQuery.queryKey });
  }, [queryClient, changedAt, name]);
  return <WorkshopPreview workshop={workshop} />;
}

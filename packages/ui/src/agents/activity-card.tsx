import type { ClientContext, spaceOperations } from '@wikistow/client';
import { Bot } from 'lucide-react';
import { Name } from '@/components/name';
import { AgentName, agentPersonName } from './agent-name';
import { ago } from './model';

type Activity = NonNullable<Awaited<ReturnType<typeof spaceOperations.loadTree>>['agentActivity']>;

/**
 * The most recent agent edit in the space, pinned to the bottom of the
 * sidebar: which agent, on which page, and whether only the draft changed.
 * Only editors are told, so readers never see it.
 */
export function AgentActivityCard({
  ctx,
  activity,
  title,
  onOpen,
}: {
  ctx: Pick<ClientContext, 'contacts'>;
  activity: Activity;
  /** The page's decrypted title. */
  title: string;
  onOpen: () => void;
}) {
  return (
    <section aria-label="Agent activity" className="shrink-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-2.5 rounded-control bg-muted p-3 text-left text-sm hover:tint active:tint-strong"
      >
        <Bot aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={1.75} />
        <span className="grid min-w-0 gap-0.5">
          <span className="text-xs font-bold text-subtle-foreground">Agent activity</span>
          <span className="truncate font-bold">
            <AgentName
              ctx={ctx}
              agentId={activity.agentId}
              serverName={activity.agentName}
              person={agentPersonName(ctx, activity.personId, activity.personName)}
              told
            />
          </span>
          <span className="truncate">
            edited <Name>{title}</Name> · {ago(activity.at, new Date())}
          </span>
          <span className="text-xs text-muted-foreground">
            {activity.draftOnly ? 'Draft only, not published yet' : 'In the published version'}
          </span>
        </span>
      </button>
    </section>
  );
}

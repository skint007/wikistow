import type { ShareId, SpaceId } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { AddAgentDialog } from '../../../../agents/add-agent-dialog';
import { AgentCard, type ListedAgent } from '../../../../agents/agent-card';
import { ownAgentName } from '../../../../agents/agent-name';
import { EnrollCommand } from '../../../../agents/enroll-command';
import { agentMessage } from '../../../../agents/messages';
import { sharesItHeld } from '../../../../agents/model';
import { RevokeDialog } from '../../../../agents/revoke-dialog';
import { aiStatusQuery } from '../../../../ai/session';
import { agentGroupsQuery, agentsQuery } from '../../../../data/queries';
import { RotateKeysDialog } from '../../../../sharing/rotate-keys-dialog';
import { useClient } from '../../../../vault/store';

export const Route = createFileRoute('/_app/_vault/agents/')({ component: Agents });

type ShareRef = { spaceId: SpaceId; shareId: ShareId };

/**
 * This person's agents (protocol section 9): each CLI they enrolled and
 * each chat assistant this app runs, live or revoked, with what it can
 * reach. Adding one, changing what it reaches
 * and revoking it all happen here; only a person manages their agents.
 */
function Agents() {
  const ctx = useClient();
  const { data: agents, error } = useQuery(agentsQuery(ctx));
  const { data: ai } = useQuery(aiStatusQuery);
  const { data: groups } = useQuery(agentGroupsQuery(ctx));
  const [adding, setAdding] = useState<'cli' | 'app' | null>(null);
  // The agent being revoked, with the folders its groups gave it, kept as they were
  // when the dialog opened: the server stops listing a revoked agent's groups.
  const [revoking, setRevoking] = useState<
    (ListedAgent & { viaGroups: readonly ShareRef[] }) | null
  >(null);
  const [rotating, setRotating] = useState<ShareRef | null>(null);
  // Shares given new keys from the revoke dialog, which it marks done.
  const [rotated, setRotated] = useState<ReadonlySet<string>>(new Set());
  // Live ones first, each group oldest first, as the server lists them.
  const sorted = agents && [
    ...agents.filter((a) => a.revokedAt === null),
    ...agents.filter((a) => a.revokedAt !== null),
  ];

  return (
    <section className="h-full min-h-0 overflow-y-auto rounded-card bg-card shadow-card">
      <div className="mx-auto grid w-full max-w-[720px] gap-6 px-11 py-10 max-[899px]:px-[18px] max-[899px]:py-8">
        <header className="flex flex-wrap items-end gap-3">
          <div className="grid flex-1 gap-1">
            <h1 className="text-[32px] leading-tight font-extrabold">Agents</h1>
            <p className="text-sm text-muted-foreground">
              Command-line tools, and assistants in the page chat, that read and write here for you,
              each with its own keys. An agent never does more than you can, and only where you let
              it.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* A chat assistant needs the server's AI, so it's offered only then. */}
            {ai?.enabled && (
              <Button variant="secondary" onClick={() => setAdding('app')}>
                <Plus strokeWidth={1.75} /> Add a chat assistant
              </Button>
            )}
            <Button onClick={() => setAdding('cli')}>
              <Plus strokeWidth={1.75} /> Add an agent
            </Button>
          </div>
        </header>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {agentMessage(error)}
          </p>
        )}
        {!agents && !error && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading your agents…
          </p>
        )}
        {sorted?.length === 0 && (
          <div className="grid gap-2 text-sm text-muted-foreground">
            <p>
              You haven’t added an agent yet. In a terminal on the computer it runs on, run this
              command, then choose Add an agent:
            </p>
            <EnrollCommand />
          </div>
        )}
        <ul aria-label="Your agents" className="grid gap-3">
          {sorted?.map((agent) => (
            <AgentCard
              key={agent.agentId}
              agent={agent}
              onRevoke={() =>
                setRevoking({
                  ...agent,
                  viaGroups: (groups ?? []).flatMap((group) =>
                    group.agentId === agent.agentId && group.confirmed
                      ? group.shares.map(({ shareId }) => ({ spaceId: group.spaceId, shareId }))
                      : [],
                  ),
                })
              }
            />
          ))}
        </ul>
      </div>
      <AddAgentDialog
        // A new one each time, so a chat assistant's form never shows for a CLI's.
        key={adding ?? 'closed'}
        open={adding !== null}
        onOpenChange={(open) => !open && setAdding(null)}
        inApp={adding === 'app'}
      />
      <RevokeDialog
        agent={
          revoking && {
            agentId: revoking.agentId,
            name: ownAgentName(ctx, revoking.agentId) ?? revoking.name,
            // The record's shares, which the server can't hide, then the server's,
            // with those of the groups it was confirmed in.
            shares: sharesItHeld<ShareRef>(
              ctx.contacts.book.payloads.shared.agents.find(
                (entry) => entry.enrollment.agent.id === revoking.agentId,
              )?.shares ?? [],
              [...revoking.grants, ...revoking.viaGroups],
            ),
          }
        }
        // Out of the way while a share gets new keys, then back with the rest.
        paused={rotating !== null}
        rotated={rotated}
        onClose={() => {
          setRevoking(null);
          setRotated(new Set());
        }}
        onRotate={setRotating}
      />
      {rotating && (
        <RotateKeysDialog
          spaceId={rotating.spaceId}
          shareId={rotating.shareId}
          onDone={() => setRotated((done) => new Set([...done, rotating.shareId]))}
          onClose={() => setRotating(null)}
        />
      )}
    </section>
  );
}

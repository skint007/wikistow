import { agentLabelName, type ClientContext } from '@wikistow/client';
import { Name } from '@/components/name';
import type { AgentPerson } from './model';

export { agentPersonName } from './model';

/**
 * The name this person gave one of their own agents, from their contacts
 * record, which the server can't change; null for anyone else's agent, or
 * one whose entry has no usable name.
 */
export const ownAgentName = (
  ctx: Pick<ClientContext, 'contacts'>,
  agentId: string,
): string | null => agentLabelName(agentId, ctx.contacts.book.payloads.shared.agents);

/**
 * An agent the way the interface names one (protocol section 9.5): "agent
 * (for person)". The person's own agent goes by the name in their record;
 * someone else's by the name the server has, in quotes and marked as the
 * server's, with the person it acts for (`agentPersonName`), whose name is
 * marked the same way when it is only the server's. `person` is null when
 * that person can't be named. `brief` shows only the agent's
 * name, as in a pill, and leaves whom it is for to assistive technology.
 *
 * `told` is for a claim only the server makes, that this agent wrote
 * something (the page pill, the activity card), which nothing signed backs.
 * There only an agent on this person's own record is named, by their own
 * name for it; any other is just "an agent", so the server can't put a
 * name of its choosing on the edit.
 */
export function AgentName({
  ctx,
  agentId,
  serverName,
  person,
  brief = false,
  told = false,
}: {
  ctx: Pick<ClientContext, 'contacts'>;
  agentId: string;
  serverName: string;
  person: AgentPerson | null;
  brief?: boolean;
  told?: boolean;
}) {
  const own = ownAgentName(ctx, agentId);
  const forWhom = (
    <span className={brief ? 'sr-only' : undefined}>
      {' '}
      (for{' '}
      {own !== null ? (
        'you'
      ) : person === null ? (
        'someone'
      ) : person.served ? (
        <span title="Their name as the server has it">
          “<Name>{person.name}</Name>”
        </span>
      ) : (
        <Name>{person.name}</Name>
      )}
      )
    </span>
  );
  if (own !== null) {
    return (
      <span>
        <Name>{own}</Name>
        {forWhom}
      </span>
    );
  }
  if (told) {
    return (
      <span>
        an agent
        {forWhom}
      </span>
    );
  }
  return (
    <span title="The name its person gave it, as the server has it">
      “<Name>{serverName}</Name>”{forWhom}
    </span>
  );
}

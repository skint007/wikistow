import {
  agentOperations,
  ownerOperations,
  sharingOperations,
  spaceKeys,
  type ClientContext,
} from '@wikistow/client';
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Name } from '@/components/name';
import { cn } from '@/lib/utils';
import { agentMessage } from '../agents/messages';
import { picksOffRecord } from '../agents/model';
import { resealAgents } from '../commands/agent-commands';
import { runCommand } from '../commands/command';
import { requirementsHere } from '../commands/ui-commands';
import { spacesQuery } from '../data/queries';
import { PLAIN, useClient } from '../vault/store';
import { nameOf } from './names';
import { askAgain } from './owner-standing';

type Work = 'confirm-owner' | 'finish-removal' | 'renew-keys' | 'rotate-for-agents';

const WORK: Record<Work, string> = {
  'confirm-owner': 'confirm who made you an owner',
  'finish-removal': 'finish removing an owner',
  'renew-keys': 'renew the keys you were handed',
  'rotate-for-agents': 'give new keys to a folder an agent kept the keys of',
};

/**
 * What each owned space still waits on from this person (protocol sections
 * 6.5 and 7.6), worked out once per unlock: a co-owner to confirm, an
 * owner removal that didn't go through, or a transfer's key renewal. Also
 * how many spaces couldn't be checked.
 */
const pendingOwnerWorkQuery = (ctx: ClientContext, queryClient: QueryClient) =>
  queryOptions({
    queryKey: [PLAIN, 'pending-owner-work'],
    queryFn: async () => {
      const spaces = await queryClient.fetchQuery(spacesQuery(ctx));
      const found = await Promise.all(
        spaces
          .filter((space) => space.role === 'owner')
          .map(async (space) => {
            // One space that can't be worked out mustn't hide the others.
            try {
              // Works the space out afresh, so `spaceKeys` below reuses it.
              const adder = await ownerOperations.ownerToConfirm(ctx, space.id);
              const keys = await spaceKeys(ctx, space.id);
              const work: Work[] = [];
              if (adder) work.push('confirm-owner');
              if (ownerOperations.removalPending(ctx, keys).length > 0) {
                work.push('finish-removal');
              }
              if (ownerOperations.transferPending(ctx, keys)) work.push('renew-keys');
              // An agent revoked, or its pick removed, still holds the keys (section 9.7).
              const shares = await sharingOperations.listShares(ctx, space.id);
              if (shares.some((share) => share.formerAgents.length > 0)) {
                work.push('rotate-for-agents');
              }
              return { spaceId: space.id, name: nameOf(space.metadata), work };
            } catch {
              return null;
            }
          }),
      );
      return {
        spaces: found.filter(
          (space): space is NonNullable<typeof space> => space !== null && space.work.length > 0,
        ),
        unchecked: found.filter((space) => space === null).length,
      };
    },
    staleTime: Infinity,
  });

/**
 * At every unlock (protocol section 9.4): seal to this person's agents the
 * key versions they lack, then count the picks the server lists that their
 * own record doesn't back, which get no keys. A failure is kept as this
 * app's message, for the note to show; it is tried again at the next unlock.
 */
const agentWorkQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'agent-work'],
    queryFn: async () => {
      const recorded = ctx.contacts.book.payloads.shared.agents;
      if (recorded.length === 0) return { failed: null, offRecord: 0 };
      try {
        await runCommand(resealAgents, {}, { satisfies: requirementsHere(), ctx });
        const listed = await agentOperations.listAgents(ctx);
        return {
          failed: null,
          offRecord: picksOffRecord(listed, ctx.contacts.book.payloads.shared.agents).length,
        };
      } catch (error) {
        return { failed: agentMessage(error), offRecord: 0 };
      }
    },
    staleTime: Infinity,
  });

/**
 * After unlocking, a note listing the spaces whose ownership work isn't
 * finished. It is read out politely, and on a narrow screen it folds to one
 * line, so it doesn't sit on the page.
 */
export function PendingOwnerWork() {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { data } = useQuery(pendingOwnerWorkQuery(ctx, queryClient));
  // After the owner work, so the two don't write the contacts record at once.
  const { data: agents } = useQuery({ ...agentWorkQuery(ctx), enabled: data !== undefined });
  const [dismissed, setDismissed] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const spaces = data?.spaces ?? [];
  const unchecked = data?.unchecked ?? 0;
  const agentNote = agents?.failed
    ? `Your agents didn’t get the newest keys. ${agents.failed}`
    : agents && agents.offRecord > 0
      ? 'The server lists access for your agents that your own record doesn’t. Check it on the Agents page.'
      : null;
  const shown = !dismissed && (spaces.length > 0 || unchecked > 0 || agentNote !== null);
  return (
    // Always there, so what appears in it is announced.
    <div aria-live="polite">
      {shown && (
        <aside
          aria-label="Waiting for you"
          className="fixed right-4 bottom-4 z-40 grid max-w-sm gap-2 rounded-card bg-card p-4 text-sm shadow-card max-[899px]:left-4 max-[899px]:max-w-none max-[899px]:p-3"
        >
          <div className="flex items-center gap-2">
            <h2 className="flex-1 font-extrabold">Waiting for you</h2>
            <button
              type="button"
              aria-expanded={unfolded}
              onClick={() => setUnfolded((open) => !open)}
              className="rounded-control px-2 py-1 text-xs font-bold text-primary-ink hover:tint active:tint-strong min-[900px]:hidden"
            >
              {unfolded ? 'Hide' : 'Show'}
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setDismissed(true)}
              className="grid size-7 place-items-center rounded-control hover:tint active:tint-strong"
            >
              <X className="size-4" strokeWidth={1.75} />
            </button>
          </div>
          <div className={cn('grid gap-1', !unfolded && 'max-[899px]:hidden')}>
            <ul className="grid gap-1">
              {spaces.map(({ spaceId, name, work }) => (
                <li key={spaceId}>
                  <Link
                    to={work.includes('confirm-owner') ? '/s/$spaceId' : '/s/$spaceId/members'}
                    params={{ spaceId }}
                    // Asks again, even if the person put the question off.
                    onClick={() => work.includes('confirm-owner') && askAgain(ctx, spaceId)}
                    className="font-bold text-primary-ink hover:underline"
                  >
                    <Name>{name ?? 'A space'}</Name>
                  </Link>
                  : {work.map((w) => WORK[w]).join(', ')}.
                </li>
              ))}
            </ul>
            {agentNote && (
              <p>
                <Link to="/agents" className="font-bold text-primary-ink hover:underline">
                  Agents
                </Link>
                : {agentNote}
              </p>
            )}
            {unchecked > 0 && (
              <p className="text-muted-foreground">
                {unchecked === 1
                  ? 'One space couldn’t be checked.'
                  : `${unchecked} spaces couldn’t be checked.`}{' '}
                Try opening it again later.
              </p>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

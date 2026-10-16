import type { agentOperations, IdentityId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { confirmAgentGroup, leaveAgentGroup } from '../commands/agent-commands';
import { runCommand } from '../commands/command';
import { requirementsHere } from '../commands/ui-commands';
import { refreshAccess, sharedWithMeQuery, spacesQuery, treeQuery } from '../data/queries';
import { ACCESS_LABELS, accessOf, type Access } from '../sharing/model';
import { nameOf, shareName } from '../sharing/names';
import { ErrorLine, useAction } from '../sharing/use-action';
import { useClient } from '../vault/store';
import { agentMessage } from './messages';
import { accessIn, accessUpTo } from './model';

type Listing = agentOperations.AgentGroupListing;

/** The lower of two accesses: an agent never gets more than its person. */
const lesser = (a: Access, b: Access): Access => (accessUpTo(b).includes(a) ? a : b);

/**
 * The groups owners put one of this person's agents in (protocol section
 * 9.4). Only owners read a group's name, so each shows its space and the
 * folders it reaches. One this person hasn't confirmed, on the server and
 * in their own record, offers Confirm, which seals the agent those folders
 * now, or Decline, which takes it out. A confirmed one can be left.
 */
export function AgentGroups({
  agentId,
  groups,
}: {
  agentId: IdentityId;
  groups: readonly Listing[];
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<ReactNode>(null);
  const { busy, error, run } = useAction(agentMessage);
  const env = { satisfies: requirementsHere(), ctx };
  const recorded = (group: Listing) =>
    ctx.contacts.book.payloads.shared.agents.some(
      (agent) =>
        agent.enrollment.agent.id === agentId &&
        agent.groups?.some((g) => g.spaceId === group.spaceId && g.groupId === group.groupId),
    );
  const act = (action: () => Promise<void>, message: ReactNode) =>
    run(async () => {
      setNotice(null);
      await action();
      await refreshAccess(queryClient, ctx);
      setNotice(message);
    });
  if (groups.length === 0 && !notice) return null;
  return (
    <section aria-label="Through groups" className="grid gap-2">
      <h3 className="text-sm font-bold text-subtle-foreground">Through groups</h3>
      <ul className="grid gap-1">
        {groups.map((group) => {
          const confirmed = group.confirmed && recorded(group);
          const where = { agentId, spaceId: group.spaceId, groupId: group.groupId };
          return (
            <GroupEntry
              key={group.groupId}
              group={group}
              confirmed={confirmed}
              disabled={busy}
              onConfirm={() =>
                act(
                  () => runCommand(confirmAgentGroup, where, env),
                  'It has the group’s folders now.',
                )
              }
              onLeave={() =>
                act(
                  () => runCommand(leaveAgentGroup, where, env),
                  confirmed
                    ? 'It’s out of the group. It keeps the keys it had; the folders’ owners will be offered new ones.'
                    : 'It’s out of the group.',
                )
              }
            />
          );
        })}
      </ul>
      {notice && (
        <p role="status" className="text-sm font-bold">
          {notice}
        </p>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

/**
 * The space a group is in, as this person can name it: by its name if
 * they own it or hold it whole, else by who shared its folders with them,
 * since its name isn't theirs to read (protocol section 7.7).
 */
function useSpaceLabel(spaceId: string): ReactNode {
  const ctx = useClient();
  const { data: spaces } = useQuery(spacesQuery(ctx));
  const { data: shared } = useQuery(sharedWithMeQuery(ctx));
  const space = spaces?.find((s) => s.id === spaceId);
  if (space) return <Name>{nameOf(space.metadata) ?? 'a space this app can’t read'}</Name>;
  const by = shared?.find((item) => item.share.spaceId === spaceId)?.sharedBy?.label;
  return by ? (
    <>
      a space <Name>{by}</Name> shares folders of with you
    </>
  ) : (
    'a space you have folders in'
  );
}

/**
 * One group: its space, and each folder it reaches with the access the
 * agent gets there, never more than this person has.
 */
function GroupEntry({
  group,
  confirmed,
  disabled,
  onConfirm,
  onLeave,
}: {
  group: Listing;
  confirmed: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onLeave: () => void;
}) {
  const ctx = useClient();
  const { data: tree } = useQuery(treeQuery(ctx, group.spaceId));
  const where = useSpaceLabel(group.spaceId);
  const folders = group.shares.map((held) => {
    const share = tree?.shares.find((s) => s.shareId === held.shareId);
    // As confirmed (or to be): the group's access, a reader's without drafts.
    const given = !confirmed || group.drafts ? accessOf(held) : 'reader';
    return {
      shareId: held.shareId,
      label: share ? shareName(tree, share.rootId) : 'A folder you can’t open',
      access: share ? lesser(given, accessIn(share)) : given,
    };
  });
  return (
    <li className="grid gap-1.5 rounded-row bg-muted px-3 py-2 text-sm">
      <p>
        {confirmed ? (
          <>Through a group in {where}:</>
        ) : (
          <>An owner added it to a group in {where}. It gets these folders only if you confirm:</>
        )}
      </p>
      {folders.length === 0 ? (
        <p className="text-muted-foreground">The group has no folders yet.</p>
      ) : (
        <ul className="grid gap-0.5">
          {folders.map((folder) => (
            <li key={folder.shareId} className="flex flex-wrap justify-between gap-x-2">
              <span className="min-w-0 truncate font-bold">
                <Name>{folder.label}</Name>
              </span>
              <span className="text-muted-foreground">{ACCESS_LABELS[folder.access]}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {!confirmed && (
          <Button size="xs" disabled={disabled} onClick={onConfirm}>
            Confirm
          </Button>
        )}
        <Button size="xs" variant="outline" disabled={disabled} onClick={onLeave}>
          {confirmed ? 'Take out of group' : 'Decline'}
        </Button>
      </div>
    </li>
  );
}

import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { groupsQuery, treeQuery } from '../../../../../../data/queries';
import { NewGroupDialog } from '../../../../../../sharing/group-dialogs';
import { GroupsPage } from '../../../../../../sharing/groups-page';
import { groupName, peopleIn } from '../../../../../../sharing/groups';
import { sharingMessage } from '../../../../../../sharing/messages';
import { ACCESS_LABELS, accessOf } from '../../../../../../sharing/model';
import { nameOf, shareNameById } from '../../../../../../sharing/names';
import { useOwnerStanding } from '../../../../../../sharing/owner-standing';
import { describePerson, peopleQuery } from '../../../../../../sharing/people';
import { useClient } from '../../../../../../vault/store';

export const Route = createFileRoute('/_app/_vault/s/$spaceId/groups/')({ component: Groups });

/**
 * A space's groups, for its owners: each by name, with its people and the
 * folders it has. A group opens to manage it; New group makes one.
 */
function Groups() {
  const { spaceId } = Route.useParams();
  const ctx = useClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const standing = useOwnerStanding(spaceId);
  const owner = standing === 'owner';
  const groups = useQuery({ ...groupsQuery(ctx, spaceId), enabled: owner });
  const memberIds = groups.data?.groups.flatMap((g) => peopleIn(g).map((m) => m.identity.id)) ?? [];
  const { data: people } = useQuery({
    ...peopleQuery(ctx, memberIds),
    enabled: memberIds.length > 0,
  });
  const person = (id: string) => people?.get(id) ?? describePerson(ctx, id, null);
  const [creating, setCreating] = useState(false);
  const [done, setDone] = useState<ReactNode>(null);

  return (
    <GroupsPage
      title="Groups"
      about={
        <>
          <Name>{nameOf(tree?.space?.metadata) ?? 'This space'}</Name>: people you share folders
          with as one. Only the space’s owners see its groups, their names and who is in them.
        </>
      }
      spaceId={spaceId}
      back={{ to: '/s/$spaceId/members', label: 'Members and owners' }}
    >
      {tree && standing === null && (
        <p className="text-sm text-muted-foreground">Only the space’s owners see its groups.</p>
      )}
      {standing === 'unconfirmed' && (
        <p className="rounded-control bg-muted p-3 text-sm">
          Confirm who made you an owner of this space before managing its groups.
        </p>
      )}
      {groups.error && (
        <p role="alert" className="text-sm text-destructive">
          {sharingMessage(groups.error)}
        </p>
      )}
      {owner && groups.data && (
        <section aria-labelledby="groups-heading" className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="groups-heading" className="flex-1 text-xl font-extrabold">
              {groups.data.groups.length === 1 ? '1 group' : `${groups.data.groups.length} groups`}
            </h2>
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              <Plus strokeWidth={1.75} /> New group
            </Button>
          </div>
          {done && (
            <p role="status" className="text-sm font-bold">
              {done}
            </p>
          )}
          {groups.data.groups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No groups yet. Make one, add people to it, then share folders with it from their Share
              dialog.
            </p>
          )}
          <ul className="grid gap-3">
            {groups.data.groups.map((group) => {
              const members = peopleIn(group);
              return (
                <li key={group.groupId} className="grid gap-1 rounded-control border p-3">
                  <div className="flex items-center gap-2">
                    <Users className="size-4 shrink-0 text-primary" strokeWidth={1.75} />
                    <Link
                      to="/s/$spaceId/groups/$groupId"
                      params={{ spaceId, groupId: group.groupId }}
                      className="flex-1 truncate font-extrabold text-primary-ink hover:underline"
                    >
                      <Name>{groupName(group)}</Name>
                    </Link>
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {members.length === 1 ? '1 person' : `${members.length} people`} ·{' '}
                      {group.shares.length === 1 ? '1 folder' : `${group.shares.length} folders`}
                    </span>
                  </div>
                  <p className="truncate text-sm">
                    {members.length === 0 ? (
                      <span className="text-muted-foreground">No one yet.</span>
                    ) : (
                      <Name>{members.map((m) => person(m.identity.id).name).join(', ')}</Name>
                    )}
                  </p>
                  {group.shares.length > 0 && (
                    <ul className="grid gap-0.5 text-sm text-muted-foreground">
                      {group.shares.map((held) => (
                        <li key={held.shareId} className="flex justify-between gap-2">
                          <span className="truncate">
                            <Name>{shareNameById(tree, held.shareId)}</Name>
                          </span>
                          <span>{ACCESS_LABELS[accessOf(held)]}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <NewGroupDialog
        spaceId={spaceId}
        open={creating}
        onClose={() => setCreating(false)}
        onDone={(name) => {
          setCreating(false);
          setDone(
            <>
              <Name>{name}</Name> is ready. Open it to add people.
            </>,
          );
        }}
      />
    </GroupsPage>
  );
}

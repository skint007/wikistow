import type { FolderId, groupOperations } from '@wikistow/client';
import { GroupId } from '@wikistow/contracts';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Pencil, ShieldAlert, Trash2, UserPlus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { groupsQuery, treeQuery } from '../../../../../../data/queries';
import { PersonRow } from '../../../../../../sharing/access-panel';
import { GiveAccessDialog } from '../../../../../../sharing/give-access-dialog';
import { GroupDialog, type GroupAction } from '../../../../../../sharing/group-dialogs';
import { groupName, peopleIn, WaitingMark } from '../../../../../../sharing/groups';
import { GroupsPage } from '../../../../../../sharing/groups-page';
import { needsKeyReview } from '../../../../../../sharing/key-change';
import { sharingMessage } from '../../../../../../sharing/messages';
import { ACCESS_LABELS, accessOf } from '../../../../../../sharing/model';
import { nameOf, shareNameById } from '../../../../../../sharing/names';
import { useOwnerStanding } from '../../../../../../sharing/owner-standing';
import { describePerson, peopleQuery, type Person } from '../../../../../../sharing/people';
import { ShareDialog } from '../../../../../../sharing/share-dialog';
import { useClient } from '../../../../../../vault/store';

export const Route = createFileRoute('/_app/_vault/s/$spaceId/groups/$groupId')({
  params: {
    parse: ({ groupId }) => ({ groupId: GroupId.parse(groupId) }),
    stringify: ({ groupId }) => ({ groupId }),
  },
  component: Group,
});

/**
 * One group, for the space's owners: its people, with Key changed and
 * Waiting for keys marks, Give access, Add member and Remove from group;
 * the folders it has, with their access, changed in each folder's Share
 * dialog; Rename and Delete group.
 */
function Group() {
  const { spaceId, groupId } = Route.useParams();
  const ctx = useClient();
  const navigate = useNavigate();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const owner = useOwnerStanding(spaceId) === 'owner';
  const groups = useQuery({ ...groupsQuery(ctx, spaceId), enabled: owner });
  const group = groups.data?.groups.find((g) => g.groupId === groupId);
  const members = group ? peopleIn(group) : [];
  const { data: people } = useQuery({
    ...peopleQuery(
      ctx,
      members.map((m) => m.identity.id),
    ),
    enabled: members.length > 0,
  });
  const person = (id: string) => people?.get(id) ?? describePerson(ctx, id, null);
  const [action, setAction] = useState<GroupAction | null>(null);
  const [sharing, setSharing] = useState<{ rootId: FolderId | null } | null>(null);
  const [done, setDone] = useState<ReactNode>(null);
  const [giving, setGiving] = useState<Person | null>(null);
  const waiting = (id: string) =>
    !!group &&
    !!groups.data?.waiting.some(
      (w) => w.person.identity.id === id && group.shares.some((s) => s.shareId === w.shareId),
    );
  // Everywhere in the space someone waits, as Give access gives it all at once.
  const waitingFor = (who: Person): groupOperations.Waiting[] => {
    const entries = groups.data?.waiting.filter((w) => w.person.identity.id === who.id) ?? [];
    const [first] = entries;
    return first
      ? [
          {
            spaceId,
            person: first.person,
            keyChanged: needsKeyReview(who),
            shares: entries.map(({ shareId, role, canPublish, holds }) => ({
              shareId,
              role,
              canPublish,
              holds,
            })),
          },
        ]
      : [];
  };
  const act = (next: GroupAction) => {
    setDone(null);
    setAction(next);
  };

  return (
    <GroupsPage
      title={group ? <Name>{groupName(group)}</Name> : 'Group'}
      about="Everyone in it gets every folder it has, at its access. Only the space’s owners see it."
      spaceId={spaceId}
      back={{ to: '/s/$spaceId/groups', label: 'Groups' }}
      actions={
        group && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!group.name}
              onClick={() => act({ kind: 'rename' })}
            >
              <Pencil strokeWidth={1.75} /> Rename
            </Button>
            <Button size="sm" variant="outline" onClick={() => act({ kind: 'delete' })}>
              <Trash2 strokeWidth={1.75} /> Delete group
            </Button>
          </>
        )
      }
    >
      {groups.error && (
        <p role="alert" className="text-sm text-destructive">
          {sharingMessage(groups.error)}
        </p>
      )}
      {groups.data && !group && (
        <p className="text-sm text-muted-foreground">This group isn’t there any more.</p>
      )}
      {done && (
        <p role="status" className="text-sm font-bold">
          {done}
        </p>
      )}
      {group && (
        <>
          <section aria-labelledby="members-heading" className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="members-heading" className="flex-1 text-xl font-extrabold">
                Members
              </h2>
              <Button size="sm" variant="secondary" onClick={() => act({ kind: 'add' })}>
                <UserPlus strokeWidth={1.75} /> Add member
              </Button>
            </div>
            {members.length === 0 && (
              <p className="text-sm text-muted-foreground">No one is in this group yet.</p>
            )}
            <ul className="grid gap-1">
              {members.map((member) => {
                const who = person(member.identity.id);
                return (
                  <PersonRow
                    key={who.id}
                    person={who}
                    detail={waiting(who.id) ? <WaitingMark /> : undefined}
                  >
                    {needsKeyReview(who) ? (
                      <Button
                        size="xs"
                        variant="outline"
                        className="text-destructive"
                        onClick={() => act({ kind: 'key', person: who })}
                      >
                        <ShieldAlert strokeWidth={1.75} /> Key changed
                      </Button>
                    ) : (
                      waiting(who.id) && (
                        <Button size="sm" variant="outline" onClick={() => setGiving(who)}>
                          Give access
                        </Button>
                      )
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        act({ kind: 'remove', identityId: member.identity.id, name: who.name })
                      }
                    >
                      Remove from group
                    </Button>
                  </PersonRow>
                );
              })}
            </ul>
          </section>
          <section aria-labelledby="folders-heading" className="grid gap-2">
            <h2 id="folders-heading" className="text-xl font-extrabold">
              Folders
            </h2>
            {group.shares.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                It has no folders yet. Share a folder with it from the folder’s Share dialog.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Change a folder’s access in its Share dialog.
              </p>
            )}
            <ul className="grid gap-1">
              {group.shares.map((held) => {
                const rootId =
                  groups.data?.shares.find((s) => s.shareId === held.shareId)?.rootId ?? null;
                return (
                  <li
                    key={held.shareId}
                    className="flex flex-wrap items-center gap-2 rounded-control border p-3"
                  >
                    <span className="flex-1 truncate font-bold">
                      <Name>{shareNameById(tree, held.shareId)}</Name>
                      {rootId === null && (
                        <span className="font-normal text-muted-foreground"> (whole space)</span>
                      )}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {ACCESS_LABELS[accessOf(held)]}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => setSharing({ rootId })}>
                      Manage
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
          <GroupDialog
            spaceId={spaceId}
            group={group}
            action={action}
            onClose={() => setAction(null)}
            onDone={(message, deleted) => {
              setAction(null);
              if (deleted) void navigate({ to: '/s/$spaceId/groups', params: { spaceId } });
              else setDone(message);
            }}
          />
        </>
      )}
      {giving && (
        <GiveAccessDialog
          spaceId={spaceId}
          spaceName={nameOf(tree?.space?.metadata) ?? 'This space'}
          waiting={waitingFor(giving)}
          open
          onClose={() => setGiving(null)}
        />
      )}
      <ShareDialog
        spaceId={spaceId}
        rootId={sharing?.rootId ?? null}
        open={sharing !== null}
        onOpenChange={(open) => !open && setSharing(null)}
      />
    </GroupsPage>
  );
}

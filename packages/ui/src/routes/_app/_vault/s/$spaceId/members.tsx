import {
  groupOperations,
  type FolderId,
  type IdentityId,
  type ShareId,
  type SpaceId,
} from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Crown, Share, UserPlus, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AgentName } from '../../../../../agents/agent-name';
import { sendGroupChange } from '../../../../../commands/sharing-commands';
import {
  groupsQuery,
  refreshAccess,
  sharesQuery,
  spaceKeysQuery,
  treeQuery,
} from '../../../../../data/queries';
import { groupName, peopleIn } from '../../../../../sharing/groups';
import { PersonRow } from '../../../../../sharing/access-panel';
import { useKeyReview } from '../../../../../sharing/key-change';
import { sharingMessage } from '../../../../../sharing/messages';
import { ACCESS_LABELS, accessOf } from '../../../../../sharing/model';
import { nameOf, shareName, shareNameById } from '../../../../../sharing/names';
import { OwnerDialog, type OwnerAction } from '../../../../../sharing/owner-dialog';
import { OwnerTasks } from '../../../../../sharing/owner-tasks';
import { describePerson, peopleQuery } from '../../../../../sharing/people';
import { NotInAnyShare, RotationConfirm } from '../../../../../sharing/rotation-confirm';
import { RotateKeysDialog } from '../../../../../sharing/rotate-keys-dialog';
import { ShareDialog } from '../../../../../sharing/share-dialog';
import { HoldOpen, useHoldOpen } from '../../../../../sharing/use-action';
import {
  askAgain,
  useOwnerRequirements,
  useOwnerStanding,
} from '../../../../../sharing/owner-standing';
import { useClient } from '../../../../../vault/store';

export const Route = createFileRoute('/_app/_vault/s/$spaceId/members')({ component: Members });

/**
 * Everyone with access to a space, for its owners: the owners, each shared
 * folder and its people, and the ownership changes (add a co-owner,
 * transfer, remove an owner) with anything still to finish.
 */
function Members() {
  const { spaceId } = Route.useParams();
  const ctx = useClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const standing = useOwnerStanding(spaceId);
  const owner = standing === 'owner';
  const keys = useQuery({ ...spaceKeysQuery(ctx, spaceId), enabled: owner });
  const shares = useQuery({ ...sharesQuery(ctx, spaceId), enabled: owner });
  const groups = useQuery({ ...groupsQuery(ctx, spaceId), enabled: owner });
  const owners = keys.data?.listed.map((o) => o.identity.id) ?? [];
  const memberIds = [
    ...(shares.data?.flatMap((s) => s.members.map((m) => m.identityId)) ?? []),
    // People there only through groups, who may hold no keys yet.
    ...(groups.data?.groups.flatMap((g) =>
      g.shares.length > 0 ? peopleIn(g).map((m) => m.identity.id) : [],
    ) ?? []),
  ];
  const agentPeople =
    shares.data?.flatMap((s) => [...s.agents, ...s.formerAgents].map((a) => a.personId)) ?? [];
  const { data: people } = useQuery({
    ...peopleQuery(ctx, [...owners, ...memberIds, ...agentPeople]),
    enabled: owners.length > 0,
  });
  const person = (id: string) => people?.get(id) ?? describePerson(ctx, id, null);
  // Each person's effective access in a share, through groups too, once the groups list has it.
  const accessIn = (share: NonNullable<typeof shares.data>[number]) => {
    const state = groups.data;
    if (state?.shares.some((s) => s.shareId === share.shareId)) {
      return groupOperations.shareAccess(state, share.shareId).people.map((p) => ({
        identityId: p.identityId,
        access: accessOf(p.access),
        waiting: p.waiting,
      }));
    }
    return share.members.map((m) => ({
      identityId: m.identityId,
      access: accessOf(m),
      waiting: false,
    }));
  };
  const [action, setAction] = useState<OwnerAction | null>(null);
  const [sharing, setSharing] = useState<{ rootId: FolderId | null } | null>(null);
  const [removing, setRemoving] = useState<IdentityId | null>(null);
  const [rotating, setRotating] = useState<ShareId | null>(null);
  const self = ctx.identity.public.id;
  const failed = keys.error ?? shares.error;

  return (
    <section className="h-full min-h-0 overflow-y-auto rounded-card bg-card shadow-card">
      <div className="mx-auto grid w-full max-w-[720px] gap-6 px-11 py-10 max-[899px]:px-[18px] max-[899px]:py-8">
        <header className="grid gap-1">
          <h1 className="text-[32px] leading-tight font-extrabold">Members and owners</h1>
          <p className="text-sm text-muted-foreground">
            <Name>{nameOf(tree?.space?.metadata) ?? 'This space'}</Name>: who owns it, and who each
            shared folder is shared with.
          </p>
          {owner && (
            <p className="text-sm">
              <Link
                to="/s/$spaceId/groups"
                params={{ spaceId }}
                className="inline-flex items-center gap-1.5 font-bold text-primary-ink hover:underline"
              >
                <UsersRound className="size-4" strokeWidth={1.75} /> Groups
              </Link>
              <span className="text-muted-foreground">: people you share folders with as one.</span>
            </p>
          )}
        </header>
        {tree && standing === null && (
          <p className="text-sm text-muted-foreground">
            Only the space’s owners see who has access.
          </p>
        )}
        {standing === 'unconfirmed' && (
          <div className="grid gap-2 rounded-control bg-muted p-3 text-sm">
            <p>
              You’re an owner of this space, but you haven’t confirmed who added you yet. Until you
              do, you can’t share it or manage who has access.
            </p>
            <div>
              <Button size="sm" onClick={() => askAgain(ctx, spaceId)}>
                Confirm who added you
              </Button>
            </div>
          </div>
        )}
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {sharingMessage(failed)}
          </p>
        )}
        {owner && (
          <OwnerTasks
            spaceId={spaceId}
            onRetryRemoval={(ownerId) => setAction({ kind: 'remove', ownerId, retry: true })}
            onRenew={(previousOwner) => setAction({ kind: 'renew', previousOwner })}
          />
        )}
        {owner && keys.data && (
          <section aria-labelledby="owners-heading" className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="owners-heading" className="flex-1 text-xl font-extrabold">
                Owners
              </h2>
              <Button size="sm" variant="secondary" onClick={() => setAction({ kind: 'add' })}>
                <UserPlus strokeWidth={1.75} /> Add co-owner
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setAction({ kind: 'transfer' })}>
                <Crown strokeWidth={1.75} /> Transfer
              </Button>
            </div>
            <ul className="grid gap-1">
              {owners.map((id) => (
                <PersonRow key={id} person={person(id)}>
                  {(id !== self || owners.length > 1) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setAction({ kind: 'remove', ownerId: id, retry: false })}
                    >
                      {id === self ? 'Leave' : 'Remove'}
                    </Button>
                  )}
                </PersonRow>
              ))}
            </ul>
          </section>
        )}
        {owner && shares.data && (
          <section aria-labelledby="shares-heading" className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="shares-heading" className="flex-1 text-xl font-extrabold">
                Shared folders
              </h2>
              {/* Not a space whose own name failed its checks: nothing can be shared under it. */}
              {shares.data.length === 0 && tree?.space?.metadata !== null && (
                <Button size="sm" variant="secondary" onClick={() => setSharing({ rootId: null })}>
                  <Share strokeWidth={1.75} /> Share space
                </Button>
              )}
            </div>
            {shares.data.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nothing is shared yet: only the owners can open this space. Share the space or a
                folder from its menu.
              </p>
            )}
            <ul className="grid gap-3">
              {shares.data.map((share) => (
                <li key={share.shareId} className="grid gap-1 rounded-control border p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate font-extrabold">
                      <Name>{shareName(tree, share.rootId)}</Name>
                      {share.rootId === null && (
                        <span className="font-normal text-muted-foreground"> (whole space)</span>
                      )}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSharing({ rootId: share.rootId })}
                    >
                      Manage
                    </Button>
                  </div>
                  <ul className="grid gap-0.5 text-sm">
                    {groups.data?.groups.flatMap((group) => {
                      const held = group.shares.find((s) => s.shareId === share.shareId);
                      return held
                        ? [
                            <li key={group.groupId} className="flex justify-between gap-2">
                              <span className="truncate">
                                <Name>{groupName(group)}</Name>{' '}
                                <span className="text-muted-foreground">(group)</span>
                              </span>
                              <span className="text-muted-foreground">
                                {ACCESS_LABELS[accessOf(held)]}
                              </span>
                            </li>,
                          ]
                        : [];
                    })}
                    {accessIn(share).map(({ identityId, access, waiting }) => (
                      <li key={identityId} className="flex justify-between gap-2">
                        <span className="truncate">
                          <Name>{person(identityId).name}</Name>
                          {waiting && (
                            <span className="text-muted-foreground"> (waiting for keys)</span>
                          )}
                        </span>
                        <span className="text-muted-foreground">{ACCESS_LABELS[access]}</span>
                      </li>
                    ))}
                    {accessIn(share).length === 0 &&
                      share.agents.length === 0 &&
                      !groups.data?.groups.some((g) =>
                        g.shares.some((s) => s.shareId === share.shareId),
                      ) && <li className="text-muted-foreground">Only the owners.</li>}
                    {share.agents.map((agent) => (
                      <li key={agent.agentId} className="flex justify-between gap-2">
                        <span className="truncate">
                          🤖{' '}
                          <AgentName
                            ctx={ctx}
                            agentId={agent.agentId}
                            serverName={agent.name}
                            person={{ name: person(agent.personId).name, served: false }}
                            brief
                          />{' '}
                          {/* As the Share dialog says it. */}
                          <span className="text-muted-foreground">
                            via{' '}
                            {person(agent.personId).self ? (
                              'you'
                            ) : (
                              <Name>{person(agent.personId).name}</Name>
                            )}
                          </span>
                        </span>
                        <span className="text-muted-foreground">
                          {ACCESS_LABELS[accessOf(agent)]}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {share.formerAgents.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 rounded-control bg-muted p-2 text-sm">
                      <span className="flex-1">
                        {share.formerAgents.length === 1
                          ? 'An agent that no longer has access still holds this folder’s keys.'
                          : `${share.formerAgents.length} agents that no longer have access still hold this folder’s keys.`}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setRotating(share.shareId)}
                      >
                        Rotate keys
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {owner && memberIds.length > 0 && (
          <section aria-labelledby="people-heading" className="grid gap-2">
            <h2 id="people-heading" className="text-xl font-extrabold">
              People
            </h2>
            <ul className="grid gap-1">
              {[...new Set(memberIds)].map((id) => (
                <PersonRow key={id} person={person(id)}>
                  <Button size="sm" variant="outline" onClick={() => setRemoving(id)}>
                    Remove from every folder
                  </Button>
                </PersonRow>
              ))}
            </ul>
          </section>
        )}
      </div>
      <OwnerDialog spaceId={spaceId} action={action} onClose={() => setAction(null)} />
      <ShareDialog
        spaceId={spaceId}
        rootId={sharing?.rootId ?? null}
        open={sharing !== null}
        onOpenChange={(open) => !open && setSharing(null)}
      />
      {rotating && (
        <RotateKeysDialog spaceId={spaceId} shareId={rotating} onClose={() => setRotating(null)} />
      )}
      <RemoveEverywhereDialog
        spaceId={spaceId}
        identityId={removing}
        name={removing ? person(removing).name : ''}
        ownerIds={new Set(owners)}
        onClose={() => setRemoving(null)}
      />
    </section>
  );
}

/**
 * "Remove from every folder in this space": one request, with a rotation of
 * each share they hold keys in, that also takes them out of its groups.
 */
function RemoveEverywhereDialog({
  spaceId,
  identityId,
  name,
  ownerIds,
  onClose,
}: {
  spaceId: SpaceId;
  identityId: IdentityId | null;
  name: string;
  ownerIds: ReadonlySet<string>;
  onClose: () => void;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const queryClient = useQueryClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const { panel, review, labels } = useKeyReview(identityId !== null);
  const { locked, hold } = useHoldOpen();
  return (
    <Dialog open={identityId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent dialogClassName="sm:max-w-xl" {...labels} locked={locked}>
        <HoldOpen value={hold}>
          {panel}
          <div className="grid gap-4" hidden={panel !== null}>
            <DialogHeader>
              <DialogTitle>
                Remove <Name>{name}</Name> from every folder
              </DialogTitle>
              <DialogDescription>
                Every folder they’re in gets new keys without them.
              </DialogDescription>
            </DialogHeader>
            {identityId && (
              <RotationConfirm
                title="Who keeps access"
                confirmLabel="Remove everywhere"
                none={<NotInAnyShare name={name} />}
                // Someone only in groups, holding no keys, still leaves them.
                confirmNone
                make={() => groupOperations.planRemovalEverywhere(ctx, { spaceId, identityId })}
                plansOf={({ rotations }) =>
                  rotations.map(({ plan }) => ({ label: shareNameById(tree, plan.shareId), plan }))
                }
                apply={(change) => sendGroupChange(change, { satisfies, ctx })}
                ownerIds={ownerIds}
                review={review}
                onCancel={onClose}
                onDone={async () => {
                  await refreshAccess(queryClient, ctx);
                  onClose();
                }}
              />
            )}
          </div>
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

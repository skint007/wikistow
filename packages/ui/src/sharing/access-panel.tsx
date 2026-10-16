import {
  groupOperations,
  sharingOperations,
  type IdentityId,
  type ShareId,
  type SpaceId,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import type { GroupId } from '@wikistow/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, MoreHorizontal, ShieldAlert, Users } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Avatar } from '@/components/avatar';
import { Name, plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { runCommand } from '../commands/command';
import {
  addMember,
  sendGroupChange,
  rotateShare,
  setPublishRights,
} from '../commands/sharing-commands';
import { groupsQuery, refreshAccess, treeQuery } from '../data/queries';
import { useOwnerRequirements } from './owner-standing';
import { useClient } from '../vault/store';
import { needsKeyReview, type KeyOutcome } from './key-change';
import { AgentName } from '../agents/agent-name';
import {
  ChangeReview,
  GrantConfirm,
  groupName,
  peopleIn,
  sourcesText,
  WaitingMark,
} from './groups';
import { sharingMessage } from './messages';
import {
  ACCESS_LABELS,
  accessChange,
  accessOf,
  grantOf,
  historyNotice,
  type Access,
} from './model';
import { shareName, shareNameById } from './names';
import { describePerson, peopleQuery, type Person } from './people';
import { AccessSelect, PersonFinder, type Found } from './person-finder';
import { NewMark } from './new-mark';
import { NotInAnyShare, RotationConfirm } from './rotation-confirm';
import { ErrorLine, useAction } from './use-action';

export type ListedShare = Awaited<ReturnType<typeof sharingOperations.listShares>>[number];
type ShareRotation = { label: string; planned: sharingOperations.PlannedRotation };
type GroupChange = groupOperations.GroupChange;
type PersonAccess = groupOperations.PersonAccess;

/** A change that needs the owner's confirmation before anything is sealed or rotated. */
type Pending =
  | { kind: 'add'; found: Found }
  | { kind: 'promote'; identityId: IdentityId; person: Person; access: Access }
  | {
      kind: 'rotation';
      title: ReactNode;
      confirmLabel: string;
      /** What to say when the server lists nothing to rotate. */
      none: ReactNode;
      make: () => Promise<ShareRotation[]>;
      apply: (plans: ShareRotation[]) => Promise<void>;
    }
  | {
      /** A group change that takes access away: rotations, maybe none. */
      kind: 'take';
      title: ReactNode;
      confirmLabel: string;
      none: ReactNode;
      make: () => Promise<GroupChange>;
      /** Whose access to show after it, here or in every share it touches. */
      showing: (change: GroupChange) => { shareIds: ShareId[]; personIds: string[] };
      done: (change: GroupChange) => ReactNode;
    }
  | {
      /** A group change that gives access: envelopes, or people who wait. */
      kind: 'give';
      title: ReactNode;
      confirmLabel: string;
      make: () => Promise<GroupChange>;
      showing: (change: GroupChange) => { shareIds: ShareId[]; personIds: string[] };
      done: ReactNode;
    };

/**
 * Who has access to a share, and the owner's changes to it (protocol
 * sections 7.3 to 7.5, 7.8 and 7.9): the owners, never a choice; the
 * space's groups that have it, with their access; and each person's
 * effective access with where it comes from. A person's picker changes
 * only their direct grant. Add someone gives a person a direct grant, or
 * shares with a group.
 */
export function AccessPanel({
  spaceId,
  share,
  owners,
  review,
}: {
  spaceId: SpaceId;
  share: ListedShare;
  owners: readonly string[];
  review: (person: Person) => Promise<KeyOutcome>;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const queryClient = useQueryClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const groups = useQuery(groupsQuery(ctx, spaceId));
  const state = groups.data;
  const { shareId } = share;
  // Null until the groups list holds this share, as just after it is made.
  const access =
    state && state.shares.some((s) => s.shareId === shareId)
      ? groupOperations.shareAccess(state, shareId)
      : null;
  const ownerIds = new Set(owners);
  const { data: people } = useQuery(
    peopleQuery(ctx, [
      ...owners,
      ...share.members.map((m) => m.identityId),
      ...(access?.people.map((p) => p.identityId) ?? []),
      ...[...share.agents, ...share.formerAgents].map((a) => a.personId),
    ]),
  );
  const person = (id: string) => people?.get(id) ?? describePerson(ctx, id, null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [done, setDone] = useState<ReactNode>(null);
  // The group change the owner confirmed last, for saying what it did.
  const sent = useRef<GroupChange | null>(null);
  const { busy, error, setError, run } = useAction();
  const env = { satisfies, ctx };
  const label = shareName(tree, share.rootId);

  const finish = async (message: ReactNode) => {
    await refreshAccess(queryClient, ctx);
    setPending(null);
    setDone(message);
  };

  // Show a change to confirm; nothing is sealed or rotated until the owner does.
  const ask = (next: Pending) => {
    setDone(null);
    setError(null);
    setPending(next);
  };

  // A rotation of this share alone.
  const rotateHere = (
    title: ReactNode,
    confirmLabel: string,
    args: { leaveOut?: IdentityId[]; demote?: IdentityId[] },
  ) =>
    ask({
      kind: 'rotation',
      title,
      confirmLabel,
      none: 'Nothing here needs new keys.',
      make: async () => [
        {
          label,
          planned: await sharingOperations.planShareRotation(ctx, { spaceId, shareId, ...args }),
        },
      ],
      apply: ([only]) =>
        only ? runCommand(rotateShare, { planned: only.planned }, env) : Promise.resolve(),
    });

  const rotatedOrNot = (change: GroupChange) =>
    change.rotations.length > 0 ? 'Done. The folder has new keys.' : 'Done. No keys changed.';

  // Drop someone's direct grant: what they keep through groups stays.
  const removeHere = (p: PersonAccess) => {
    const { name } = person(p.identityId);
    const keeps = p.sources.some((s) => s.kind === 'group');
    ask({
      kind: 'take',
      title: keeps ? (
        <>
          Remove <Name>{name}</Name>’s direct access to “<Name>{label}</Name>”?
        </>
      ) : (
        <>
          Remove <Name>{name}</Name> from “<Name>{label}</Name>”?
        </>
      ),
      confirmLabel: 'Remove',
      none: (
        <>
          Their groups keep <Name>{name}</Name>’s access as it is, so no keys change.
        </>
      ),
      make: () =>
        groupOperations.planRemoveDirectGrant(ctx, {
          spaceId,
          shareId,
          identityId: p.identityId,
        }),
      showing: () => ({ shareIds: keeps ? [shareId] : [], personIds: [p.identityId] }),
      done: rotatedOrNot,
    });
  };

  const removeEverywhereFor = (identityId: IdentityId) => {
    const { name } = person(identityId);
    ask({
      kind: 'take',
      title: (
        <>
          Remove <Name>{name}</Name> from every folder in this space?
        </>
      ),
      confirmLabel: 'Remove everywhere',
      none: <NotInAnyShare name={name} />,
      make: () => groupOperations.planRemovalEverywhere(ctx, { spaceId, identityId }),
      showing: () => ({ shareIds: [], personIds: [] }),
      done: () => (
        <>
          <Name>{name}</Name> has no access in this space now.
        </>
      ),
    });
  };

  // A person's picker changes only their direct grant (section 7.9).
  const changeDirect = (p: PersonAccess, direct: Access, to: Access) => {
    const who = person(p.identityId);
    const viaGroups = groupOperations.highestAccess(p.sources.filter((s) => s.kind === 'group'));
    const after = groupOperations.highestAccess([grantOf(to), viaGroups]) ?? grantOf(to);
    const holdsDrafts = p.holds?.role === 'editor';
    const grant = (message: ReactNode) =>
      run(async () => {
        if (!who.entry) throw new ApiError(404, 'not-found', 'The directory no longer lists them');
        await runCommand(addMember, { spaceId, shareId, person: who.entry, ...grantOf(to) }, env);
        await finish(message);
      });
    const change = accessChange(direct, to);
    switch (change.kind) {
      case 'none':
        return;
      case 'publish':
        return run(async () => {
          await runCommand(
            setPublishRights,
            { spaceId, shareId, identityId: p.identityId, canPublish: change.canPublish },
            env,
          );
          await finish(
            <>
              <Name>{who.name}</Name>{' '}
              {after.canPublish
                ? change.canPublish
                  ? 'can now publish.'
                  : 'can still publish through a group.'
                : 'can no longer publish.'}
            </>,
          );
        });
      case 'promote':
        // Draft keys they already hold through a group reveal nothing new.
        if (holdsDrafts) {
          return grant(
            <>
              <Name>{who.name}</Name> is an editor directly now.
            </>,
          );
        }
        return ask({ kind: 'promote', identityId: p.identityId, person: who, access: to });
      case 'demote':
        // A group keeps them an editor: no keys change.
        if (after.role === 'editor' || !holdsDrafts) {
          return grant(
            after.role === 'editor' ? (
              <>
                <Name>{who.name}</Name> is a reader directly now, and keeps{' '}
                {ACCESS_LABELS[accessOf(after)]} through a group.
              </>
            ) : (
              <>
                <Name>{who.name}</Name> is a reader now.
              </>
            ),
          );
        }
        return rotateHere(
          <>
            Make <Name>{who.name}</Name> a reader of “<Name>{label}</Name>”?
          </>,
          'Make reader',
          { demote: [p.identityId] },
        );
    }
  };

  // Give access to someone waiting: every share in the space they lack keys for.
  const giveAccess = (who: Person) => {
    const { entry } = who;
    if (!entry) return;
    ask({
      kind: 'give',
      title: (
        <>
          Give <Name>{who.name}</Name> their keys?
        </>
      ),
      confirmLabel: 'Give access',
      make: () => groupOperations.planGiveAccess(ctx, { spaceId, person: entry }),
      showing: (change) => ({
        shareIds: change.seals.flatMap((s) => s.shares.map((h) => h.shareId)),
        personIds: [who.id],
      }),
      done: (
        <>
          <Name>{who.name}</Name> has their keys now.
        </>
      ),
    });
  };

  // The group's people as the plan found them, which may be newer than this list.
  const membersOf = (change: GroupChange, groupId: GroupId) => {
    const group = change.after.groups.find((g) => g.groupId === groupId);
    return group ? peopleIn(group).map((m) => m.identity.id) : [];
  };

  const shareWithGroup = (groupId: GroupId, to: Access) => {
    const group = state?.groups.find((g) => g.groupId === groupId);
    if (!group) return;
    const name = groupName(group);
    ask({
      kind: 'give',
      title: (
        <>
          Share “<Name>{label}</Name>” with <Name>{name}</Name> as {ACCESS_LABELS[to]}?
        </>
      ),
      confirmLabel: 'Share',
      make: () =>
        groupOperations.planShareGroup(ctx, { spaceId, shareId, groupId, access: grantOf(to) }),
      showing: (change) => ({ shareIds: [shareId], personIds: membersOf(change, groupId) }),
      done: (
        <>
          <Name>{name}</Name> has access now.
        </>
      ),
    });
  };

  const changeGroup = (groupId: GroupId, from: Access, to: Access) => {
    const group = state?.groups.find((g) => g.groupId === groupId);
    if (!group) return;
    const name = groupName(group);
    const make = () =>
      groupOperations.planShareGroup(ctx, { spaceId, shareId, groupId, access: grantOf(to) });
    const showing = (change: GroupChange) => ({
      shareIds: [shareId],
      personIds: membersOf(change, groupId),
    });
    const change = accessChange(from, to);
    switch (change.kind) {
      case 'none':
        return;
      case 'publish':
        // Publish rights alone change no keys: anyone short of keys keeps waiting for Give access.
        return run(async () => {
          await sendGroupChange({ ...(await make()), seals: [] }, env);
          await finish(
            <>
              <Name>{name}</Name>{' '}
              {change.canPublish ? 'can now publish.' : 'can no longer publish.'}
            </>,
          );
        });
      case 'promote':
        return ask({
          kind: 'give',
          title: (
            <>
              Let <Name>{name}</Name> edit “<Name>{label}</Name>”?
            </>
          ),
          confirmLabel: 'Let them edit',
          make,
          showing,
          done: (
            <>
              <Name>{name}</Name> can edit now.
            </>
          ),
        });
      case 'demote':
        return ask({
          kind: 'take',
          title: (
            <>
              Make <Name>{name}</Name> readers of “<Name>{label}</Name>”?
            </>
          ),
          confirmLabel: 'Make readers',
          none: 'Everyone in it keeps what they have through other access, so no keys change.',
          make,
          showing,
          done: rotatedOrNot,
        });
    }
  };

  const removeGroup = (groupId: GroupId) => {
    const group = state?.groups.find((g) => g.groupId === groupId);
    if (!group) return;
    const name = groupName(group);
    ask({
      kind: 'take',
      title: (
        <>
          Remove <Name>{name}</Name> from “<Name>{label}</Name>”?
        </>
      ),
      confirmLabel: 'Remove',
      none: 'Everyone in it keeps their access some other way, so no keys change.',
      make: () => groupOperations.planRemoveShareGroup(ctx, { spaceId, shareId, groupId }),
      showing: (change) => ({ shareIds: [shareId], personIds: membersOf(change, groupId) }),
      done: rotatedOrNot,
    });
  };

  // Seal every key version to someone, by their access: someone new, or a
  // reader becoming an editor.
  const seal = (who: Person, to: Access, message: ReactNode) =>
    run(async () => {
      if (!who.entry) throw new ApiError(404, 'not-found', 'The directory no longer lists them');
      await runCommand(addMember, { spaceId, shareId, person: who.entry, ...grantOf(to) }, env);
      await finish(message);
    });

  const reviewKey = async (who: Person) => {
    const outcome = await review(who);
    await refreshAccess(queryClient, ctx);
    return outcome;
  };

  if (pending?.kind === 'rotation') {
    return (
      <RotationConfirm
        title={pending.title}
        confirmLabel={pending.confirmLabel}
        none={pending.none}
        make={pending.make}
        plansOf={(plans) =>
          plans.map(({ label: l, planned }) => ({ label: l, plan: planned.plan }))
        }
        apply={pending.apply}
        ownerIds={ownerIds}
        review={reviewKey}
        onCancel={() => setPending(null)}
        onDone={() => finish('Done. The folder has new keys.')}
      />
    );
  }

  if (pending?.kind === 'take') {
    return (
      <RotationConfirm
        title={pending.title}
        confirmLabel={pending.confirmLabel}
        none={pending.none}
        confirmNone
        // Taking access away seals nothing: anyone short of keys keeps waiting for Give access.
        make={async () => ({ ...(await pending.make()), seals: [] })}
        plansOf={({ rotations }) =>
          rotations.map(({ plan }) => ({ label: shareNameById(tree, plan.shareId), plan }))
        }
        summary={(change) => (
          <ChangeReview spaceId={spaceId} change={change} {...pending.showing(change)} />
        )}
        apply={async (change) => {
          await sendGroupChange(change, env);
          sent.current = change;
        }}
        ownerIds={ownerIds}
        review={reviewKey}
        onCancel={() => setPending(null)}
        onDone={() => finish(sent.current ? pending.done(sent.current) : 'Done.')}
      />
    );
  }

  if (pending?.kind === 'give') {
    return (
      <GrantConfirm
        title={pending.title}
        confirmLabel={pending.confirmLabel}
        make={pending.make}
        review={(change) => (
          <ChangeReview spaceId={spaceId} change={change} {...pending.showing(change)} />
        )}
        apply={(change) => sendGroupChange(change, env)}
        onCancel={() => setPending(null)}
        onDone={() => finish(pending.done)}
      />
    );
  }

  if (pending?.kind === 'add' || pending?.kind === 'promote') {
    const who = pending.kind === 'add' ? pending.found.person : pending.person;
    const to = pending.kind === 'add' ? pending.found.access : pending.access;
    // Someone there through a group gets no keys they don't hold already, unless this makes
    // them an editor.
    const there =
      pending.kind === 'add' ? access?.people.find((p) => p.identityId === who.id) : undefined;
    const viaGroup =
      there && (there.access.role === 'editor' || grantOf(to).role === 'reader')
        ? there
        : undefined;
    return (
      <div className="grid gap-4">
        <h3 className="font-extrabold">
          {pending.kind === 'add' ? 'Add ' : 'Let '}
          <Name>{who.name}</Name>
          {pending.kind === 'add' ? ' to ' : ' edit '}“<Name>{label}</Name>”?
        </h3>
        {(who.email || who.status === 'new') && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {who.email && <Name>{who.email}</Name>}
            {who.status === 'new' && <NewMark />}
          </p>
        )}
        <p className="rounded-control bg-muted p-3 text-sm">
          <Name>{who.name}</Name>{' '}
          {viaGroup
            ? `has ${ACCESS_LABELS[accessOf(viaGroup.access)]} through a group already, and keeps it. This gives them access of their own as well.`
            : historyNotice(to)}
        </p>
        {busy && (
          <p role="status" className="text-sm font-bold">
            Sealing keys… Keep this open until it’s done.
          </p>
        )}
        <ErrorLine error={error} />
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void seal(
                who,
                to,
                <>
                  <Name>{who.name}</Name>{' '}
                  {pending.kind === 'add' ? 'has access now.' : 'can edit now.'}
                </>,
              )
            }
          >
            {pending.kind === 'add' ? 'Add' : 'Let them edit'}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const listed = access?.people ?? [];
  return (
    <div className="grid gap-4">
      <section aria-label="People with access" className="grid gap-1">
        <h3 className="text-sm font-bold text-subtle-foreground">People with access</h3>
        <ul className="grid gap-1">
          {owners.map((id) => (
            <PersonRow key={id} person={person(id)}>
              <span className="text-sm text-muted-foreground">Owner</span>
            </PersonRow>
          ))}
          {state &&
            access?.groups.map(({ group, access: held }) => (
              <GroupRow
                key={group.groupId}
                name={groupName(group)}
                members={peopleIn(group).map((m) => person(m.identity.id))}
              >
                <AccessSelect
                  id={`access-group-${group.groupId}`}
                  label={`Access for ${plainText(groupName(group))}`}
                  value={accessOf(held)}
                  disabled={busy}
                  onChange={(to) => void changeGroup(group.groupId, accessOf(held), to)}
                />
                <MoreMenu label={`More for ${plainText(groupName(group))}`} disabled={busy}>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => removeGroup(group.groupId)}
                  >
                    Remove from this folder
                  </DropdownMenuItem>
                </MoreMenu>
              </GroupRow>
            ))}
          {state &&
            listed.map((p) => {
              const who = person(p.identityId);
              const direct = p.sources.find((s) => s.kind === 'direct');
              const keyChanged = needsKeyReview(who);
              return (
                <PersonRow
                  key={p.identityId}
                  person={who}
                  detail={
                    <>
                      <Name>{sourcesText(state, p.sources)}</Name>
                      {p.waiting && (
                        <>
                          {' '}
                          <WaitingMark />
                        </>
                      )}
                    </>
                  }
                >
                  {keyChanged && (
                    <Button
                      size="xs"
                      variant="outline"
                      className="text-destructive"
                      onClick={() => void reviewKey(who)}
                    >
                      <ShieldAlert strokeWidth={1.75} /> Key changed
                    </Button>
                  )}
                  {p.waiting && !keyChanged && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => giveAccess(who)}
                    >
                      Give access
                    </Button>
                  )}
                  {direct ? (
                    <AccessSelect
                      id={`access-${p.identityId}`}
                      label={`Access for ${plainText(who.name)}`}
                      value={accessOf(direct)}
                      // Changing it would seal their keys: Give access shows what it gives first.
                      disabled={busy || p.waiting}
                      onChange={(to) => void changeDirect(p, accessOf(direct), to)}
                    />
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {ACCESS_LABELS[accessOf(p.access)]}
                    </span>
                  )}
                  <MoreMenu label={`More for ${plainText(who.name)}`} disabled={busy}>
                    {direct && (
                      <DropdownMenuItem variant="destructive" onSelect={() => removeHere(p)}>
                        {p.sources.length > 1 ? 'Remove direct access' : 'Remove from this folder'}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => removeEverywhereFor(p.identityId)}
                    >
                      Remove from every folder in this space
                    </DropdownMenuItem>
                  </MoreMenu>
                </PersonRow>
              );
            })}
        </ul>
        {!state && !groups.error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {groups.error && <ErrorLine error={sharingMessage(groups.error)} />}
      </section>
      {(share.agents.length > 0 || share.formerAgents.length > 0) && (
        <section aria-label="Agents" className="grid gap-1">
          <h3 className="text-sm font-bold text-subtle-foreground">Agents</h3>
          <p className="text-xs text-muted-foreground">
            An agent reaches this folder only through the person it works for, never with more
            access than they have. Remove that person, and their agents lose access too.
          </p>
          <ul className="grid gap-1">
            {share.agents.map((agent) => (
              <AgentRow key={agent.agentId} agent={agent} person={person(agent.personId)}>
                <span className="text-sm text-muted-foreground">
                  {ACCESS_LABELS[accessOf(agent)]}
                </span>
              </AgentRow>
            ))}
            {share.formerAgents.map((agent) => (
              <AgentRow key={agent.agentId} agent={agent} person={person(agent.personId)}>
                <span className="text-xs text-destructive">No access, but holds the keys</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    rotateHere(
                      <>
                        New keys for “<Name>{label}</Name>”?
                      </>,
                      'Rotate keys',
                      {},
                    )
                  }
                >
                  Rotate keys
                </Button>
              </AgentRow>
            ))}
          </ul>
        </section>
      )}
      {done && (
        <p role="status" className="text-sm font-bold">
          {done}
        </p>
      )}
      <ErrorLine error={error} />
      <section aria-label="Add someone" className="grid gap-2">
        <h3 className="text-sm font-bold text-subtle-foreground">Add someone</h3>
        <PersonFinder
          submitLabel="Add"
          review={reviewKey}
          groups={
            state?.groups
              .filter((g) => g.name && !g.shares.some((s) => s.shareId === shareId))
              .map((g) => ({
                groupId: g.groupId,
                name: groupName(g),
                people: peopleIn(g).length,
              })) ?? []
          }
          onGroup={shareWithGroup}
          exclude={(found) =>
            ownerIds.has(found.id) ? (
              <>
                <Name>{found.name}</Name> owns this space and has access already.
              </>
            ) : listed.some((p) => p.identityId === found.id && p.waiting) ? (
              <>
                <Name>{found.name}</Name> waits for keys here. Use Give access in the list above
                first.
              </>
            ) : listed.some((p) => p.identityId === found.id && p.sources[0]?.kind === 'direct') ? (
              <>
                <Name>{found.name}</Name> has access already. Change it in the list above.
              </>
            ) : null
          }
          onFound={(found) => ask({ kind: 'add', found })}
        />
      </section>
    </div>
  );
}

/** The "More" menu at the end of a row in an access list. */
function MoreMenu({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        disabled={disabled}
        className="grid size-8 place-items-center rounded-control enabled:hover:tint enabled:active:tint-strong disabled:opacity-50"
      >
        <MoreHorizontal className="size-4" strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A group in an access list: its name, a disclosure listing its people by
 * label, then the controls for it.
 */
function GroupRow({
  name,
  members,
  children,
}: {
  name: string;
  members: readonly Person[];
  children: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-start gap-2 rounded-row py-1">
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-primary"
      >
        <Users className="size-4" strokeWidth={1.75} />
      </span>
      <details className="grid min-w-0 flex-1">
        <summary className="cursor-pointer truncate text-sm font-bold">
          <Name>{name}</Name>{' '}
          <span className="font-normal text-muted-foreground">
            group · {members.length === 1 ? '1 person' : `${members.length} people`}
          </span>
        </summary>
        <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
          {members.map((m) => (
            <li key={m.id} className="truncate">
              <Name>{m.name}</Name>
            </li>
          ))}
          {members.length === 0 && <li>No one yet.</li>}
        </ul>
      </details>
      <span className="flex items-center gap-2">{children}</span>
    </li>
  );
}

/**
 * An agent in an access list, read-only: its name and the person it works
 * for, whose access it never exceeds. Only that person manages it.
 */
export function AgentRow({
  agent,
  person,
  children,
}: {
  agent: { agentId: string; name: string };
  person: Person;
  children: ReactNode;
}) {
  const ctx = useClient();
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-row py-1">
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-primary"
      >
        <Bot className="size-4" strokeWidth={1.75} />
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="truncate text-sm font-bold">
          <AgentName
            ctx={ctx}
            agentId={agent.agentId}
            serverName={agent.name}
            person={{ name: person.name, served: false }}
            brief
          />
        </span>
        <span className="truncate text-xs text-muted-foreground">
          via {person.self ? 'you' : <Name>{person.name}</Name>}
        </span>
      </span>
      {children}
    </li>
  );
}

/**
 * One person in an access list: their label and email, `detail` under
 * them, such as where their access comes from, then the controls for them.
 */
export function PersonRow({
  person,
  detail,
  children,
}: {
  person: Person;
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-row py-1">
      <Avatar name={person.name} avatar={person.avatar} letters={1} className="size-8 text-xs" />
      <span className="grid min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-bold">
            <Name>{person.name}</Name>
          </span>
          {person.status === 'new' && (
            <span className="shrink-0">
              <NewMark />
            </span>
          )}
        </span>
        {person.email && (
          <span className="truncate text-xs text-muted-foreground">
            <Name>{person.email}</Name>
          </span>
        )}
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      </span>
      {children}
    </li>
  );
}

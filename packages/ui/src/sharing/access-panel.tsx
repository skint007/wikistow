import { sharingOperations, type IdentityId, type SpaceId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, MoreHorizontal, ShieldAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
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
  removeEverywhere,
  rotateShare,
  setPublishRights,
} from '../commands/sharing-commands';
import { refreshAccess, treeQuery } from '../data/queries';
import { useOwnerRequirements } from './owner-standing';
import { useClient } from '../vault/store';
import { needsKeyReview, type KeyOutcome } from './key-change';
import { AgentName } from '../agents/agent-name';
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
type Member = ListedShare['members'][number];
type ShareRotation = { label: string; planned: sharingOperations.PlannedRotation };

/** A change that needs the owner's confirmation before anything is sealed or rotated. */
type Pending =
  | { kind: 'add'; found: Found }
  | { kind: 'promote'; member: Member; person: Person; access: Access }
  | {
      kind: 'rotation';
      title: ReactNode;
      confirmLabel: string;
      /** What to say when the server lists nothing to rotate. */
      none: ReactNode;
      make: () => Promise<ShareRotation[]>;
      apply: (plans: ShareRotation[]) => Promise<void>;
    };

/**
 * Who has access to a share, and the owner's changes to it (protocol
 * sections 7.3 to 7.5): add someone, change their access, remove them from
 * this folder or every folder in the space. Owners are always listed and
 * never a choice.
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
  const ownerIds = new Set(owners);
  const { data: people } = useQuery(
    peopleQuery(ctx, [
      ...owners,
      ...share.members.map((m) => m.identityId),
      ...[...share.agents, ...share.formerAgents].map((a) => a.personId),
    ]),
  );
  const person = (id: string) => people?.get(id) ?? describePerson(ctx, id, null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [done, setDone] = useState<ReactNode>(null);
  const { busy, error, setError, run } = useAction();
  const env = { satisfies, ctx };
  const { shareId } = share;
  const label = shareName(tree, share.rootId);

  const finish = async (message: ReactNode) => {
    await refreshAccess(queryClient, ctx);
    setPending(null);
    setDone(message);
  };

  // Show a rotation to confirm; nothing is sealed until the owner does.
  const startRotation = (rotation: Omit<Extract<Pending, { kind: 'rotation' }>, 'kind'>) => {
    setDone(null);
    setError(null);
    setPending({ kind: 'rotation', ...rotation });
  };

  // A rotation of this share alone.
  const rotateHere = (
    title: ReactNode,
    confirmLabel: string,
    args: { leaveOut?: IdentityId[]; demote?: IdentityId[] },
  ) =>
    startRotation({
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

  const removeHere = (member: Member) =>
    rotateHere(
      <>
        Remove <Name>{person(member.identityId).name}</Name> from “<Name>{label}</Name>”?
      </>,
      'Remove',
      { leaveOut: [member.identityId] },
    );

  const removeEverywhereFor = (member: Member) => {
    const { name } = person(member.identityId);
    startRotation({
      title: (
        <>
          Remove <Name>{name}</Name> from every folder in this space?
        </>
      ),
      confirmLabel: 'Remove everywhere',
      none: <NotInAnyShare name={name} />,
      make: async () =>
        (
          await sharingOperations.planRemovalEverywhere(ctx, {
            spaceId,
            identityId: member.identityId,
          })
        ).map((planned) => ({ label: shareNameById(tree, planned.plan.shareId), planned })),
      apply: (plans) => runCommand(removeEverywhere, { plans: plans.map((p) => p.planned) }, env),
    });
  };

  const changeAccess = (member: Member, to: Access) => {
    const who = person(member.identityId);
    const change = accessChange(accessOf(member), to);
    switch (change.kind) {
      case 'none':
        return;
      case 'publish':
        return run(async () => {
          await runCommand(
            setPublishRights,
            { spaceId, shareId, identityId: member.identityId, canPublish: change.canPublish },
            env,
          );
          await finish(
            <>
              <Name>{who.name}</Name>{' '}
              {change.canPublish ? 'can now publish.' : 'can no longer publish.'}
            </>,
          );
        });
      case 'promote':
        setDone(null);
        return setPending({ kind: 'promote', member, person: who, access: to });
      case 'demote':
        return rotateHere(
          <>
            Make <Name>{who.name}</Name> a reader of “<Name>{label}</Name>”?
          </>,
          'Make reader',
          { demote: [member.identityId] },
        );
    }
  };

  // Seal every key version to someone, by their access: a new member, a
  // reader becoming an editor, or a member whose changed key was confirmed.
  const seal = (who: Person, access: Access, message: ReactNode) =>
    run(async () => {
      if (!who.entry) throw new ApiError(404, 'not-found', 'The directory no longer lists them');
      await runCommand(addMember, { spaceId, shareId, person: who.entry, ...grantOf(access) }, env);
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

  if (pending?.kind === 'add' || pending?.kind === 'promote') {
    const who = pending.kind === 'add' ? pending.found.person : pending.person;
    const access = pending.kind === 'add' ? pending.found.access : pending.access;
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
          <Name>{who.name}</Name> {historyNotice(access)}
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
                access,
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
          {share.members.map((member) => {
            const who = person(member.identityId);
            // Their key changed, the owner confirmed it, and they hold nothing at it yet.
            const reshare =
              who.status === 'pinned' &&
              who.entry !== null &&
              who.entry.identity.keyVersion !== member.keyVersion;
            return (
              <PersonRow key={member.identityId} person={who}>
                {needsKeyReview(who) && (
                  <Button
                    size="xs"
                    variant="outline"
                    className="text-destructive"
                    onClick={() => void reviewKey(who)}
                  >
                    <ShieldAlert strokeWidth={1.75} /> Key changed
                  </Button>
                )}
                {reshare && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void seal(
                        who,
                        accessOf(member),
                        <>
                          <Name>{who.name}</Name> has their keys again.
                        </>,
                      )
                    }
                  >
                    Share again
                  </Button>
                )}
                <AccessSelect
                  id={`access-${member.identityId}`}
                  label={`Access for ${plainText(who.name)}`}
                  value={accessOf(member)}
                  disabled={busy}
                  onChange={(to) => void changeAccess(member, to)}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`More for ${plainText(who.name)}`}
                    disabled={busy}
                    className="grid size-8 place-items-center rounded-control hover:bg-accent"
                  >
                    <MoreHorizontal className="size-4" strokeWidth={1.75} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onSelect={() => removeHere(member)}>
                      Remove from this folder
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => removeEverywhereFor(member)}
                    >
                      Remove from every folder in this space
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </PersonRow>
            );
          })}
        </ul>
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
          exclude={(found) =>
            ownerIds.has(found.id) ? (
              <>
                <Name>{found.name}</Name> owns this space and has access already.
              </>
            ) : share.members.some((m) => m.identityId === found.id) ? (
              <>
                <Name>{found.name}</Name> has access already. Change it in the list above.
              </>
            ) : null
          }
          onFound={(found) => {
            setError(null);
            setDone(null);
            setPending({ kind: 'add', found });
          }}
        />
      </section>
    </div>
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

/** One person in an access list: their label and email, then the controls for them. */
export function PersonRow({ person, children }: { person: Person; children: ReactNode }) {
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
      </span>
      {children}
    </li>
  );
}

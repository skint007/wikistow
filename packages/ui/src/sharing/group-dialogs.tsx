import { groupOperations, type IdentityId, type SpaceId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { submitData } from '@/components/form/submit';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { runCommand } from '../commands/command';
import { createGroup, renameGroup, sendGroupChange } from '../commands/sharing-commands';
import { groupsQuery, refreshAccess, spaceKeysQuery, treeQuery } from '../data/queries';
import { useClient } from '../vault/store';
import { ChangeReview, GrantConfirm, groupName, peopleIn } from './groups';
import { KeyChangePanel, useKeyReview } from './key-change';
import { shareNameById } from './names';
import { useOwnerRequirements } from './owner-standing';
import type { Person } from './people';
import { PersonFinder } from './person-finder';
import { RotationConfirm } from './rotation-confirm';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from './use-action';

/** What the owner is doing to a group, in its dialog. */
export type GroupAction =
  | { kind: 'add' }
  | { kind: 'remove'; identityId: IdentityId; name: string }
  | { kind: 'rename' }
  | { kind: 'delete' }
  | { kind: 'key'; person: Person };

/**
 * The dialog for a change to one group (protocol sections 7.8 and 7.9):
 * add a member, found by exact email, sealing them every folder the group
 * has; remove one, or delete the group, showing for each folder who keeps
 * access and what each person keeps before any keys change; rename it; or
 * review a member's changed key. `onDone` hears what was done, or that the
 * group is gone.
 */
export function GroupDialog({
  spaceId,
  group,
  action,
  onClose,
  onDone,
}: {
  spaceId: SpaceId;
  group: groupOperations.Group;
  action: GroupAction | null;
  onClose: () => void;
  onDone: (message: ReactNode, deleted?: boolean) => void;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const queryClient = useQueryClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const { data: keys } = useQuery(spaceKeysQuery(ctx, spaceId));
  const open = action !== null;
  const { panel, review, labels } = useKeyReview(open);
  const { locked, hold } = useHoldOpen();
  const headingId = useId();
  const env = { satisfies, ctx };
  const name = groupName(group);
  const ownerIds = new Set(keys?.listed.map((o) => o.identity.id) ?? []);
  const { groupId } = group;
  // The group's folders as a plan found them, which may be newer than this page.
  const sharesIn = (change: groupOperations.GroupChange) => [
    ...new Set([
      ...group.shares.map((s) => s.shareId),
      ...(change.after.groups.find((g) => g.groupId === groupId)?.shares ?? []).map(
        (s) => s.shareId,
      ),
      ...change.rotations.map(({ plan }) => plan.shareId),
    ]),
  ];

  const finish = async (message: ReactNode, deleted = false) => {
    // A deleted group's page says so first, so it never shows the group missing.
    if (deleted) onDone(message, deleted);
    await refreshAccess(queryClient, ctx);
    if (!deleted) onDone(message, deleted);
  };

  const body = () => {
    switch (action?.kind) {
      case undefined:
        return null;
      case 'key':
        return (
          <KeyChangePanel
            headingId={headingId}
            person={action.person}
            onClose={(outcome) => {
              if (outcome === 'confirmed') {
                void finish(
                  <>
                    Key confirmed. <Name>{action.person.name}</Name> waits for keys until you give
                    them access.
                  </>,
                );
              } else onClose();
            }}
          />
        );
      case 'add':
        return <AddMember spaceId={spaceId} group={group} review={review} onDone={finish} />;
      case 'rename':
        return (
          <RenameGroup
            group={group}
            onCancel={onClose}
            rename={async (next) => {
              if (!group.name) return;
              await runCommand(
                renameGroup,
                { spaceId, groupId, current: group.name, name: next },
                env,
              );
              await finish(
                <>
                  Renamed to <Name>{next}</Name>.
                </>,
              );
            }}
          />
        );
      case 'remove':
        return (
          <RotationConfirm
            title={
              <>
                Remove <Name>{action.name}</Name> from <Name>{name}</Name>?
              </>
            }
            confirmLabel="Remove from group"
            none="No keys change: the group has no folders, or they keep the same access some other way."
            confirmNone
            make={() =>
              groupOperations.planRemoveMember(ctx, {
                spaceId,
                groupId,
                identityId: action.identityId,
              })
            }
            plansOf={({ rotations }) =>
              rotations.map(({ plan }) => ({ label: shareNameById(tree, plan.shareId), plan }))
            }
            summary={(change) => (
              <Keeps>
                <ChangeReview
                  spaceId={spaceId}
                  change={change}
                  shareIds={sharesIn(change)}
                  personIds={[action.identityId]}
                />
              </Keeps>
            )}
            apply={(change) => sendGroupChange(change, env)}
            ownerIds={ownerIds}
            review={review}
            onCancel={onClose}
            onDone={() =>
              finish(
                <>
                  <Name>{action.name}</Name> is out of the group.
                </>,
              )
            }
          />
        );
      case 'delete':
        return (
          <RotationConfirm
            title={
              <>
                Delete <Name>{name}</Name>?
              </>
            }
            intro={
              <p className="text-sm text-muted-foreground">
                It comes off every folder it has. Its people keep only what they have directly or
                through another group.
              </p>
            }
            confirmLabel="Delete group"
            none="No keys change: the group has no folders, or everyone in it keeps the same access some other way."
            confirmNone
            make={() => groupOperations.planDeleteGroup(ctx, { spaceId, groupId })}
            plansOf={({ rotations }) =>
              rotations.map(({ plan }) => ({ label: shareNameById(tree, plan.shareId), plan }))
            }
            summary={(change) => (
              <Keeps>
                <ChangeReview
                  spaceId={spaceId}
                  change={change}
                  shareIds={sharesIn(change)}
                  personIds={peopleIn(group).map((m) => m.identity.id)}
                />
              </Keeps>
            )}
            apply={(change) => sendGroupChange(change, env)}
            ownerIds={ownerIds}
            review={review}
            onCancel={onClose}
            onDone={() =>
              finish(
                <>
                  <Name>{name}</Name> is deleted.
                </>,
                true,
              )
            }
          />
        );
    }
  };

  const title =
    action?.kind === 'add'
      ? 'Add member'
      : action?.kind === 'rename'
        ? 'Rename group'
        : action?.kind === 'delete'
          ? 'Delete group'
          : 'Remove from group';

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        dialogClassName="sm:max-w-xl"
        {...(action?.kind === 'key'
          ? { labelledBy: headingId, describedBy: `${headingId}-about` }
          : labels)}
        locked={locked}
      >
        <HoldOpen value={hold}>
          {action?.kind === 'key' ? (
            body()
          ) : (
            <>
              {panel}
              <div className="grid gap-4" hidden={panel !== null}>
                <DialogHeader>
                  <DialogTitle>{title}</DialogTitle>
                  <DialogDescription>
                    <Name>{name}</Name>: only the space’s owners see this group and its name.
                  </DialogDescription>
                </DialogHeader>
                {open && body()}
              </div>
            </>
          )}
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

// What the person, or each of the group's people, keeps in each folder.
const Keeps = ({ children }: { children: ReactNode }) => (
  <section aria-label="What each keeps" className="grid gap-2">
    <h3 className="text-sm font-bold text-subtle-foreground">Each folder afterwards</h3>
    {children}
  </section>
);

/**
 * Add someone to a group: find them by exact email, then look over the
 * folders the group has, with the access they will get and the history
 * notice, before every version is sealed to them with the membership.
 */
function AddMember({
  spaceId,
  group,
  review,
  onDone,
}: {
  spaceId: SpaceId;
  group: groupOperations.Group;
  review: Parameters<typeof PersonFinder>[0]['review'];
  onDone: (message: ReactNode) => Promise<void>;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const { data: keys } = useQuery(spaceKeysQuery(ctx, spaceId));
  const [found, setFound] = useState<Person | null>(null);
  const { groupId } = group;
  if (!found?.entry) {
    return (
      <PersonFinder
        withAccess={false}
        submitLabel="Next"
        review={review}
        exclude={(person) =>
          keys?.listed.some((o) => o.identity.id === person.id) ? (
            <>
              <Name>{person.name}</Name> owns this space, and owners aren’t in groups: they have
              every folder already.
            </>
          ) : group.members.some((m) => m.identity.id === person.id) ? (
            <>
              <Name>{person.name}</Name> is in this group already.
            </>
          ) : null
        }
        onFound={({ person }) => setFound(person)}
      />
    );
  }
  const person = found.entry;
  return (
    <GrantConfirm
      title={
        <>
          Add <Name>{found.name}</Name> to <Name>{groupName(group)}</Name>?
        </>
      }
      confirmLabel="Add to group"
      make={() => groupOperations.planAddMember(ctx, { spaceId, groupId, person })}
      review={(change) => {
        // The folders the group has now, as the plan seals them.
        const shareIds = (change.after.groups.find((g) => g.groupId === groupId)?.shares ?? []).map(
          (s) => s.shareId,
        );
        return shareIds.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The group has no folders yet, so nothing is shared with them now. They get every folder
            the group is given later.
          </p>
        ) : (
          <section aria-label="What they get" className="grid gap-2">
            <h3 className="text-sm font-bold text-subtle-foreground">What they get</h3>
            <ChangeReview
              spaceId={spaceId}
              change={change}
              shareIds={shareIds}
              personIds={[person.identity.id]}
            />
          </section>
        );
      }}
      apply={(change) => sendGroupChange(change, { satisfies, ctx })}
      onCancel={() => setFound(null)}
      onDone={() =>
        onDone(
          <>
            <Name>{found.name}</Name> is in the group now.
          </>,
        )
      }
    />
  );
}

/** A new name for a group, sealed to the owners as its next version. */
function RenameGroup({
  group,
  onCancel,
  rename,
}: {
  group: groupOperations.Group;
  onCancel: () => void;
  rename: (name: string) => Promise<void>;
}) {
  const { busy, error, run } = useAction();
  return (
    <form
      onSubmit={submitData(async (form) => {
        const next = form.get('name');
        if (typeof next === 'string' && next.trim()) await run(() => rename(next.trim()));
      })}
      className="grid gap-4"
    >
      <div className="grid gap-2">
        <Label htmlFor="group-name">Name</Label>
        <Input
          id="group-name"
          name="name"
          required
          autoFocus
          maxLength={200}
          defaultValue={group.name ? groupName(group) : ''}
        />
      </div>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}

/** "New group": a name, sealed to the space's owners. The group starts empty. */
export function NewGroupDialog({
  spaceId,
  open,
  onClose,
  onDone,
}: {
  spaceId: SpaceId;
  open: boolean;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const queryClient = useQueryClient();
  const { locked, hold } = useHoldOpen();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent locked={locked}>
        <HoldOpen value={hold}>
          {open && (
            <NewGroupForm
              create={async (name) => {
                await runCommand(createGroup, { spaceId, name }, { satisfies, ctx });
                await queryClient.invalidateQueries({
                  queryKey: groupsQuery(ctx, spaceId).queryKey,
                });
                onDone(name);
              }}
            />
          )}
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

function NewGroupForm({ create }: { create: (name: string) => Promise<void> }) {
  const { busy, error, run } = useAction();
  return (
    <form
      onSubmit={submitData(async (form) => {
        const name = form.get('name');
        if (typeof name === 'string' && name.trim()) await run(() => create(name.trim()));
      })}
      className="grid gap-4"
    >
      <DialogHeader>
        <DialogTitle>New group</DialogTitle>
        <DialogDescription>
          Its name is encrypted, and only the space’s owners see it. Add people, then share folders
          with it.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2">
        <Label htmlFor="new-group-name">Name</Label>
        <Input id="new-group-name" name="name" required autoFocus maxLength={200} />
      </div>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button type="submit" disabled={busy}>
          Create group
        </Button>
      </DialogFooter>
    </form>
  );
}

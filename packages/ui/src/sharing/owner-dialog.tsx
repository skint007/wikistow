import { ownerOperations, type IdentityId, type SpaceId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
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
import { addCoOwner, deleteSpace, finishTransfer, removeOwner } from '../commands/sharing-commands';
import { refreshAccess, spaceAccessQuery, spaceKeysQuery, treeQuery } from '../data/queries';
import { groupName, peopleIn } from './groups';
import { sharingMessage } from './messages';
import { useOwnerRequirements } from './owner-standing';
import { useClient } from '../vault/store';
import { useKeyReview, type KeyOutcome } from './key-change';
import { nameOf, shareNameById } from './names';
import { describePerson, peopleQuery, type Person } from './people';
import { PersonFinder, type Found } from './person-finder';
import { NewMark } from './new-mark';
import { RotationConfirm } from './rotation-confirm';
import { ErrorLine, useAction, HoldOpen, useHoldOpen } from './use-action';

/** An ownership change, or deleting the space, for an owner to confirm. */
export type OwnerAction =
  | { kind: 'add' }
  | { kind: 'transfer' }
  /** Remove an owner, this person included; `retry` when an earlier try didn't go through. */
  | { kind: 'remove'; ownerId: IdentityId; retry: boolean }
  /** After a transfer, renew the keys the previous owner still knows. */
  | { kind: 'renew'; previousOwner: IdentityId }
  | { kind: 'delete' };

/**
 * Add a co-owner, hand the space over, remove an owner, renew the keys
 * after a transfer (protocol section 7.6), or delete the space. Each says
 * what it gives or takes away before it does it, and every key rotation
 * shows who keeps access first. Deleting offers leaving or a transfer
 * instead, which `onAction` switches to.
 */
export function OwnerDialog({
  spaceId,
  action,
  onAction,
  onClose,
}: {
  spaceId: SpaceId;
  action: OwnerAction | null;
  onAction: (action: OwnerAction) => void;
  onClose: () => void;
}) {
  const { panel, review, labels } = useKeyReview(action !== null);
  const { locked, hold } = useHoldOpen();
  const self = useClient().identity.public.id;
  const leaving = action?.kind === 'remove' && action.ownerId === self;
  const title = !action
    ? ''
    : action.kind === 'add'
      ? 'Add a co-owner'
      : action.kind === 'transfer'
        ? 'Transfer this space'
        : action.kind === 'renew'
          ? 'Renew this space’s keys'
          : action.kind === 'delete'
            ? 'Delete this space'
            : leaving
              ? 'Leave this space'
              : action.retry
                ? 'Finish removing an owner'
                : 'Remove an owner';
  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent dialogClassName="sm:max-w-xl" {...labels} locked={locked}>
        <HoldOpen value={hold}>
          {panel}
          <div className="grid gap-4" hidden={panel !== null}>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>
                {leaving
                  ? 'Every shared folder gets new keys without you. You keep what you could already read.'
                  : action?.kind === 'remove'
                    ? 'Every shared folder gets new keys without them. They keep what they could already read.'
                    : action?.kind === 'renew'
                      ? 'Every shared folder gets new keys, so the previous owner can’t read what’s saved from now on.'
                      : action?.kind === 'delete'
                        ? 'Everything in it is deleted for good, for everyone: every page, folder and attachment, and all their history. It can’t be undone.'
                        : 'An owner holds every key in the space: every folder, page and draft, shared or not.'}
              </DialogDescription>
            </DialogHeader>
            {action?.kind === 'remove' ? (
              <RemoveOwner
                spaceId={spaceId}
                ownerId={action.ownerId}
                review={review}
                onClose={onClose}
              />
            ) : action?.kind === 'delete' ? (
              <DeleteSpace spaceId={spaceId} onAction={onAction} onClose={onClose} />
            ) : action?.kind === 'renew' ? (
              <RenewKeys
                spaceId={spaceId}
                previousOwner={action.previousOwner}
                review={review}
                onClose={onClose}
              />
            ) : action ? (
              <AddOwner
                spaceId={spaceId}
                transfer={action.kind === 'transfer'}
                review={review}
                onClose={onClose}
              />
            ) : null}
          </div>
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Add a co-owner, or hand the space over: add them, then leave. Leaving is a
 * removal like any other, so the owner sees who keeps each share before it
 * is sent; if the owner stops there, the new owner stays added.
 */
function AddOwner({
  spaceId,
  transfer,
  review,
  onClose,
}: {
  spaceId: SpaceId;
  transfer: boolean;
  review: (person: Person) => Promise<KeyOutcome>;
  onClose: () => void;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const queryClient = useQueryClient();
  const { data: keys } = useQuery(spaceKeysQuery(ctx, spaceId));
  const [found, setFound] = useState<Found | null>(null);
  const [added, setAdded] = useState(false);
  const [records, setRecords] = useState<number | null>(null);
  const { busy, error, run } = useAction();

  if (!found) {
    return (
      <PersonFinder
        withAccess={false}
        submitLabel="Next"
        review={review}
        exclude={(person) =>
          keys?.listed.some((o) => o.identity.id === person.id) ? (
            <>
              <Name>{person.name}</Name> is an owner already.
            </>
          ) : null
        }
        onFound={setFound}
      />
    );
  }
  const { person } = found;
  if (added) {
    return (
      <RemoveOwner
        spaceId={spaceId}
        ownerId={ctx.identity.public.id}
        intro={
          <p className="text-sm">
            <Name>{person.name}</Name> is an owner now. Next you leave: check who keeps each shared
            folder, then confirm. If you stop here, you both stay owners, and you can leave later
            from Members and owners.
          </p>
        }
        cancelLabel="Stay an owner for now"
        review={review}
        onClose={onClose}
      />
    );
  }
  const go = () =>
    run(async () => {
      setRecords(0);
      try {
        await runCommand(
          addCoOwner,
          { spaceId, person: person.entry },
          {
            satisfies,
            ctx,
            onProgress: ({ records: done }) => setRecords(done),
          },
        );
      } finally {
        setRecords(null);
      }
      await refreshAccess(queryClient, ctx);
      if (transfer) setAdded(true);
      else onClose();
    });
  return (
    <div className="grid gap-4">
      <p className="text-sm">
        {transfer ? 'Hand this space to ' : 'Make '}
        <strong>
          <Name>{person.name}</Name>
        </strong>
        {person.email && (
          <span className="text-muted-foreground">
            {' '}
            (<Name>{person.email}</Name>)
          </span>
        )}
        {transfer ? '.' : ' an owner.'} {person.status === 'new' && <NewMark />}
      </p>
      <ul className="grid list-disc gap-1 rounded-control bg-muted p-3 pl-7 text-sm">
        <li>
          <Name>{person.name}</Name> gets every key in this space, including every draft and every
          page that isn’t shared.
        </li>
        <li>They can share, remove people, and add or remove owners.</li>
        <li>The first time they open the space, they’re asked to confirm that you added them.</li>
        {transfer && (
          <li>
            Then you leave: you see who keeps each shared folder before anything changes. You stop
            being an owner, and lose access unless someone shares a folder with you.{' '}
            <Name>{person.name}</Name>’s app then offers to renew the keys of every shared folder.
          </li>
        )}
      </ul>
      {records !== null && (
        <p role="status" className="text-sm font-bold">
          Sealing keys… {records} {records === 1 ? 'version' : 'versions'} done
        </p>
      )}
      <ErrorLine error={error} />
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={() => setFound(null)}>
          Back
        </Button>
        <Button disabled={busy} onClick={() => void go()}>
          {transfer ? 'Add them, then review leaving' : 'Make owner'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function RemoveOwner({
  spaceId,
  ownerId,
  intro,
  cancelLabel,
  review,
  onClose,
}: {
  spaceId: SpaceId;
  ownerId: IdentityId;
  intro?: ReactNode;
  cancelLabel?: string;
  review: (person: Person) => Promise<KeyOutcome>;
  onClose: () => void;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const { data: keys } = useQuery(spaceKeysQuery(ctx, spaceId));
  const { data: people } = useQuery(peopleQuery(ctx, [ownerId]));
  const leaving = ownerId === ctx.identity.public.id;
  const who = people?.get(ownerId) ?? describePerson(ctx, ownerId, null);
  return (
    <RotationConfirm
      title={
        leaving ? (
          // Inside the Transfer dialog it is the step's question; on its own the dialog asks it.
          intro ? (
            'Leave this space?'
          ) : (
            'Who keeps access'
          )
        ) : (
          <>
            Remove <Name>{who.name}</Name> as an owner?
          </>
        )
      }
      intro={
        intro ?? (
          <p className="text-sm">
            {leaving ? (
              'You stop being an owner. You lose access to the space, unless someone shares a folder with you.'
            ) : (
              <>
                <Name>{who.name}</Name> stops being an owner. Their agents lose access to the space
                too.
              </>
            )}
          </p>
        )
      }
      confirmLabel={leaving ? 'Leave' : 'Remove owner'}
      {...(cancelLabel ? { cancelLabel } : {})}
      none="Nothing in this space is shared, so no keys change."
      confirmNone
      make={() => ownerOperations.planOwnerRemoval(ctx, { spaceId, ownerId })}
      plansOf={(removal) =>
        removal.rotations.map(({ plan }) => ({ label: shareNameById(tree, plan.shareId), plan }))
      }
      apply={(removal) => runCommand(removeOwner, { removal }, { satisfies, ctx })}
      ownerIds={new Set(keys?.listed.map((o) => o.identity.id).filter((id) => id !== ownerId))}
      review={review}
      onCancel={onClose}
      onDone={async () => {
        await refreshAccess(queryClient, ctx);
        onClose();
        if (leaving) await navigate({ to: '/' });
      }}
    />
  );
}

/**
 * Finish a transfer (section 7.6): renew every share the previous owner
 * still knows the keys of, once the new owner has seen who keeps each.
 */
function RenewKeys({
  spaceId,
  previousOwner,
  review,
  onClose,
}: {
  spaceId: SpaceId;
  previousOwner: IdentityId;
  review: (person: Person) => Promise<KeyOutcome>;
  onClose: () => void;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const queryClient = useQueryClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const { data: keys } = useQuery(spaceKeysQuery(ctx, spaceId));
  return (
    <RotationConfirm
      title="Who keeps access"
      confirmLabel="Renew keys"
      none="Every shared folder already has keys you made, so no keys change."
      confirmNone
      make={() => ownerOperations.planTransferRenewal(ctx, { spaceId, previousOwner })}
      plansOf={(renewal) =>
        renewal.rotations.map(({ plan }) => ({ label: shareNameById(tree, plan.shareId), plan }))
      }
      apply={(renewal) => runCommand(finishTransfer, { renewal }, { satisfies, ctx })}
      ownerIds={new Set(keys?.listed.map((o) => o.identity.id))}
      review={review}
      onCancel={onClose}
      onDone={async () => {
        await refreshAccess(queryClient, ctx);
        onClose();
      }}
    />
  );
}

/**
 * Delete the space for everyone, once the owner has typed its name, or
 * "delete" when its name can't be read. When anyone else has access, it
 * names them first, and offers leaving or a transfer instead, so they keep
 * their pages.
 */
function DeleteSpace({
  spaceId,
  onAction,
  onClose,
}: {
  spaceId: SpaceId;
  onAction: (action: OwnerAction) => void;
  onClose: () => void;
}) {
  const ctx = useClient();
  const satisfies = useOwnerRequirements(spaceId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const access = useQuery(spaceAccessQuery(ctx, spaceId));
  const { keys, shares, groups } = access.data ?? {};
  const self = ctx.identity.public.id;
  const coOwners = keys?.listed.map((o) => o.identity.id).filter((id) => id !== self) ?? [];
  // Groups with folders and people; their agents are an owner's or their people's.
  const sharedGroups =
    groups?.groups.filter((g) => g.shares.length > 0 && peopleIn(g).length > 0) ?? [];
  const members = [
    ...new Set([
      ...(shares?.flatMap((s) => s.members.map((m) => m.identityId)) ?? []),
      ...sharedGroups.flatMap((g) => peopleIn(g).map((m) => m.identity.id)),
    ]),
  ].filter((id) => id !== self && !coOwners.includes(id));
  // Other people's agents; those people are listed already.
  const agents = shares?.some((s) => s.agents.some((a) => a.personId !== self)) ?? false;
  const { data: people } = useQuery({
    ...peopleQuery(ctx, [...coOwners, ...members]),
    enabled: coOwners.length + members.length > 0,
  });
  const nameOfPerson = (id: string) => (people?.get(id) ?? describePerson(ctx, id, null)).name;
  const name = nameOf(tree?.space?.metadata);
  const [typed, setTyped] = useState('');
  const { busy, error, run } = useAction();
  const shared = coOwners.length + members.length + sharedGroups.length > 0;

  const go = () =>
    run(async () => {
      if (!keys) return;
      try {
        await runCommand(
          deleteSpace,
          { spaceId, permissionVersion: keys.permissionVersion },
          { satisfies, ctx },
        );
      } catch (caught) {
        // Who has access changed: show it as it is now, for another try.
        if (caught instanceof ApiError && caught.code === 'permission-version') {
          void access.refetch();
        }
        throw caught;
      }
      onClose();
      await navigate({ to: '/' });
      await refreshAccess(queryClient, ctx);
    });
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void go();
      }}
    >
      {shared && (
        <>
          <div className="grid gap-1.5">
            <p className="text-sm font-bold">Who loses access</p>
            <ul className="grid list-disc gap-1 rounded-control bg-muted p-3 pl-7 text-sm">
              {coOwners.map((id) => (
                <li key={id}>
                  <Name>{nameOfPerson(id)}</Name>{' '}
                  <span className="text-muted-foreground">(owner)</span>
                </li>
              ))}
              {sharedGroups.map((group) => (
                <li key={group.groupId}>
                  <Name>{groupName(group)}</Name>{' '}
                  <span className="text-muted-foreground">(group)</span>
                </li>
              ))}
              {members.map((id) => (
                <li key={id}>
                  <Name>{nameOfPerson(id)}</Name>
                </li>
              ))}
              {agents && <li>Agents people gave access to its folders</li>}
            </ul>
          </div>
          <div className="grid gap-2 rounded-control border p-3 text-sm">
            <p>
              {coOwners.length > 0
                ? 'To let them keep their pages, leave the space instead. The other owners keep it. Or transfer it to someone.'
                : 'To let them keep their pages, transfer the space to someone instead.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {coOwners.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onAction({ kind: 'remove', ownerId: self, retry: false })}
                >
                  Leave instead
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onAction({ kind: 'transfer' })}
              >
                Transfer instead
              </Button>
            </div>
          </div>
        </>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="delete-space-name">
          {name === null ? (
            <span>
              Type <strong>delete</strong> to confirm
            </span>
          ) : (
            <span>
              Type the space’s name,{' '}
              <strong>
                <Name>{name}</Name>
              </strong>
              , to confirm
            </span>
          )}
        </Label>
        <Input
          id="delete-space-name"
          autoComplete="off"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
      <ErrorLine error={error ?? (access.error ? sharingMessage(access.error) : null)} />
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={
            busy ||
            access.isFetching ||
            access.isError ||
            !keys ||
            typed.trim() !== (name ?? 'delete').trim()
          }
        >
          Delete for good
        </Button>
      </DialogFooter>
    </form>
  );
}

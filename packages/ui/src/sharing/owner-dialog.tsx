import { ownerOperations, type IdentityId, type SpaceId } from '@wikistow/client';
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
import { runCommand } from '../commands/command';
import { addCoOwner, finishTransfer, removeOwner } from '../commands/sharing-commands';
import { refreshAccess, spaceKeysQuery, treeQuery } from '../data/queries';
import { useOwnerRequirements } from './owner-standing';
import { useClient } from '../vault/store';
import { useKeyReview, type KeyOutcome } from './key-change';
import { shareNameById } from './names';
import { describePerson, peopleQuery, type Person } from './people';
import { PersonFinder, type Found } from './person-finder';
import { NewMark } from './new-mark';
import { RotationConfirm } from './rotation-confirm';
import { ErrorLine, useAction, HoldOpen, useHoldOpen } from './use-action';

/** An ownership change the members page asks to confirm. */
export type OwnerAction =
  | { kind: 'add' }
  | { kind: 'transfer' }
  /** Remove an owner, this person included; `retry` when an earlier try didn't go through. */
  | { kind: 'remove'; ownerId: IdentityId; retry: boolean }
  /** After a transfer, renew the keys the previous owner still knows. */
  | { kind: 'renew'; previousOwner: IdentityId };

/**
 * Add a co-owner, hand the space over, remove an owner, or renew the keys
 * after a transfer (protocol section 7.6). Each says what it gives or takes
 * away before it does it, and every key rotation shows who keeps access
 * first.
 */
export function OwnerDialog({
  spaceId,
  action,
  onClose,
}: {
  spaceId: SpaceId;
  action: OwnerAction | null;
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

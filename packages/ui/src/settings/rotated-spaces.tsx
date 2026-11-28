// What replacing keys does to the spaces a person owns (protocol section 4.6,
// #327): named before they confirm, and after it lands, the shares left to
// move and a copy of each space they own alone.
import {
  CryptoError,
  keyHash,
  rotatedShareOperations,
  sharingOperations,
  spaceKeys,
  spaceOperations,
  type ClientContext,
  type SpaceId,
} from '@wikistow/client';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { spacesQuery } from '../data/queries';
import { ConfirmCopy } from '../page/confirm-copy';
import { finishingQuery, FinishRotationDialog, leftToFinish } from '../sharing/finish-rotation';
import { nameOf } from '../sharing/names';
import { ErrorLine, HoldOpen, useAction, useHoldOpen } from '../sharing/use-action';
import { PLAIN, useClient } from '../vault/store';

/**
 * A space this person owns: alone or with other owners, whether anyone
 * else is in one of its shared folders, and, owned with others, whether it
 * waits for another owner to add them again at their current key, as no
 * owner statement but their own names it yet.
 */
type Owned = rotatedShareOperations.OwnedSpace & {
  sharing: boolean;
  waitsForReAdd: boolean;
  /**
   * Past key version 1, a space where this app takes no owner action until
   * the person confirms who added them, as after a co-owner added them
   * again: finishing skips it until then (`planFinishing`).
   */
  confirmFirst: boolean;
};

/** The spaces this person owns, alone or with other owners. */
export const ownedQuery = (ctx: ClientContext | null) =>
  queryOptions({
    queryKey: [PLAIN, 'owned-spaces', ctx?.identity.public.keyVersion ?? null],
    enabled: ctx !== null,
    queryFn: async (): Promise<Owned[]> => {
      if (!ctx) return [];
      const self = ctx.identity.public;
      const owned = await rotatedShareOperations.ownedSpaces(ctx);
      return Promise.all(
        owned.map(async (space) => {
          // Unknown counts as shared, and as not waiting: named, never hidden.
          let sharing = true;
          let waitsForReAdd = false;
          let confirmFirst = false;
          if (self.keyVersion > 1) {
            try {
              await sharingOperations.ownerKeys(ctx, space.spaceId);
            } catch (error) {
              // Only where an adder waits to be confirmed, which opening the space asks.
              if (error instanceof CryptoError && error.code === 'unaccepted-owner') {
                const { owners } = await spaceKeys(ctx, space.spaceId).catch(() => ({
                  owners: null,
                }));
                confirmFirst =
                  !!owners && (owners.adderToConfirm !== null || owners.adder !== null);
              }
            }
          }
          try {
            const shares = await sharingOperations.listShares(ctx, space.spaceId);
            sharing = !space.alone || shares.some((share) => share.members.length > 0);
            // Past key version 1, other apps accept this person as an owner
            // only once another owner's statement names their current key.
            if (!space.alone && space.earlierKey && self.keyVersion > 1) {
              const { statements } = await spaceKeys(ctx, space.spaceId);
              const hash = keyHash(self);
              waitsForReAdd = !statements.some(
                (s) => s.owner.id === self.id && s.owner.keyHash === hash && s.signerId !== self.id,
              );
            }
          } catch {
            // Left as unknown.
          }
          return { ...space, sharing, waitsForReAdd, confirmFirst };
        }),
      );
    },
  });

function useOwned(ctx: ClientContext) {
  const { data: owned, isPending, isError, refetch } = useQuery(ownedQuery(ctx));
  const { data: spaces } = useQuery(spacesQuery(ctx));
  const named = (owned ?? []).map((space) => ({
    ...space,
    name: nameOf(spaces?.find((s) => s.id === space.spaceId)?.metadata ?? null) ?? 'A space',
  }));
  return {
    isPending,
    isError,
    refetch,
    // A space owned alone that nobody else is in changes for nobody.
    alone: named.filter((space) => space.checked && space.alone && space.sharing),
    shared: named.filter((space) => space.checked && !space.alone),
    // Its owners couldn't be read: named, as either.
    unchecked: named.filter((space) => !space.checked),
  };
}

const list = (spaces: readonly { spaceId: string; name: string }[]) =>
  spaces.map((space, i) => (
    <span key={space.spaceId}>
      {i > 0 && ', '}
      <Name>{space.name}</Name>
    </span>
  ));

/**
 * Before the person confirms: what happens in each space they own (item 7
 * of #327). A rotation doesn't carry ownership, so co-owners add them again;
 * where they own a space alone nobody can, and its members keep what they
 * had but open nothing new.
 */
export function SpacesBeforeRotation({ ctx }: { ctx: ClientContext }) {
  const { isPending, isError, refetch, alone, shared, unchecked } = useOwned(ctx);
  if (isPending) return <p className="text-muted-foreground">Checking the spaces you own…</p>;
  if (isError) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-destructive">
        This app couldn’t check which spaces you own, so it can’t say what your new keys change
        there yet.
        <Button size="xs" variant="outline" onClick={() => void refetch()}>
          Try again
        </Button>
      </p>
    );
  }
  if (alone.length === 0 && shared.length === 0 && unchecked.length === 0) return null;
  return (
    <div className="grid gap-2" data-testid="rotation-spaces">
      <p className="font-bold">The spaces you own</p>
      <p>
        Your new keys don’t make you an owner by themselves. Once they’re made, your app gives each
        of your shared folders new keys, and asks you who keeps them.
      </p>
      {shared.length > 0 && (
        <p>
          In {list(shared)}, which you own with others, nobody else opens what you share with your
          new keys until another owner adds you again. Their apps will offer it.
        </p>
      )}
      {alone.length > 0 && (
        <p>
          In {list(alone)}, which you own alone, nobody can add you again. The people you share them
          with keep what they could already read, but open nothing new there. To share it again, the
          app offers to copy each one into a new space, shared with nobody until you share it.
        </p>
      )}
      {unchecked.length > 0 && (
        <p>
          This app couldn’t check who else owns {list(unchecked)}. If you own one alone, its people
          open nothing new there after this; if you own it with others, another owner adds you
          again.
        </p>
      )}
    </div>
  );
}

/**
 * After a rotation landed: the shares still to move, with Finish, and each
 * space owned alone with Copy into a new space.
 */
export function SpacesAfterRotation({ ctx }: { ctx: ClientContext }) {
  const owned = useOwned(ctx);
  // A space made since the rotation, at the new key, needs no copy.
  const alone = owned.alone.filter((space) => space.earlierKey);
  const { shared } = owned;
  const { data: finishing, isError: finishingFailed, refetch } = useQuery(finishingQuery(ctx));
  const toFinish = leftToFinish(finishing);
  const failed = (finishing ?? []).some((space) => space.failed.length > 0);
  const waiting = shared.filter((space) => space.waitsForReAdd);
  const confirming = [...owned.alone, ...shared].filter((space) => space.confirmFirst);
  const [finishOpen, setFinishOpen] = useState(false);
  const [copying, setCopying] = useState<{ spaceId: SpaceId; name: string } | null>(null);
  // The new space made for each, so trying again copies into it rather than making another.
  const [made, setMade] = useState<ReadonlyMap<SpaceId, { spaceId: SpaceId; name: string }>>(
    new Map(),
  );
  return (
    <div className="grid gap-3" data-testid="rotation-after">
      {finishingFailed ? (
        <p className="flex flex-wrap items-center gap-2 text-destructive">
          This app couldn’t check your shared folders.
          <Button size="xs" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </p>
      ) : toFinish === null ? (
        <p className="text-muted-foreground">Checking your shared folders…</p>
      ) : toFinish > 0 ? (
        <div className="grid gap-2">
          <p>
            {toFinish === 1
              ? 'A shared folder still uses keys your old key opens.'
              : `${toFinish} shared folders still use keys your old key opens.`}
          </p>
          <Button size="sm" className="justify-self-start" onClick={() => setFinishOpen(true)}>
            Move them to your new keys
          </Button>
        </div>
      ) : waiting.length === 0 && confirming.length === 0 ? (
        <p>Your shared folders use your new keys.</p>
      ) : null}
      {confirming.length > 0 && (
        <p data-testid="rotation-confirm-owner">
          In {list(confirming)}, confirm who added you as an owner: open the space. Until you do,
          its shared folders keep keys your old key opens.
        </p>
      )}
      {failed && (
        <p className="text-destructive">
          This app couldn’t work out new keys for some of them. It tries again each time you unlock.
        </p>
      )}
      {waiting.length > 0 && (
        <p data-testid="rotation-waits-for-owner">
          In {list(waiting)}, which you own with others, nobody else opens what you share with your
          new keys until another owner adds you again. Their apps offer it.
        </p>
      )}
      {alone.length > 0 && (
        <div className="grid gap-2">
          <p>
            You own these spaces alone, so the people you share them with open nothing new there. To
            share one again, copy it into a new space, then share that.
          </p>
          <ul className="grid gap-1">
            {alone.map((space) => (
              <li key={space.spaceId} className="flex flex-wrap items-center gap-2">
                <Name>{space.name}</Name>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setCopying({ spaceId: space.spaceId, name: space.name })}
                >
                  Copy into a new space
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <FinishRotationDialog open={finishOpen} onClose={() => setFinishOpen(false)} />
      {copying && (
        <CopyAloneDialog
          spaceId={copying.spaceId}
          name={copying.name}
          made={made.get(copying.spaceId) ?? null}
          onMade={(into) => setMade((all) => new Map(all).set(copying.spaceId, into))}
          onClose={() => setCopying(null)}
        />
      )}
    </div>
  );
}

/**
 * Copy a space owned alone into a new space (protocol section 4.6, **A
 * space the person owns alone**): the new space first, shared with nobody,
 * then everything in the old one copied into it, with the copy's notes.
 */
function CopyAloneDialog({
  spaceId,
  name,
  made,
  onMade,
  onClose,
}: {
  spaceId: SpaceId;
  name: string;
  /** The new space made on an earlier try, if any. */
  made: { spaceId: SpaceId; name: string } | null;
  onMade: (into: { spaceId: SpaceId; name: string }) => void;
  onClose: () => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState(`${name} (copy)`);
  const { busy, error, run } = useAction();
  // Held open while the copy runs, so it is seen through.
  const { locked, hold } = useHoldOpen();
  const make = () =>
    run(async () => {
      const trimmed = newName.trim() || `${name} (copy)`;
      const created = await spaceOperations.createSpace(ctx, { name: trimmed });
      await queryClient.invalidateQueries({ queryKey: spacesQuery(ctx).queryKey });
      onMade({ spaceId: created, name: trimmed });
    });
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && !locked && onClose()}>
      <DialogContent dialogClassName="sm:max-w-xl" locked={busy || locked}>
        <HoldOpen value={hold}>
          <DialogHeader>
            <DialogTitle>
              Copy <Name>{name}</Name> into a new space
            </DialogTitle>
            <DialogDescription>
              The copy carries everything the space holds, whoever wrote it, signed again as yours.
              It’s shared with nobody until you share it.
            </DialogDescription>
          </DialogHeader>
          {made ? (
            <ConfirmCopy
              sourceSpaceId={spaceId}
              node={null}
              copy
              chosen={{
                spaceId: made.spaceId,
                spaceName: made.name,
                place: { parentId: null, path: [] },
              }}
              onDone={onClose}
            />
          ) : (
            <form
              className="grid gap-3 text-sm"
              onSubmit={(event) => {
                event.preventDefault();
                void make();
              }}
            >
              <label className="grid gap-1">
                <span className="font-bold">Name of the new space</span>
                <input
                  className="rounded-control border border-input bg-background px-3 py-2"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                />
              </label>
              <ErrorLine error={error} />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  Make the new space
                </Button>
              </div>
            </form>
          )}
        </HoldOpen>
      </DialogContent>
    </Dialog>
  );
}

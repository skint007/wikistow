import {
  rotatedShareOperations,
  spaceKeys,
  type ClientContext,
  type SpaceId,
} from '@wikistow/client';
import { queryOptions, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Name } from '@/components/name';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { runCommand } from '../commands/command';
import { requirementsHere } from '../commands/ui-commands';
import { finishShareRotation } from '../commands/sharing-commands';
import { refreshAccess, spacesQuery, treeQuery } from '../data/queries';
import { PLAIN, useClient } from '../vault/store';
import { useKeyReview } from './key-change';
import { nameOf, shareNameById } from './names';
import { RotationConfirm } from './rotation-confirm';
import type { LabelledPlan } from './rotation-review';
import { useTicks } from './ticks';
import { HoldOpen, useHoldOpen } from './use-action';

/**
 * What is left of moving this person's shares to the keys they replaced
 * theirs with (protocol section 4.6): every share of every space they own
 * whose current version they don't write under. Empty once it is done, and
 * for someone who never replaced their keys. Worked out once per unlock,
 * and again after finishing.
 */
export const finishingQuery = (ctx: ClientContext | null) =>
  queryOptions({
    queryKey: [PLAIN, 'rotation-finishing', ctx?.identity.public.keyVersion ?? null],
    queryFn: () => (ctx ? rotatedShareOperations.planFinishing(ctx) : Promise.resolve([])),
    enabled: ctx !== null,
    staleTime: Infinity,
  });

// Where finishing couldn't work out new keys: a space, or a folder in it.
async function failedNames(
  ctx: ClientContext,
  queryClient: QueryClient,
  finishing: readonly rotatedShareOperations.Finishing[],
): Promise<string[]> {
  const spaces = await queryClient.fetchQuery(spacesQuery(ctx));
  const out: string[] = [];
  for (const { spaceId, failed } of finishing) {
    if (failed.length === 0) continue;
    const space = nameOf(spaces.find((s) => s.id === spaceId)?.metadata ?? null) ?? 'A space';
    const tree = await queryClient.fetchQuery(treeQuery(ctx, spaceId)).catch(() => undefined);
    for (const { shareId } of failed) {
      out.push(shareId === null ? space : `${space}: ${shareNameById(tree, shareId)}`);
    }
  }
  return out;
}

/** One share's rotation with where it is, for the review. */
type Labelled = LabelledPlan & { spaceId: SpaceId };

// Each plan named by its space and its folder.
async function labelled(
  ctx: ClientContext,
  queryClient: QueryClient,
  finishing: readonly rotatedShareOperations.Finishing[],
): Promise<Labelled[]> {
  const spaces = await queryClient.fetchQuery(spacesQuery(ctx));
  const out: Labelled[] = [];
  for (const { spaceId, rotations } of finishing) {
    const tree = await queryClient.fetchQuery(treeQuery(ctx, spaceId)).catch(() => undefined);
    const space = nameOf(spaces.find((s) => s.id === spaceId)?.metadata ?? null) ?? 'A space';
    for (const planned of rotations) {
      const folder = shareNameById(tree, planned.plan.shareId);
      out.push({ spaceId, label: `${space}: ${folder}`, plan: planned.plan });
    }
  }
  return out;
}

/**
 * **Finish replacing your keys**: one dialog for every share left, showing
 * who keeps each (protocol section 4.6). Members who got their access only
 * through the person's earlier key are listed unticked: ticked, they keep
 * it, as readers unless raised; left so, they wait. One confirm rotates
 * every share in turn. Shown again at each unlock until it is done.
 */
export function FinishRotationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const { panel, review, labels } = useKeyReview(open);
  const { locked, hold } = useHoldOpen();
  const { ticks, onTick, chosen, reset } = useTicks();
  // The owners the server lists in each space, shown as owners in the review.
  const [ownerIds, setOwnerIds] = useState<ReadonlySet<string>>(new Set());
  // Each time it is shown, everyone offered starts unticked.
  useEffect(() => {
    if (open) reset();
  }, [open]);
  type Made = {
    finishing: rotatedShareOperations.Finishing[];
    plans: Labelled[];
    /** Where new keys couldn't be worked out, by name. */
    failed: string[];
  };
  const make = async (): Promise<Made> => {
    const finishing = await rotatedShareOperations.planFinishing(ctx);
    const owners = new Set<string>([ctx.identity.public.id]);
    // Only to mark owners in the list: a space that can't be read is named among the failures.
    for (const { spaceId, rotations } of finishing) {
      if (rotations.length === 0) continue;
      try {
        for (const { identity } of (await spaceKeys(ctx, spaceId)).listed) owners.add(identity.id);
      } catch {
        // Its rotations show without its other owners marked.
      }
    }
    setOwnerIds(owners);
    return {
      finishing,
      plans: await labelled(ctx, queryClient, finishing),
      failed: await failedNames(ctx, queryClient, finishing),
    };
  };
  const apply = async ({ finishing }: Made) => {
    const all = finishing.flatMap(({ rotations }) => rotations);
    const tick = chosen(all);
    for (const planned of all) {
      await runCommand(
        finishShareRotation,
        { planned, tick: tick.get(planned.plan.shareId) ?? [] },
        { satisfies: requirementsHere(), ctx },
      );
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent dialogClassName="sm:max-w-xl" {...labels} locked={locked}>
        <HoldOpen value={hold}>
          {panel}
          <div className="grid gap-4" hidden={panel !== null}>
            <DialogHeader>
              <DialogTitle>Finish replacing your keys</DialogTitle>
              <DialogDescription>
                Your shared folders still use keys your old key opens. New keys for each one mean
                whoever may hold your old key can’t read what’s saved from now on.
              </DialogDescription>
            </DialogHeader>
            {open && (
              <RotationConfirm
                title="Who keeps access"
                intro={
                  <p className="text-sm">
                    Some people got access only from your old key. Tick the ones you gave it to:
                    they get the new keys. Anyone left unticked waits, keeping what they could
                    already read, until you give them access. In a space you own with others, nobody
                    else opens the new keys, or saves there, until another owner adds you again. In
                    a space you own alone, nobody else ever does: copy it into a new space to share
                    it again.
                  </p>
                }
                confirmLabel="Rotate keys"
                none="No shared folder here is left to move."
                make={make}
                plansOf={(made) => made.plans}
                summary={({ failed }) =>
                  failed.length > 0 && (
                    <p className="text-sm text-destructive">
                      This app couldn’t work out new keys for{' '}
                      {failed.map((name, i) => (
                        <span key={i}>
                          {i > 0 && ', '}
                          <Name>{name}</Name>
                        </span>
                      ))}
                      . It tries again each time you unlock.
                    </p>
                  )
                }
                apply={apply}
                ownerIds={ownerIds}
                review={review}
                ticks={ticks}
                onTick={onTick}
                onCancel={onClose}
                onDone={async () => {
                  await queryClient.invalidateQueries({ queryKey: finishingQuery(ctx).queryKey });
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

/** The folders left to finish, counted, for a note: `null` while unknown. */
export const leftToFinish = (finishing: readonly rotatedShareOperations.Finishing[] | undefined) =>
  finishing === undefined
    ? null
    : finishing.reduce((count, space) => count + space.rotations.length + space.failed.length, 0);

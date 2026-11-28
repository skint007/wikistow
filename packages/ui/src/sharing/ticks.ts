// The offers an owner ticks in a rotation's review (protocol section 4.6):
// members only an earlier key gave access, or who replaced their keys,
// listed unticked, as readers unless raised.
import {
  rotatedShareOperations,
  type RotationOffer,
  type ShareId,
  type sharingOperations,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { useState } from 'react';
import type { Ticks } from './rotation-review';

type Tick = rotatedShareOperations.Tick;
type PlannedRotation = sharingOperations.PlannedRotation;

/** The ticks of one review, cleared with `reset` when it is shown again. */
export function useTicks() {
  const [ticks, setTicks] = useState<Ticks>(new Map());
  const onTick = (shareId: string, offer: RotationOffer, role: 'reader' | 'editor' | null) =>
    setTicks((current) => {
      const next = new Map(current);
      const share = new Map(next.get(shareId));
      if (role) share.set(offer.identityId, role);
      else share.delete(offer.identityId);
      next.set(shareId, share);
      return next;
    });
  // Only offers the plans still make count: one gone since isn't sent.
  const chosen = (plans: readonly PlannedRotation[]) => {
    const out = new Map<ShareId, Tick[]>();
    for (const { plan } of plans) {
      const picked = ticks.get(plan.shareId);
      const ticked = plan.offers.flatMap((offer) => {
        const role = picked?.get(offer.identityId);
        return role ? [{ identityId: offer.identityId, role }] : [];
      });
      if (ticked.length > 0) out.set(plan.shareId, ticked);
    }
    return out;
  };
  return { ticks, onTick, chosen, reset: () => setTicks(new Map()) };
}

/**
 * The rotations to send for what the owner confirmed: as confirmed with no
 * ticks, or else worked out again with them (`again`), and refused as
 * `stale-head`, to be shown again, if that changes more than the ticks.
 */
export async function withTicks(
  confirmed: readonly PlannedRotation[],
  tick: ReadonlyMap<ShareId, readonly Tick[]>,
  again: (tick: ReadonlyMap<ShareId, readonly Tick[]>) => Promise<readonly PlannedRotation[]>,
): Promise<readonly PlannedRotation[]> {
  if (tick.size === 0) return confirmed;
  const planned = await again(tick);
  const changed =
    planned.length !== confirmed.length ||
    confirmed.some((before) => {
      const now = planned.find((p) => p.plan.shareId === before.plan.shareId);
      return (
        !now ||
        rotatedShareOperations.changedBeyondTicks(before, now, tick.get(before.plan.shareId))
      );
    });
  if (changed) throw new ApiError(409, 'stale-head', 'Who keeps the share changed; look again');
  return planned;
}

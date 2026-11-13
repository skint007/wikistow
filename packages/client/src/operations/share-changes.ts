// Changes of a share that a live session must not outlast (protocol section
// 6.8, accepted with ADR 0015): a rotation, an owner's removal, an ending,
// or a move into or out of the share. Before one is sent, the app records
// it as pending in its kept marks and tells its other tabs, so tabs in a
// session of the share stop sending at once; a definite answer clears it,
// raising the No going back mark when the change was accepted.
import { sharingRoutes, type ShareId, type SpaceId } from '@wikistow/contracts';
import { outcomeUnknown } from '../api/client.ts';
import {
  ENDED,
  SEND_LIMIT_MS,
  type MarkRaise,
  type NewChange,
  type PendingChange,
} from '../key-versions.ts';
import type { ClientContext } from './session.ts';

/**
 * Send a change of one or more shares (section 6.8): record each as
 * pending, from the key version this app holds, and wait for that record
 * to land and the other tabs to hear of it; then `send`. A definite
 * answer clears them: an accepted one first raises the marks `accepted`
 * names, from the new version this app made, or `ENDED`. After a lost
 * answer they stay, and no tab joins or sends in those shares' sessions,
 * until the app fetches the shares again (`settleShareChanges`).
 */
export async function sendShareChange<T>(
  ctx: ClientContext,
  changes: readonly NewChange[],
  send: () => Promise<T>,
  accepted: (result: T) => readonly MarkRaise[],
): Promise<T> {
  const begun = (await ctx.marks.begin?.(changes)) ?? [];
  const ids = begun.map((change) => change.id);
  let result: T;
  try {
    result = await send();
  } catch (error) {
    if (outcomeUnknown(error)) await ctx.marks.lose?.(ids);
    else await ctx.marks.settle?.(ids, []);
    throw error;
  }
  await ctx.marks.settle?.(ids, accepted(result));
  return result;
}

/**
 * What a pending change came to, from the shares as the server lists them
 * now: a rotation was accepted only when the share's version is past the
 * one it was sent from and is one whose keys this app sealed, which it
 * holds once it has worked out the space again; an ending only when the
 * share is gone. A move raises nothing. Everything listed is settled.
 */
export function outcomes(
  pending: readonly PendingChange[],
  shares: readonly { shareId: ShareId; currentKeyVersion: number }[],
  sealedHere: (shareId: ShareId, keyVersion: number) => boolean,
): MarkRaise[] {
  const raises: MarkRaise[] = [];
  for (const change of pending) {
    const share = shares.find((s) => s.shareId === change.shareId);
    if (change.change === 'ending') {
      if (!share)
        raises.push({ spaceId: change.spaceId, shareId: change.shareId, keyVersion: ENDED });
    } else if (
      change.change === 'rotation' &&
      share &&
      share.currentKeyVersion > change.fromKeyVersion &&
      sealedHere(share.shareId, share.currentKeyVersion)
    ) {
      raises.push({
        spaceId: change.spaceId,
        shareId: change.shareId,
        keyVersion: share.currentKeyVersion,
      });
    }
  }
  return raises;
}

/**
 * Settle the space's changes left pending by a lost answer, or by a tab
 * that closed while it sent one, once the app
 * has fetched its shares again and opened its envelopes (`spaceKeys`), so
 * it can see which way each went. A failure to fetch leaves them pending.
 */
export async function settleShareChanges(
  ctx: ClientContext,
  spaceId: SpaceId,
  now = Date.now(),
): Promise<void> {
  // A change still being sent, here or in another tab, is never settled
  // under it: only one whose answer was lost, or whose sender went silent.
  const pending = (ctx.marks.pending?.() ?? []).filter(
    (change) => change.spaceId === spaceId && (change.lost || now - change.at > SEND_LIMIT_MS),
  );
  if (pending.length === 0) return;
  const { shares } = await ctx.api.call(sharingRoutes.listShares, { params: { spaceId } });
  const self = ctx.identity.public.id;
  const sealedHere = (shareId: ShareId, keyVersion: number) =>
    ctx.keyring
      .versions(spaceId, shareId)
      .some((held) => held.keyVersion === keyVersion && held.sealer.id === self);
  await ctx.marks.settle?.(
    pending.map((change) => change.id),
    outcomes(pending, shares, sealedHere),
  );
}

// Changes of a share that a live session must not outlast (protocol section
// 6.8, accepted with ADR 0015): a rotation, an owner's removal, an ending,
// or a move into or out of the share. Before one is sent, the app records
// it as pending in its kept marks and tells its other tabs, so tabs in a
// session of the share stop sending at once; a definite answer clears it,
// raising the No going back mark when the change was accepted.
import { sharingRoutes, type ShareId, type SpaceId } from '@wikistow/contracts';
import { ApiError, outcomeUnknown } from '../api/client.ts';
import {
  ENDED,
  requireNotBehind,
  LOST_GRACE_MS,
  RENEW_MS,
  SEND_LIMIT_MS,
  type MarkRaise,
  type NewChange,
  type PendingChange,
} from '../key-versions.ts';
import { spaceKeys } from './keys.ts';
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
  {
    lostMeanwhile = () => false,
  }: {
    /** Whether an earlier try of `send`, which retries itself, got no answer. */
    lostMeanwhile?: () => boolean;
  } = {},
): Promise<T> {
  const { marks } = ctx;
  // Another tab may have raised a mark, or ended the share, while the owner
  // confirmed: never rotate from, end or move under a version behind it.
  await marks.refresh?.();
  for (const { spaceId, shareId, fromKeyVersion } of changes) {
    requireNotBehind({ marks, spaceId, shareId, keyVersion: fromKeyVersion });
  }
  const begun = (await marks.begin?.(changes)) ?? [];
  const ids = begun.map((change) => change.id);
  // This tab never settles by a fetch a change it is still sending, even
  // when its renewals fell behind, as after a laptop slept.
  const mine = inFlight(marks);
  for (const id of ids) mine.add(id);
  // Renewed while it is sent, so no fetch takes it for gone silent.
  const renewing = ids.length > 0 ? setInterval(() => void marks.renew?.(ids), RENEW_MS) : null;
  // While it is sent, this tab holds a lock per change, which a frozen tab
  // keeps and a closed one lets go, so other tabs can tell the two apart.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  for (const id of ids) void holdLock(id, held);
  let result: T;
  try {
    result = await send();
  } catch (error) {
    if (outcomeUnknown(error) || lostMeanwhile()) {
      await marks.lose?.(ids);
      settleAfterGrace(ctx, changes);
    } else {
      await marks.settle?.(ids, []);
    }
    throw error;
  } finally {
    if (renewing) clearInterval(renewing);
    for (const id of ids) mine.delete(id);
    release();
  }
  const raises = accepted(result);
  if (marks.settle) await marks.settle(ids, raises);
  else
    for (const { spaceId, shareId, keyVersion } of raises)
      marks.raise(spaceId, shareId, keyVersion);
  return result;
}

/** How many times the app tries to settle a lost answer before leaving it to the next load. */
const SETTLE_TRIES = 10;

// Once a lost answer's grace has passed, fetch the spaces again, which
// settles what was lost (`spaceKeys`), and again while it stays pending,
// as when the network is still down. It stops once nothing is left to
// settle, as after sign-out, when nothing is pending.
function settleAfterGrace(ctx: ClientContext, changes: readonly NewChange[]): void {
  for (const spaceId of new Set(changes.map((change) => change.spaceId))) {
    let tries = 0;
    const attempt = () => {
      const timer = setTimeout(() => {
        // Nothing left to settle, as after sign-out or another tab's settle.
        if (settleable(ctx, spaceId).length === 0) return;
        void spaceKeys(ctx, spaceId, { refresh: true })
          .catch(() => {})
          .then(() => {
            tries += 1;
            if (tries < SETTLE_TRIES) attempt();
          });
      }, LOST_GRACE_MS + 1_000);
      (timer as { unref?: () => void }).unref?.();
    };
    attempt();
  }
}

/**
 * The space's pending changes a fetch may settle: those whose answer was
 * lost a while ago, or whose sender went silent. A change still being
 * sent, here or in another tab, never is.
 */
export function settleable(
  ctx: Pick<ClientContext, 'marks'>,
  spaceId: SpaceId,
  now = Date.now(),
): PendingChange[] {
  const mine = inFlight(ctx.marks);
  return (ctx.marks.pending?.() ?? []).filter(
    (change) =>
      change.spaceId === spaceId &&
      !mine.has(change.id) &&
      ((change.lostAt !== null && now - change.lostAt > LOST_GRACE_MS) ||
        now - change.at > SEND_LIMIT_MS),
  );
}

/**
 * What a pending change came to, from the shares as the server lists them
 * now: a rotation was accepted only when the share's version is past the
 * one it was sent from and is one whose keys this app sealed, which it
 * holds once it has worked out the space again; an ending only when the
 * share is gone. A move, or a kind this app doesn't know, raises nothing.
 * Everything listed is settled. Once a move's hold lifts, whatever joins
 * the page's sessions reads its region again from the tree first: a lost
 * answer leaves no sign here of which region the page is in.
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
  if (settleable(ctx, spaceId, now).length === 0) return;
  let shares: readonly { shareId: ShareId; currentKeyVersion: number }[] | null;
  try {
    ({ shares } = await ctx.api.call(sharingRoutes.listShares, { params: { spaceId } }));
  } catch (error) {
    // The server says this person can't list the space's shares: they are
    // no owner now, so no change they sent can stand for them, and nothing
    // is raised. Any other failure tells nothing, and leaves them pending.
    const notOwner =
      error instanceof ApiError && (error.code === 'forbidden' || error.code === 'not-found');
    if (!notOwner) throw error;
    shares = null;
  }
  // A renewal or a clear from another tab may have come meanwhile.
  await ctx.marks.refresh?.();
  const pending = await notHeld(settleable(ctx, spaceId, now));
  if (pending.length === 0) return;
  if (shares === null) {
    await ctx.marks.settle?.(
      pending.map((change) => change.id),
      [],
    );
    return;
  }
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

// The Web Locks of this browser, which its tabs share, if any.
const locks = (): LockManager | undefined =>
  typeof navigator !== 'undefined' ? navigator.locks : undefined;
const lockName = (id: string) => `wikistow-share-change-${id}`;

// Hold the change's lock until `held` resolves.
async function holdLock(id: string, held: Promise<void>): Promise<void> {
  await locks()
    ?.request(lockName(id), () => held)
    .catch(() => {});
}

// Those of `changes` no tab holds the lock of: the answer was lost, or the
// tab sending it closed. Where there are no Web Locks, the timestamps alone.
async function notHeld(changes: PendingChange[]): Promise<PendingChange[]> {
  const manager = locks();
  if (!manager || changes.length === 0) return changes;
  const state = await manager.query().catch(() => null);
  if (!state) return changes;
  const taken = new Set((state.held ?? []).map((lock) => lock.name));
  return changes.filter((change) => !taken.has(lockName(change.id)));
}

// The IDs of changes this tab is sending, by its marks.
const sending = new WeakMap<object, Set<string>>();
function inFlight(marks: object): Set<string> {
  let ids = sending.get(marks);
  if (!ids) sending.set(marks, (ids = new Set()));
  return ids;
}

// When each space was last fetched again to settle what was pending.
const lastFetched = new WeakMap<object, Map<SpaceId, number>>();

/**
 * Whether a load of the space's keys should fetch again rather than use
 * what it worked out, to settle a pending change: only while something is
 * settleable, and at most once per grace period, so loads made at once,
 * or a person who can never settle, don't fetch on every call.
 */
export function fetchToSettle(ctx: ClientContext, spaceId: SpaceId, now = Date.now()): boolean {
  if (settleable(ctx, spaceId, now).length === 0) return false;
  const times = lastFetched.get(ctx.spaces) ?? new Map<SpaceId, number>();
  lastFetched.set(ctx.spaces, times);
  if (now - (times.get(spaceId) ?? 0) < LOST_GRACE_MS) return false;
  times.set(spaceId, now);
  return true;
}

// Shares after someone replaced their identity keys (protocol section 4.6,
// #327): the person's own shares rotating to the new key, owners giving a
// member who replaced their keys the share at the new key, adding a rotated
// co-owner again, and the spaces a person owns alone.
import type { IdentityId, ShareId, SpaceId } from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { keyHash } from '../identity.ts';
import { countsForWriting } from '../key-versions.ts';
import type { DirectoryEntry } from '../trust.ts';
import { loadWaiting, type Waiting } from './groups.ts';
import { ownersEntry, spaceKeys, type SpaceKeys } from './keys.ts';
import type { ClientContext } from './session.ts';
import {
  applyShareRotation,
  listShares,
  ownerKeys,
  planShareRotation,
  type PlannedRotation,
} from './sharing.ts';
import { loadSpaces } from './spaces.ts';

/** An offer of a plan the owner ticked, with the role to give (`RotationPlan.offers`). */
export type Tick = { identityId: IdentityId; role: 'reader' | 'editor' };

/**
 * Whether this app's current version of a share is one it writes under: held
 * through no earlier key, and sealed by an owner it accepts for writing. A
 * share whose current version isn't, after a rotation of this person's
 * keys, is one finishing rotates.
 */
export const writesUnderCurrent = (
  ctx: ClientContext,
  keys: SpaceKeys,
  share: { shareId: ShareId; currentKeyVersion: number },
) => {
  const writes = ctx.keyring
    .versions(keys.spaceId, share.shareId)
    .some(
      (h) => h.keyVersion === share.currentKeyVersion && countsForWriting(h, keys.owners.writes),
    );
  // Served to a retired key of this person's too, as when a co-owner sealed
  // the same version again to the new key, it is one the old key opens.
  const self = ctx.identity.public;
  const throughRetired = keys.envelopes.some(
    (e) =>
      e.shareId === share.shareId &&
      e.keyVersion === share.currentKeyVersion &&
      e.recipientId === self.id &&
      e.recipientKeyVersion < self.keyVersion,
  );
  return writes && !throughRetired;
};

/** One space's part of finishing: a rotation of each share left, for the person to confirm. */
export type Finishing = {
  spaceId: SpaceId;
  rotations: PlannedRotation[];
  /** Shares whose rotation couldn't be worked out here, with why; `null` for the whole space. */
  failed: { shareId: ShareId | null; code: string }[];
};

/**
 * What is left of finishing a rotation of this person's keys (section 4.6):
 * in every space the server lists them as an owner of, the shares whose
 * current version this app doesn't write under, each with its rotation
 * planned. Members whose only envelope an earlier key sealed are offered
 * unticked, and wait if left so. Empty once every share is done, and for
 * someone who never replaced their keys. Spaces where this app takes no
 * owner action yet, such as one whose adder it hasn't confirmed, are left
 * for later.
 */
export async function planFinishing(ctx: ClientContext): Promise<Finishing[]> {
  if (ctx.identity.public.keyVersion === 1) return [];
  const spaces = (await loadSpaces(ctx)).filter((space) => space.role === 'owner');
  const out: Finishing[] = [];
  for (const space of spaces) {
    let keys: SpaceKeys;
    try {
      keys = await ownerKeys(ctx, space.id);
    } catch (error) {
      if (!(error instanceof CryptoError || error instanceof ApiError)) throw error;
      // Not an owner who acts here yet, as before confirming who added
      // them: left for later. Anything else can't show it is done.
      if (error.code !== 'unaccepted-owner') {
        out.push({
          spaceId: space.id,
          rotations: [],
          failed: [{ shareId: null, code: error.code }],
        });
      }
      continue;
    }
    const finishing: Finishing = { spaceId: space.id, rotations: [], failed: [] };
    let shares: Awaited<ReturnType<typeof listShares>>;
    try {
      shares = await listShares(ctx, space.id);
    } catch (error) {
      if (!(error instanceof CryptoError || error instanceof ApiError)) throw error;
      out.push({ ...finishing, failed: [{ shareId: null, code: error.code }] });
      continue;
    }
    for (const share of shares) {
      if (writesUnderCurrent(ctx, keys, share)) continue;
      try {
        finishing.rotations.push(
          await planShareRotation(ctx, { spaceId: space.id, shareId: share.shareId, keys }),
        );
      } catch (error) {
        if (!(error instanceof CryptoError || error instanceof ApiError)) throw error;
        // A share rooted in the trash gives nobody anything until restored.
        if (error instanceof ApiError && error.code === 'not-found') continue;
        finishing.failed.push({ shareId: share.shareId, code: error.code });
      }
    }
    if (finishing.rotations.length > 0 || finishing.failed.length > 0) out.push(finishing);
  }
  return out;
}

/**
 * Whether a rotation worked out again with the offers the person ticked
 * (`tick`) changes more than those ticks against the one they confirmed:
 * anyone else kept, left out or demoted differently, or a ticked member not
 * at the key and role they were offered at and ticked for. Then it must be
 * shown again, never sent.
 */
export function changedBeyondTicks(
  confirmed: PlannedRotation,
  planned: PlannedRotation,
  tick: readonly Tick[] = [],
): boolean {
  const ticked = new Set<string>(tick.map((t) => t.identityId));
  const people = (p: PlannedRotation) =>
    JSON.stringify([
      p.plan.shareId,
      p.plan.keyVersion,
      p.plan.remaining
        .filter(({ identity }) => !ticked.has(identity.id))
        .map(({ identity, role }) => `${identity.id} ${keyHash(identity)} ${role}`)
        .sort(),
      [...p.plan.removed].sort(),
    ]);
  // Each ticked member at the key the person saw them offered at.
  const offeredAt = (id: string) =>
    confirmed.plan.offers.find((o) => o.identityId === id)?.identity;
  // Every demotion confirmed stays; a tick as a reader may add its own.
  return (
    people(planned) !== people(confirmed) ||
    confirmed.plan.demoted.some((id) => !planned.plan.demoted.includes(id)) ||
    planned.plan.demoted.some((id) => !ticked.has(id) && !confirmed.plan.demoted.includes(id)) ||
    tick.some((t) => {
      const shown = offeredAt(t.identityId);
      const now = planned.plan.remaining.find(({ identity }) => identity.id === t.identityId);
      return !shown || !now || keyHash(now.identity) !== keyHash(shown) || now.role !== t.role;
    })
  );
}

/**
 * Send one rotation the person confirmed, with the offers they ticked.
 * It is worked out again with them: if more than the ticks changed who
 * keeps the share, it stops with `stale-head`, to be shown again.
 */
export async function applyWithTicks(
  ctx: ClientContext,
  confirmed: PlannedRotation,
  tick: readonly Tick[] = [],
): Promise<number> {
  const { spaceId, shareId } = confirmed.plan;
  // Worked out as confirmed: the same members left out and demoted.
  const leaveOut = confirmed.plan.leftOut
    .filter((l) => l.reason === 'left-out')
    .map((l) => l.identityId);
  const planned =
    tick.length === 0
      ? confirmed
      : await planShareRotation(ctx, {
          spaceId,
          shareId,
          tick,
          leaveOut,
          demote: confirmed.plan.demoted,
        });
  if (changedBeyondTicks(confirmed, planned, tick)) {
    throw new ApiError(409, 'stale-head', 'Who keeps the share changed; look again');
  }
  return applyShareRotation(ctx, planned);
}

/** Someone waiting in a space who replaced their keys since they were given the share. */
export const replacedKeys = (waiting: Waiting) =>
  waiting.shares.some(
    (share) => share.holds !== null && share.holds.keyVersion < waiting.person.identity.keyVersion,
  );

/**
 * **Rotate keys and give access** for someone who replaced their keys
 * (section 4.6): a rotation of each share of the space they wait in at a
 * key they replaced, ticking them, so the new version and every earlier
 * one go to their new key. Their new key must be one this app accepts, as
 * after following them (`identity-key-changed` otherwise).
 */
export async function planRekey(
  ctx: ClientContext,
  {
    spaceId,
    person,
    tick = new Map(),
  }: {
    spaceId: SpaceId;
    person: DirectoryEntry;
    /** Other offers the owner ticked, by share (`RotationPlan.offers`). */
    tick?: ReadonlyMap<ShareId, readonly Tick[]>;
  },
): Promise<PlannedRotation[]> {
  const keys = await ownerKeys(ctx, spaceId);
  const plans: PlannedRotation[] = [];
  for (const share of await listShares(ctx, spaceId)) {
    const row = share.members.find((m) => m.identityId === person.identity.id);
    if (!row || row.keyVersion >= person.identity.keyVersion) continue;
    let planned: PlannedRotation;
    try {
      // Ticked as their row's role where an owner this app accepts vouched
      // for them, and as a reader where only an earlier key did (section 4.6).
      const first = await planShareRotation(ctx, { spaceId, shareId: share.shareId, keys });
      const offer = first.plan.offers.find((o) => o.identityId === person.identity.id);
      planned = await planShareRotation(ctx, {
        spaceId,
        shareId: share.shareId,
        keys,
        tick: [
          { identityId: person.identity.id, role: offer?.vouched ? row.role : 'reader' },
          ...(tick.get(share.shareId) ?? []).filter((t) => t.identityId !== person.identity.id),
        ],
      });
    } catch (error) {
      // A share rooted in the trash gives nobody anything until restored.
      if (error instanceof ApiError && error.code === 'not-found') continue;
      throw error;
    }
    if (!planned.plan.rekeyed.includes(person.identity.id)) {
      const offered = planned.plan.leftOut.find((l) => l.identityId === person.identity.id);
      throw new CryptoError(
        offered?.reason === 'replaced-keys' ? 'identity-key-changed' : 'missing-key',
        `This app can't give ${person.identity.id} the share at their new key`,
      );
    }
    plans.push(planned);
  }
  return plans;
}

/** Send **Rotate keys and give access** as confirmed: each share's rotation in turn. */
export async function applyRekey(ctx: ClientContext, plans: readonly PlannedRotation[]) {
  for (const planned of plans) await applyShareRotation(ctx, planned);
}

/**
 * Owners the server lists whom this app accepted at an earlier key of
 * theirs, and not at the key it lists them with: they replaced their keys,
 * so they are an owner again only once an owner adds them again (sections
 * 4.6 and 7.6). Until then the app takes no owner action that seals here
 * (`unaccepted-owner`), and offers to add them again (`addCoOwner`). Only a
 * key this app follows counts, never a key change it hasn't confirmed.
 */
export function ownersToAddAgain(ctx: ClientContext, keys: SpaceKeys): DirectoryEntry[] {
  const self = ctx.identity.public.id;
  return keys.listed.filter(({ identity }) => {
    if (identity.id === self) return false;
    const check = ctx.trust.check(identity);
    if (check.kind !== 'pinned' || keyHash(check.identity) !== keyHash(identity)) return false;
    // Accepted here at another key of theirs, by this person's own record.
    const entry = ownersEntry(ctx, keys.spaceId);
    const hash = keyHash(identity);
    if (entry?.removedOwners.includes(identity.id)) return false;
    if (!entry?.owners.some((o) => o.id === identity.id && o.keyHash !== hash)) return false;
    // Accepted at the new key already, as after a re-add whose contacts
    // write landed: done only once a statement naming that key is served,
    // so one whose upload failed is offered again.
    if (!keys.owners.writes(identity)) return true;
    return !keys.statements.some(
      (s) => s.owner.id === identity.id && s.owner.keyHash === hash && s.signerId !== identity.id,
    );
  });
}

/**
 * A space this person owns, with whether the server lists another owner
 * there, and whether this person's own record holds them as its owner at a
 * key other than their current one (or holds no entry for it): one a
 * rotation of their keys changes, unlike a space made since.
 */
export type OwnedSpace = { spaceId: SpaceId; alone: boolean; earlierKey: boolean };

/**
 * The spaces this person owns, as the server lists them, and which of them
 * they own alone (section 4.6): there nobody can add them again after a
 * rotation of their keys, so its members keep what they had and open
 * nothing new, and the app offers to copy it into a new space. A space
 * whose owners can't be read is left out.
 */
export async function ownedSpaces(ctx: ClientContext): Promise<OwnedSpace[]> {
  const spaces = (await loadSpaces(ctx)).filter((space) => space.role === 'owner');
  const self = ctx.identity.public.id;
  const hash = keyHash(ctx.identity.public);
  const out: OwnedSpace[] = [];
  for (const space of spaces) {
    try {
      const keys = await spaceKeys(ctx, space.id);
      const own = ownersEntry(ctx, space.id)?.owners.filter((o) => o.id === self) ?? [];
      out.push({
        spaceId: space.id,
        alone: !keys.listed.some(({ identity }) => identity.id !== self),
        earlierKey: own.length === 0 || own.some((o) => o.keyHash !== hash),
      });
    } catch (error) {
      if (!(error instanceof CryptoError || error instanceof ApiError)) throw error;
    }
  }
  return out;
}

/** Waiting people who replaced their keys, for the owner's **Rotate keys and give access**. */
export const waitingWithNewKeys = async (ctx: ClientContext) =>
  (await loadWaiting(ctx)).filter(replacedKeys);

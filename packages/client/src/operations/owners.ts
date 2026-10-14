// Co-owners and transfer (protocol sections 6.5 and 7.6): adding a co-owner,
// a new owner confirming and naming the owner who added them, removing an
// owner with a rotation of every share, and finishing a transfer.
import {
  ownerRoutes,
  type IdentityId,
  type KeyEnvelopeV2,
  type MetadataEnvelopeV2,
  type SpaceId,
} from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { keyHash, type PublicIdentity } from '../identity.ts';
import { grantMetadataKeyV2 } from '../metadata.ts';
import { signOwnerStatement } from '../owners.ts';
import { grantRevisionKeyV2 } from '../revision.ts';
import type { Lookup } from '../trust.ts';
import { forgetSpaces, ownersEntry, spaceKeys, type SpaceKeys } from './keys.ts';
import { saveContacts, type ClientContext } from './session.ts';
import {
  applyShareRotation,
  forEachRecordKey,
  listShares,
  namedBack,
  ownerKeys,
  planShareRotation,
  sealPlanned,
  sealVersion,
  versionsToGive,
  type PlannedRotation,
  type Progress,
} from './sharing.ts';

/**
 * Add `person` as a co-owner of the space, or re-add an owner whose key
 * change was confirmed (section 7.6): every version of every share with both
 * keys, every owner-region record's key in a v2 envelope, and a statement
 * naming them, in one request. Before that, this app records them as
 * accepted at the key it seals to, which also takes them off its
 * removed-owners list. Transfer starts with this. `onProgress` hears as
 * each part of the owner region's records is sealed.
 */
export async function addCoOwner(
  ctx: ClientContext,
  { spaceId, person, onProgress }: { spaceId: SpaceId; person: Lookup; onProgress?: Progress },
): Promise<void> {
  const keys = await ownerKeys(ctx, spaceId);
  const [added] = ctx.trust.recipients([person]);
  if (!added || added.kind !== 'human') {
    throw new CryptoError('malformed', 'Only a person can own a space');
  }
  keys.owners.sealingOwners({ adding: added });
  await saveContacts(
    ctx,
    [{ kind: 'add-co-owner', spaceId, owner: { id: added.id, keyHash: keyHash(added) } }],
    { sealTo: [added] },
  );

  const folderKeyEnvelopes = [];
  for (const share of await listShares(ctx, spaceId)) {
    for (const held of versionsToGive(ctx, keys, share)) {
      folderKeyEnvelopes.push(
        ...sealVersion(ctx, spaceId, share.shareId, held.keyVersion, held, [
          { identity: added, role: 'editor' },
        ]),
      );
    }
  }
  const keyEnvelopes: KeyEnvelopeV2[] = [];
  const metadataEnvelopes: MetadataEnvelopeV2[] = [];
  await forEachRecordKey(
    ctx,
    keys,
    spaceId,
    { scope: 'owner-region' },
    (item, contentKey) => {
      const grant = { granter: ctx.identity, contentKey, recipient: added };
      if (item.kind === 'revision') {
        keyEnvelopes.push(grantRevisionKeyV2({ ...grant, record: item.record }));
      } else {
        metadataEnvelopes.push(grantMetadataKeyV2({ ...grant, record: item.record }));
      }
    },
    { onProgress },
  );
  await ctx.api.call(ownerRoutes.addOwner, {
    params: { spaceId },
    body: {
      identityId: added.id,
      keyVersion: added.keyVersion,
      statement: signOwnerStatement({
        signer: ctx.identity,
        installationId: ctx.installationId,
        spaceId,
        owner: added,
      }),
      folderKeyEnvelopes,
      keyEnvelopes,
      metadataEnvelopes,
      permissionVersion: keys.permissionVersion,
    },
  });
  forgetSpaces(ctx);
}

/**
 * What a new owner's app asks its person before any owner action in the
 * space (section 6.5): to confirm the owner who added them, named by label
 * ("<label> added you as an owner of <space>"), when the app accepts nobody
 * there yet; and to name them back in a statement of its own. Null when
 * there is nothing to ask.
 */
export async function ownerToConfirm(
  ctx: ClientContext,
  spaceId: SpaceId,
): Promise<PublicIdentity | null> {
  const keys = await spaceKeys(ctx, spaceId, { refresh: true });
  if (keys.owners.adderToConfirm) return keys.owners.adderToConfirm;
  const adder = keys.owners.adder;
  const self = ctx.identity.public;
  if (!adder || !keys.listed.some((owner) => owner.identity.id === self.id)) return null;
  return namedBack(keys, self, adder) ? null : adder;
}

/**
 * The person confirmed the co-owner dialog for `adder`, as `ownerToConfirm`
 * gave it: accept them (and through their statements, the space's other
 * owners), record that in a contacts write, and sign a statement naming
 * them, even if they have left since. If the person declines, call nothing:
 * the app accepts nobody through that statement and takes no owner action.
 */
export async function confirmOwner(
  ctx: ClientContext,
  { spaceId, adder }: { spaceId: SpaceId; adder: PublicIdentity },
): Promise<void> {
  const keys = await spaceKeys(ctx, spaceId, { refresh: true, confirmedAdder: adder });
  const accepted = keys.owners.adder;
  if (!accepted || keyHash(accepted) !== keyHash(adder)) {
    throw new CryptoError('unaccepted-owner', 'That is not the owner who added you');
  }
  await saveContacts(ctx);
  if (namedBack(keys, ctx.identity.public, accepted)) return;
  await ctx.api.call(ownerRoutes.addStatement, {
    params: { spaceId },
    body: {
      statement: signOwnerStatement({
        signer: ctx.identity,
        installationId: ctx.installationId,
        spaceId,
        owner: accepted,
      }),
    },
  });
  forgetSpaces(ctx);
}

/** The removal of an owner, worked out for the owner to confirm: one rotation per share. */
export type PlannedOwnerRemoval = {
  spaceId: SpaceId;
  owner: PublicIdentity;
  rotations: PlannedRotation[];
  /** The space's permission version, which the request carries. */
  permissionVersion: number;
};

/**
 * Work out removing owner `ownerId`, this person included (section 7.6),
 * for the owner to confirm: a rotation of every share leaving them out, in
 * which envelopes they sealed still count (`planShareRotation`). Nothing is
 * recorded until the owner confirms (`applyOwnerRemoval`), so cancelling
 * leaves everything as it was. Only an owner who may act in the space may
 * plan one. A retry after a failure is this again, from the current versions.
 */
export async function planOwnerRemoval(
  ctx: ClientContext,
  { spaceId, ownerId }: { spaceId: SpaceId; ownerId: IdentityId },
): Promise<PlannedOwnerRemoval> {
  const keys = await ownerKeys(ctx, spaceId);
  const listed = keys.listed.find((owner) => owner.identity.id === ownerId);
  if (!listed) throw new CryptoError('unaccepted-owner', `The server lists no owner ${ownerId}`);
  const owner = listed.identity;
  const rotations: PlannedRotation[] = [];
  for (const share of await listShares(ctx, spaceId)) {
    rotations.push(
      await planShareRotation(ctx, { spaceId, shareId: share.shareId, removing: owner, keys }),
    );
  }
  return { spaceId, owner, rotations, permissionVersion: keys.permissionVersion };
}

/**
 * Send an owner removal the owner confirmed: every share's rotation at once.
 * For another owner, this app first adds them to its removed-owners list in
 * a confirmed contacts write, so it never accepts them again unless its
 * person adds them back, and from then until the removal succeeds it
 * refuses every other owner action there (`removalPending`). It then plans
 * the removal again; if the people who keep each share changed since the
 * owner confirmed, it stops with `stale-head`, to be shown again. The
 * server refuses to remove the last owner (`last-owner`). If it fails, plan
 * it again and retry; the contacts change is already there.
 */
export async function applyOwnerRemoval(
  ctx: ClientContext,
  confirmed: PlannedOwnerRemoval,
): Promise<void> {
  const { spaceId, owner } = confirmed;
  let removal = confirmed;
  if (owner.id !== ctx.identity.public.id && !removedHere(ctx, spaceId, owner.id)) {
    await saveContacts(ctx, [{ kind: 'remove-owner', spaceId, ownerId: owner.id }], {
      confirm: true,
    });
    removal = await planOwnerRemoval(ctx, { spaceId, ownerId: owner.id });
    if (!sameRemoval(confirmed, removal)) {
      throw new ApiError(409, 'stale-head', 'The removal changed; confirm it again');
    }
  }
  await ctx.api.call(ownerRoutes.removeOwner, {
    params: { spaceId, identityId: owner.id },
    body: {
      rotations: removal.rotations.map(({ plan }) => ({
        shareId: plan.shareId,
        ...sealPlanned(ctx, plan),
      })),
      permissionVersion: removal.permissionVersion,
    },
  });
  forgetSpaces(ctx);
}

// Whether this app has put `ownerId` on its removed-owners list for the space.
const removedHere = (ctx: ClientContext, spaceId: SpaceId, ownerId: IdentityId) =>
  !!ownersEntry(ctx, spaceId)?.removedOwners.some((id) => id === ownerId);

// Whether two plans of one removal give each share to the same people, by role.
function sameRemoval(a: PlannedOwnerRemoval, b: PlannedOwnerRemoval): boolean {
  const sorted = (items: readonly string[]) => [...items].sort((x, y) => x.localeCompare(y));
  const people = ({ plan }: PlannedRotation) =>
    JSON.stringify([
      plan.shareId,
      plan.keyVersion,
      sorted(plan.remaining.map((r) => `${r.identity.id} ${keyHash(r.identity)} ${r.role}`)),
      sorted(plan.removed),
      sorted(plan.demoted),
    ]);
  const of = (removal: PlannedOwnerRemoval) => sorted(removal.rotations.map(people));
  return JSON.stringify(of(a)) === JSON.stringify(of(b));
}

/**
 * Owners the server still lists whom this app has removed: a removal the
 * owner confirmed that hasn't gone through. The app refuses every other
 * owner action in the space until it does, and offers to retry it
 * (`planOwnerRemoval`, section 7.6).
 */
export function removalPending(ctx: ClientContext, keys: SpaceKeys): PublicIdentity[] {
  return keys.listed
    .filter((owner) => removedHere(ctx, keys.spaceId, owner.identity.id))
    .map((owner) => owner.identity);
}

/**
 * Whether a transfer to this person waits to be finished (section 7.6): the
 * owner who added them, whom this app accepts and hasn't removed, is no
 * longer listed by the server, so they removed themself. The app then
 * offers to rotate every share (`finishTransfer`).
 */
export function transferPending(ctx: ClientContext, keys: SpaceKeys): PublicIdentity | null {
  const adder = keys.owners.adder;
  if (!adder || adder.id === ctx.identity.public.id) return null;
  const listed = keys.listed.some((owner) => owner.identity.id === adder.id);
  return !listed && keys.owners.writes(adder) ? adder : null;
}

/** A transfer's key renewal, worked out for the new owner to confirm: one rotation per share. */
export type PlannedTransferRenewal = {
  spaceId: SpaceId;
  previousOwner: IdentityId;
  rotations: PlannedRotation[];
};

/**
 * Work out finishing a transfer from `previousOwner` (section 7.6), for the
 * new owner to confirm: a plain rotation of every share whose current
 * version this app didn't seal. Members it can't seal to, such as one whose
 * key changed, are left out, so the owner sees them before anything is
 * sent. A retry after a failure is this again: shares already renewed are
 * skipped.
 */
export async function planTransferRenewal(
  ctx: ClientContext,
  { spaceId, previousOwner }: { spaceId: SpaceId; previousOwner: IdentityId },
): Promise<PlannedTransferRenewal> {
  const keys = await ownerKeys(ctx, spaceId);
  const self = ctx.identity.public.id;
  const rotations: PlannedRotation[] = [];
  for (const share of await listShares(ctx, spaceId)) {
    const sealedByMe = ctx.keyring
      .versions(spaceId, share.shareId)
      .some((held) => held.keyVersion === share.currentKeyVersion && held.sealer.id === self);
    if (!sealedByMe) {
      rotations.push(await planShareRotation(ctx, { spaceId, shareId: share.shareId, keys }));
    }
  }
  return { spaceId, previousOwner, rotations };
}

/**
 * Send a transfer's renewal the new owner confirmed (`planTransferRenewal`):
 * each share's rotation, then the previous owner onto the removed-owners
 * list in a confirmed contacts write, after which a version they seal is
 * only read through. A share that fails stops it; plan again and retry,
 * which rotates whatever is still left.
 */
export async function finishTransfer(
  ctx: ClientContext,
  { spaceId, previousOwner, rotations }: PlannedTransferRenewal,
): Promise<void> {
  for (const planned of rotations) await applyShareRotation(ctx, planned);
  await saveContacts(ctx, [{ kind: 'remove-owner', spaceId, ownerId: previousOwner }], {
    confirm: true,
  });
  forgetSpaces(ctx);
}

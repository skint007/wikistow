// Following other people's rotations (protocol sections 4.6 and 8.4): a pin
// moves along a valid chain of statements to the person's new key, with a
// notice, and the person can decline it (**Not them?**). Earlier keys on the
// chain open what those people signed and sealed before, and count for
// nothing else.
import { identityRoutes, ownerRoutes, type IdentityId, type SpaceId } from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import type { ContactsChange } from '../contacts.ts';
import { CryptoError } from '../errors.ts';
import { followedIn, type FollowedEntry } from '../followed.ts';
import { keyHash, sameKeys, type PublicIdentity } from '../identity.ts';
import type { DirectoryEntry } from '../trust.ts';
import { chainFrom } from './chains.ts';
import { saveContacts, type ClientContext } from './session.ts';

// Take a confirmed change that didn't hold out of what waits to be written.
const drop = (ctx: ClientContext, change: ContactsChange) => {
  ctx.contacts.pending = ctx.contacts.pending.filter((pending) => pending !== change);
};

// Whether a failure means only that the chain doesn't check out (or can't
// be fetched), which leaves the key a key change.
const notFollowed = (error: unknown) => error instanceof CryptoError || error instanceof ApiError;

/**
 * Follow the rotations the directory shows in `entries` (section 8.4): for
 * each person pinned at a lower key version than the one listed, fetch the
 * chain from the pin, and if it checks out, move the pin along it in a
 * confirmed contacts write, keeping the keys before as earlier keys. A
 * chain that doesn't check out, a fork, a decline or a removed key on the
 * way leaves the key a key change, with today's warning. Returns whom it
 * followed. An agent follows nobody: its person's record does (section 9.3).
 */
export async function followRotations(
  ctx: ClientContext,
  entries: readonly DirectoryEntry[],
): Promise<PublicIdentity[]> {
  if (ctx.agent) return [];
  const followed: PublicIdentity[] = [];
  const seen = new Set<string>();
  for (const { identity } of entries) {
    if (seen.has(identity.id)) continue;
    seen.add(identity.id);
    const pin = ctx.trust.pinOf(identity.id);
    if (!pin || identity.kind !== 'human') continue;
    if (pin.identity.keyVersion >= identity.keyVersion) continue;
    if (ctx.trust.isDeclined(pin.identity)) continue;
    try {
      const chain = await chainFrom(ctx.api, ctx.installationId, pin.identity);
      // The directory listed one key, and the chain ends at another.
      if (!chain || !sameKeys(chain.last, identity)) continue;
      const change = ctx.trust.followChange(chain);
      if (!change) continue;
      await saveContacts(ctx, [change], { confirm: true }).catch((error: unknown) => {
        // Not held, as when another device declined meanwhile: the key stays a
        // key change, and the follow isn't left to fail every later write.
        drop(ctx, change);
        throw error;
      });
      // The record now holds the follow, and the pin moved with it (`load`).
      ctx.trust.addEarlierKeys(chain);
      followed.push(chain.last);
    } catch (error) {
      if (!notFollowed(error)) throw error;
    }
  }
  // What each space's owners were worked out under changed.
  if (followed.length > 0) ctx.spaces.clear();
  return followed;
}

/**
 * Make sure the trust store holds the earlier keys these references name,
 * for opening what was signed or sealed with them (section 4.6, **Using an
 * earlier key**): for each person pinned above the key version named,
 * fetch their chain from key version 1 to the pin and take it. One that
 * doesn't check out leaves what that key signed unopened.
 */
export async function takeEarlierKeys(
  ctx: ClientContext,
  refs: readonly { id: IdentityId; keyVersion: number }[],
): Promise<void> {
  const wanted = new Set<IdentityId>();
  for (const { id, keyVersion } of refs) {
    const pinned = ctx.trust.pinOf(id)?.identity;
    if (!pinned || keyVersion >= pinned.keyVersion || keyVersion < 1) continue;
    try {
      ctx.trust.requireForOpening(id, keyVersion);
    } catch {
      wanted.add(id);
    }
  }
  for (const id of wanted) {
    const pin = ctx.trust.pinOf(id);
    if (!pin) continue;
    try {
      const { identity: first } = await ctx.api.call(identityRoutes.version, {
        params: { identityId: id, keyVersion: 1 },
      });
      const chain = await chainFrom(ctx.api, ctx.installationId, first, pin.identity);
      if (chain) ctx.trust.addEarlierKeys(chain);
    } catch (error) {
      if (!notFollowed(error)) throw error;
    }
  }
}

/** The follows whose notice the person hasn't seen yet, as the record holds them. */
export const unseenFollows = (ctx: ClientContext): FollowedEntry[] =>
  followedIn(ctx.contacts.book.payloads.private.extensions).filter((entry) => !entry.seen);

/**
 * The follows not confirmed or declined yet, seen or not: for each, the key
 * it started from, which a decline restores and contact details show.
 */
export const followsOf = (ctx: ClientContext): FollowedEntry[] =>
  followedIn(ctx.contacts.book.payloads.private.extensions);

/** The person saw the notice that `id` replaced their keys. */
export async function seeFollow(ctx: ClientContext, follow: FollowedEntry): Promise<void> {
  await saveContacts(ctx, [{ kind: 'seen-follow', id: follow.to.id, keyHash: follow.to.keyHash }]);
}

/**
 * **Not them?** (section 8.4): put every key the chain from `follow.from`
 * reached into `removed`, move the pin back, and record the decline, in a
 * confirmed write. From then on nothing is sealed to that person and no
 * rotation of theirs is followed, until the person confirms a key. Returns
 * the spaces where the person's record accepted a declined key as an
 * owner, for the warning (`declinedOwnerSpaces`).
 */
export async function declineFollow(
  ctx: ClientContext,
  follow: FollowedEntry,
): Promise<DeclinedOwnerSpace[]> {
  const { from } = follow;
  const pin = ctx.trust.pinOf(from.identity.id);
  if (!pin) throw new CryptoError('unknown-identity', `${from.identity.id} isn’t pinned`);
  // Every key from the restored pin up to the pin now: by a valid chain, and
  // at least the keys this app knows, the pin itself included, so a server
  // that stops serving the chain can't stop the decline.
  const chain = await chainFrom(ctx.api, ctx.installationId, from.identity, pin.identity).catch(
    (error: unknown) => {
      if (!notFollowed(error)) throw error;
      return null;
    },
  );
  const known = ctx.trust
    .earlierKeys(from.identity.id)
    .filter((key) => key.keyVersion > from.identity.keyVersion);
  const hashes = [
    ...(chain ? chain.keys.map((key) => keyHash(key)) : []),
    ...known.map((key) => keyHash(key)),
    keyHash(pin.identity),
    follow.to.keyHash,
  ].filter((hashed, i, all) => hashed !== keyHash(from.identity) && all.indexOf(hashed) === i);
  const change: ContactsChange = {
    kind: 'decline-follow',
    from,
    chain: hashes,
    removedAt: new Date().toISOString(),
  };
  await saveContacts(ctx, [change], { confirm: true }).catch((error: unknown) => {
    drop(ctx, change);
    throw error;
  });
  ctx.spaces.clear();
  return declinedOwnerSpaces(ctx, from.identity.id);
}

/**
 * A space where the person's record accepted, as an owner, a key of `id`
 * they declined (section 8.4, **An owner's key the person declined**): the
 * owners whose statements named it (`addedBy`), or none where the app took
 * it by first sight. The app warns, names them, and says what the person
 * can do; it closes nothing.
 */
export type DeclinedOwnerSpace = { spaceId: SpaceId; addedBy: IdentityId[] };

/** The spaces where the record accepts a key of `id` it removed as an owner. */
export async function declinedOwnerSpaces(
  ctx: ClientContext,
  id: IdentityId,
): Promise<DeclinedOwnerSpace[]> {
  const { shared } = ctx.contacts.book.payloads;
  const removed = new Set(shared.removed.filter((r) => r.id === id).map((r) => r.keyHash));
  const out: DeclinedOwnerSpace[] = [];
  for (const entry of shared.spaceOwners) {
    const declined = entry.owners.filter((o) => o.id === id && removed.has(o.keyHash));
    if (declined.length === 0) continue;
    const hashes = new Set(declined.map((o) => o.keyHash));
    // Who named a declined key in a statement, by the statements served.
    let addedBy: IdentityId[] = [];
    try {
      const { statements } = await ctx.api.call(ownerRoutes.statements, {
        params: { spaceId: entry.spaceId },
      });
      addedBy = [
        ...new Set(
          statements
            .filter((s) => s.owner.id === id && hashes.has(s.owner.keyHash))
            .map((s) => s.signerId),
        ),
      ];
    } catch (error) {
      if (!notFollowed(error)) throw error;
    }
    out.push({ spaceId: entry.spaceId, addedBy });
  }
  return out;
}

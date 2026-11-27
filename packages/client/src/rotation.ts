import {
  FolderKeyEnvelope,
  type IdentityId,
  type ShareId,
  type SpaceId,
} from '@wikistow/contracts';
import { CryptoError } from './errors.ts';
import {
  folderKeyEnvelopeBytes,
  sealFolderKeys,
  type FolderKeyring,
  type FolderKeys,
} from './folder-keys.ts';
import {
  isAgentId,
  keyHash,
  verifySignature,
  type PrivateIdentity,
  type PublicIdentity,
} from './identity.ts';
import type { InstallationId } from './ids.ts';
import { highestWritable, requireNotBehind, type KeyVersionMarks } from './key-versions.ts';
import { AcceptedOwners } from './owners.ts';
import type { DirectoryEntry, TrustStore } from './trust.ts';

/** A person a rotation seals the new version to, and what their envelope holds. */
export type RotationRecipient = { identity: PublicIdentity; role: 'reader' | 'editor' };

/** Why a listed member gets no new version. */
export type LeftOutReason =
  /** The owner left them out, or this is the removal of them. */
  | 'left-out'
  /** No verified envelope of the current version is theirs, at the key the server lists: they wait. */
  | 'no-envelope'
  /** Their key changed and the change isn't confirmed (section 8.4). */
  | 'key-changed'
  /** Neither the directory nor this app's pins give a key for them that it can seal to. */
  | 'unknown-key'
  /**
   * Their only verified envelope of the current version was sealed with an
   * earlier key of an owner (section 4.6): they wait unless the owner ticks them.
   */
  | 'old-key'
  /** They replaced their keys (section 4.6): they wait unless the owner ticks them. */
  | 'replaced-keys';

/**
 * A member the owner may tick into a rotation (section 4.6): one whose only
 * envelope of the current version an earlier key of an owner sealed, as a
 * reader unless the owner raises them; or one who replaced their keys, who
 * gets every version at their new key (`rekeyed`). `identity` is the key
 * it would seal to, `role` the most the envelope gives.
 */
export type RotationOffer = {
  identityId: IdentityId;
  reason: 'old-key' | 'replaced-keys';
  identity: PublicIdentity;
  role: 'reader' | 'editor';
  /**
   * False when only an earlier key's envelope holds them, so they are
   * ticked as a reader unless raised (section 4.6).
   */
  vouched: boolean;
};

/** Who a rotation from version `keyVersion - 1` seals `keyVersion` to (section 7.5). */
export type RotationPlan = {
  spaceId: SpaceId;
  shareId: ShareId;
  /** The new version, `v + 1`. */
  keyVersion: number;
  remaining: RotationRecipient[];
  leftOut: { identityId: IdentityId; reason: LeftOutReason }[];
  /** Every listed member left out for good, for the request's `removed`. */
  removed: IdentityId[];
  /** Remaining members who become readers, for the request's `demoted`. */
  demoted: IdentityId[];
  /** Remaining members given every version at their new key, for the request's `rekeyed`. */
  rekeyed: IdentityId[];
  /** Members kept without the new version, for the request's `waiting`. */
  waiting: IdentityId[];
  /** Members left out that the owner may tick in (`tick`), unticked. */
  offers: RotationOffer[];
};

// Reasons a member waits rather than leaves: their row stays, sealed nothing new.
const WAITS: ReadonlySet<LeftOutReason> = new Set(['no-envelope', 'old-key', 'replaced-keys']);

/**
 * Work out who keeps a share after a removal or a key rotation (section 7.5):
 *
 *   remaining = ((E ∩ M) ∪ O) − X
 *
 * E is the human recipients of the version `v` envelopes this app verifies:
 * sealed by an owner in its writing set, with a valid signature. M is the
 * share's members as the server lists them, O the space's sealing owners
 * less any owner this action removes, and X the people being removed or left
 * out, with that owner. A listed member with no key this app can seal to is
 * left out; one with no verified envelope at their listed key waits, kept
 * with no new version. So the server can't slip anyone into the new
 * version: everyone in it either held `v` or is an owner this app accepts,
 * or the owner ticked them by name.
 *
 * Refuses as `key-version` if this app holds no version `v` that counts for
 * writing, or `v` is below its No going back mark. When the action removes
 * an owner (`removing`, section 7.6), envelopes that owner sealed count too,
 * here only, and never move the mark. That owner must be one this app has
 * accepted, at that key, or the plan is refused as `unaccepted-owner`. So
 * removing a server-made owner is refused as `unaccepted-owner`, and so is a
 * plain rotation while the server lists them (`sealingOwners`): the space
 * stays blocked until the server stops listing them.
 *
 * After a rotation of identity keys (section 4.6), a version `v` that an
 * earlier key of an accepted owner sealed, or that this app holds only
 * through its own earlier key, counts here for verifying, never for
 * writing: the rotation moves away from it. Envelopes such a key sealed add
 * nobody to E: those members are offered unticked, as readers unless the
 * owner raises them, and otherwise wait. A member whom the directory lists
 * at a key version above their row's replaced their keys: they wait, or,
 * ticked, get every version at their new key, which this app must accept
 * (section 8.4).
 */
export function planRotation({
  installationId,
  spaceId,
  shareId,
  currentKeyVersion,
  envelopes,
  members,
  owners,
  removing,
  leaveOut = [],
  demote = [],
  tick = [],
  keyring,
  marks,
  trust,
  directory,
}: {
  installationId: InstallationId;
  spaceId: SpaceId;
  shareId: ShareId;
  /** The share's current version `v`, as the server lists it. */
  currentKeyVersion: number;
  /** Every envelope of version `v`, to people and agents, as the server serves them. */
  envelopes: readonly unknown[];
  /** The share's members and their key versions, as the server lists them (M). */
  members: readonly { identityId: IdentityId; keyVersion: number; role?: 'reader' | 'editor' }[];
  /** The space's accepted owners, as `acceptOwners` made them. */
  owners: AcceptedOwners;
  /** The owner this action removes, at the key this app accepted for them (section 7.6). */
  removing?: PublicIdentity;
  /** The members this action removes or the owner leaves out (X, without `removing`). */
  leaveOut?: readonly IdentityId[];
  /** Members who stay as readers. */
  demote?: readonly IdentityId[];
  /** Offers the owner ticked, each with the role to give, at most the offer's. */
  tick?: readonly { identityId: IdentityId; role: 'reader' | 'editor' }[];
  keyring: FolderKeyring;
  marks: KeyVersionMarks;
  trust: TrustStore;
  /** The directory's keys for the members and the envelopes' sealers. */
  directory: readonly DirectoryEntry[];
}): RotationPlan {
  if (!(owners instanceof AcceptedOwners)) {
    throw new CryptoError('malformed', 'A rotation takes owners only as acceptOwners made them');
  }
  if (removing && !owners.opens(removing)) {
    throw new CryptoError(
      'unaccepted-owner',
      `${removing.id} is not an owner this app accepted at this key, so their envelopes don't count`,
    );
  }
  const removedKey = removing && keyHash(removing);
  const counts = (sealer: PublicIdentity) =>
    owners.writes(sealer) || (removedKey !== undefined && keyHash(sealer) === removedKey);

  // Step 1: v must count for writing, or for verifying after a rotation of
  // identity keys, and be at or above the mark.
  const holdsV = keyring
    .versions(spaceId, shareId)
    .some(
      (version) =>
        version.keyVersion === currentKeyVersion &&
        (counts(version.sealer) || owners.earlier(version.sealer)),
    );
  if (!holdsV) {
    throw new CryptoError(
      'key-version',
      `Version ${currentKeyVersion} of share ${shareId} doesn't count for writing in this app`,
    );
  }
  const writable = highestWritable({ keyring, spaceId, shareId, writes: owners.writes });
  if (writable) marks.raise(spaceId, shareId, writable.keyVersion);
  requireNotBehind({ marks, spaceId, shareId, keyVersion: currentKeyVersion });

  // E: who holds v, by a verified envelope from an owner that counts; and
  // who holds it only through an earlier key of an owner.
  const holders = new Map<string, 'reader' | 'editor'>();
  const throughEarlier = new Map<string, 'reader' | 'editor'>();
  for (const raw of envelopes) {
    const parsed = FolderKeyEnvelope.safeParse(raw);
    if (!parsed.success) continue;
    const envelope = parsed.data;
    if (
      envelope.spaceId !== spaceId ||
      envelope.shareId !== shareId ||
      envelope.keyVersion !== currentKeyVersion ||
      isAgentId(envelope.recipientId)
    ) {
      continue;
    }
    let sealer: PublicIdentity;
    try {
      sealer = trust.requireForOpening(envelope.sealerId, envelope.sealerKeyVersion).identity;
    } catch {
      continue;
    }
    const bytes = folderKeyEnvelopeBytes(installationId, envelope);
    // An earlier key vouches for nobody, the owner a removal removes
    // included, whether or not this app has put them on its removed list.
    const fromEarlier =
      owners.earlier(sealer) ||
      (removedKey !== undefined && keyHash(sealer) === removedKey && trust.isEarlier(sealer));
    const into = fromEarlier ? throughEarlier : counts(sealer) ? holders : null;
    if (!into || !verifySignature(sealer, bytes, envelope.signature)) continue;
    const holder = `${envelope.recipientId} ${envelope.recipientKeyVersion}`;
    // An editor's envelope wins over a reader's for the same key.
    if (into.get(holder) !== 'editor') {
      into.set(holder, envelope.draftKey === null ? 'reader' : 'editor');
    }
  }

  const sealingOwners = owners.sealingOwners(removing ? { removing: removing.id } : {});
  const ownerIds = new Set<string>(sealingOwners.map((owner) => owner.id));
  const excluded = new Set<string>(removing ? [...leaveOut, removing.id] : leaveOut);
  for (const owner of ownerIds) {
    if (excluded.has(owner)) {
      throw new CryptoError('malformed', `Owners are never left out of a rotation: ${owner}`);
    }
  }
  const demoting = new Set<string>(demote);
  const ticked = new Map(tick.map((t) => [t.identityId as string, t.role]));
  const remaining: RotationRecipient[] = sealingOwners.map((identity) => ({
    identity,
    role: 'editor',
  }));
  const leftOut: RotationPlan['leftOut'] = [];
  const demoted: IdentityId[] = [];
  const rekeyed: IdentityId[] = [];
  const offers: RotationOffer[] = [];
  for (const member of members) {
    if (ownerIds.has(member.identityId)) continue;
    if (excluded.has(member.identityId)) {
      leftOut.push({ identityId: member.identityId, reason: 'left-out' });
      continue;
    }
    const at = `${member.identityId} ${member.keyVersion}`;
    const counted = holders.get(at);
    const earlier = throughEarlier.get(at);
    const listed = directory.find(({ identity }) => identity.id === member.identityId);
    const replaced = !!listed && listed.identity.keyVersion > member.keyVersion;
    const held: 'reader' | 'editor' | undefined = counted ?? earlier;
    // The most the server lets this rotation seal them: their row's role.
    const most = member.role ?? held ?? 'reader';
    // A member who waits keeps a demotion the change asks for.
    const waits = (reason: LeftOutReason) => {
      leftOut.push({ identityId: member.identityId, reason });
      if (demoting.has(member.identityId) && most === 'editor') demoted.push(member.identityId);
    };
    // One who replaced their keys may be ticked even with no envelope of
    // `v`, as after waiting through a rotation: the owner's tick vouches.
    if (!held && !replaced) {
      waits('no-envelope');
      continue;
    }
    // The key to seal to: their row's, or after they replaced their keys,
    // the directory's current one, which this app must accept.
    const identity = replaced
      ? usableKey(trust, directory, {
          identityId: member.identityId,
          keyVersion: listed.identity.keyVersion,
        })
      : usableKey(trust, directory, member);
    if (typeof identity === 'string') {
      if (replaced) waits('replaced-keys');
      else leftOut.push({ identityId: member.identityId, reason: identity });
      continue;
    }
    // Earlier-key envelopes and replaced keys are the owner's call, by name.
    const offered: RotationOffer | null = replaced
      ? {
          identityId: member.identityId,
          reason: 'replaced-keys',
          identity,
          role: most === 'editor' ? (held ?? 'editor') : 'reader',
          // Only an earlier key's envelope makes them a reader by default.
          vouched: counted !== undefined || earlier === undefined,
        }
      : counted
        ? null
        : {
            identityId: member.identityId,
            reason: 'old-key',
            identity,
            role: held ?? 'reader',
            vouched: false,
          };
    let role: 'reader' | 'editor' = counted ?? 'reader';
    if (offered) {
      const choice = ticked.get(member.identityId);
      if (!choice) {
        offers.push(offered);
        waits(offered.reason);
        continue;
      }
      // Raised only as far as the offer and the row allow: the server seals by the row.
      role =
        choice === 'editor' && offered.role === 'editor' && most === 'editor' ? 'editor' : 'reader';
      if (replaced) rekeyed.push(member.identityId);
    }
    const demotes = demoting.has(member.identityId) || (role === 'reader' && most === 'editor');
    if (demotes) demoted.push(member.identityId);
    remaining.push({ identity, role: demotes ? 'reader' : role });
  }
  return {
    spaceId,
    shareId,
    keyVersion: currentKeyVersion + 1,
    remaining,
    leftOut,
    removed: leftOut.filter((entry) => !WAITS.has(entry.reason)).map((e) => e.identityId),
    demoted,
    rekeyed,
    waiting: leftOut.filter((entry) => WAITS.has(entry.reason)).map((e) => e.identityId),
    offers,
  };
}

// The member's key at the listed version, if the trust store allows it:
// pinned, or seen for the first time and pinned now. Otherwise why not.
// Members are looked up by the ID the server lists, not by email.
function usableKey(
  trust: TrustStore,
  directory: readonly DirectoryEntry[],
  member: { identityId: IdentityId; keyVersion: number },
): PublicIdentity | 'key-changed' | 'unknown-key' {
  const entry = directory.find(
    ({ identity }) =>
      identity.id === member.identityId && identity.keyVersion === member.keyVersion,
  );
  try {
    if (entry) return trust.use({ ...entry, foundBy: null });
    return trust.require(member.identityId, member.keyVersion);
  } catch (error) {
    if (!(error instanceof CryptoError)) throw error;
    return error.code === 'identity-key-changed' ? 'key-changed' : 'unknown-key';
  }
}

/**
 * Seal a planned rotation's new version to each remaining person, both keys
 * for an editor or owner and the published key alone for a reader.
 */
export function sealRotation({
  sealer,
  installationId,
  plan,
  keys,
}: {
  sealer: PrivateIdentity;
  installationId: InstallationId;
  plan: RotationPlan;
  keys: FolderKeys;
}): FolderKeyEnvelope[] {
  return plan.remaining.map(({ identity, role }) =>
    sealFolderKeys({
      sealer,
      installationId,
      spaceId: plan.spaceId,
      shareId: plan.shareId,
      keyVersion: plan.keyVersion,
      recipient: identity,
      keys: { draftKey: role === 'editor' ? keys.draftKey : null, publishedKey: keys.publishedKey },
    }),
  );
}

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
  /** No verified envelope of the current version is theirs, at the key the server lists. */
  | 'no-envelope'
  /** Their key changed and the change isn't confirmed (section 8.4). */
  | 'key-changed'
  /** Neither the directory nor this app's pins give a key for them that it can seal to. */
  | 'unknown-key';

/** Who a rotation from version `keyVersion - 1` seals `keyVersion` to (section 7.5). */
export type RotationPlan = {
  spaceId: SpaceId;
  shareId: ShareId;
  /** The new version, `v + 1`. */
  keyVersion: number;
  remaining: RotationRecipient[];
  leftOut: { identityId: IdentityId; reason: LeftOutReason }[];
  /** Every listed member left out, for the request's `removed`. */
  removed: IdentityId[];
  /** Remaining members who become readers, for the request's `demoted`. */
  demoted: IdentityId[];
};

/**
 * Work out who keeps a share after a removal or a key rotation (section 7.5):
 *
 *   remaining = ((E ∩ M) ∪ O) − X
 *
 * E is the human recipients of the version `v` envelopes this app verifies:
 * sealed by an owner in its writing set, with a valid signature. M is the
 * share's members as the server lists them, O the space's sealing owners
 * less any owner this action removes, and X the people being removed or left
 * out, with that owner. A listed member with no verified envelope at their
 * listed key, or no key this app can seal to, is left out too. So the server
 * can't slip anyone into the new version: everyone in it either held `v` or
 * is an owner this app accepts.
 *
 * Refuses as `key-version` if this app holds no version `v` that counts for
 * writing, or `v` is below its No going back mark. When the action removes
 * an owner (`removing`, section 7.6), envelopes that owner sealed count too,
 * here only, and never move the mark. That owner must be one this app has
 * accepted, at that key, or the plan is refused as `unaccepted-owner`. So
 * removing a server-made owner is refused as `unaccepted-owner`, and so is a
 * plain rotation while the server lists them (`sealingOwners`): the space
 * stays blocked until the server stops listing them.
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
  members: readonly { identityId: IdentityId; keyVersion: number }[];
  /** The space's accepted owners, as `acceptOwners` made them. */
  owners: AcceptedOwners;
  /** The owner this action removes, at the key this app accepted for them (section 7.6). */
  removing?: PublicIdentity;
  /** The members this action removes or the owner leaves out (X, without `removing`). */
  leaveOut?: readonly IdentityId[];
  /** Members who stay as readers. */
  demote?: readonly IdentityId[];
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

  // Step 1: v must count for writing and be at or above the mark.
  const holdsV = keyring
    .versions(spaceId, shareId)
    .some((version) => version.keyVersion === currentKeyVersion && counts(version.sealer));
  if (!holdsV) {
    throw new CryptoError(
      'key-version',
      `Version ${currentKeyVersion} of share ${shareId} doesn't count for writing in this app`,
    );
  }
  const writable = highestWritable({ keyring, spaceId, shareId, writes: owners.writes });
  if (writable) marks.raise(spaceId, shareId, writable.keyVersion);
  requireNotBehind({ marks, spaceId, shareId, keyVersion: currentKeyVersion });

  // E: who holds v, by a verified envelope from an owner that counts.
  const holders = new Map<string, 'reader' | 'editor'>();
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
      sealer = trust.require(envelope.sealerId, envelope.sealerKeyVersion);
    } catch {
      continue;
    }
    const bytes = folderKeyEnvelopeBytes(installationId, envelope);
    if (!counts(sealer) || !verifySignature(sealer, bytes, envelope.signature)) continue;
    const holder = `${envelope.recipientId} ${envelope.recipientKeyVersion}`;
    // An editor's envelope wins over a reader's for the same key.
    if (holders.get(holder) !== 'editor') {
      holders.set(holder, envelope.draftKey === null ? 'reader' : 'editor');
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
  const remaining: RotationRecipient[] = sealingOwners.map((identity) => ({
    identity,
    role: 'editor',
  }));
  const leftOut: RotationPlan['leftOut'] = [];
  const demoted: IdentityId[] = [];
  for (const member of members) {
    if (ownerIds.has(member.identityId)) continue;
    const role = excluded.has(member.identityId)
      ? 'left-out'
      : (holders.get(`${member.identityId} ${member.keyVersion}`) ?? 'no-envelope');
    if (role === 'left-out' || role === 'no-envelope') {
      leftOut.push({ identityId: member.identityId, reason: role });
      continue;
    }
    const identity = usableKey(trust, directory, member);
    if (typeof identity === 'string') {
      leftOut.push({ identityId: member.identityId, reason: identity });
      continue;
    }
    const demotes = demoting.has(member.identityId);
    if (demotes) demoted.push(member.identityId);
    remaining.push({ identity, role: demotes ? 'reader' : role });
  }
  return {
    spaceId,
    shareId,
    keyVersion: currentKeyVersion + 1,
    remaining,
    leftOut,
    removed: leftOut.map((entry) => entry.identityId),
    demoted,
  };
}

// The member's key at the listed version, if the trust store allows it:
// pinned, or seen for the first time and pinned now. Otherwise why not.
// Members are looked up by the ID the server lists, not by email.
function usableKey(
  trust: TrustStore,
  directory: readonly DirectoryEntry[],
  member: { identityId: IdentityId; keyVersion: number },
): PublicIdentity | LeftOutReason {
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

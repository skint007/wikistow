import { AgentEnrollment } from '@wikistow/contracts';
import { canonical, fromBase64 } from './encoding.ts';
import { CryptoError } from './errors.ts';
import {
  isUsableLabel,
  normalizeEmail,
  type ContactsChange,
  type OpenedContacts,
  type Pin,
} from './contacts.ts';
import { declinedIn } from './followed.ts';
import {
  agentIdentityId,
  enrollmentFingerprint,
  hasMatchingKeys,
  keyHash,
  PublicIdentity,
  requireUsableKeys,
  retiredKeys,
  sameKeys,
  sign,
  verifySignature,
  type PrivateIdentity,
} from './identity.ts';
import { RotationChain } from './identity-rotation.ts';
import { IdentityId, InstallationId } from './ids.ts';

export { AgentEnrollment };

/** The bytes an owner signs to enroll an agent. */
export const agentEnrollmentBytes = (e: Omit<AgentEnrollment, 'signature'>) =>
  canonical('agent-enrollment/v1', [
    e.installationId,
    e.agent.id,
    e.agent.kind,
    e.agent.keyVersion,
    fromBase64(e.agent.boxPublicKey),
    fromBase64(e.agent.signPublicKey),
    e.ownerId,
    e.ownerKeyVersion,
  ]);

/**
 * Called from the owner's unlocked session once the person has confirmed that
 * the enrollment fingerprint their browser shows matches the one the agent's
 * CLI printed. `comparedFingerprint` is the one on screen while they compared.
 */
export function enrollAgent({
  installationId,
  owner,
  agent,
  comparedFingerprint,
}: {
  installationId: InstallationId;
  owner: PrivateIdentity;
  agent: PublicIdentity;
  comparedFingerprint: string;
}): AgentEnrollment {
  if (agent.kind !== 'agent')
    throw new CryptoError('malformed', 'Only agent identities can be enrolled');
  if (agent.keyVersion !== 1)
    throw new CryptoError('malformed', 'Agents are enrolled at key version 1 only');
  requireUsableKeys(agent);
  requireDerivedAgentId({ installationId, ownerId: owner.public.id, agent });
  if (
    enrollmentFingerprint({ installationId, owner: owner.public, agent }) !== comparedFingerprint
  ) {
    throw new CryptoError(
      'fingerprint-mismatch',
      'Agent keys from the server do not match the compared enrollment fingerprint',
    );
  }
  const unsigned = {
    installationId,
    agent,
    ownerId: owner.public.id,
    ownerKeyVersion: owner.public.keyVersion,
  };
  return { ...unsigned, signature: sign(owner, agentEnrollmentBytes(unsigned)) };
}

/**
 * Check an enrollment against the human who signed it: this installation, a
 * human owner, an agent at key version 1 whose ID derives from the owner and
 * its keys, keys that section 4.1 accepts, and a valid signature. Throws a
 * `CryptoError`.
 */
export function verifyEnrollment({
  installationId,
  owner,
  enrollment,
}: {
  installationId: InstallationId;
  owner: PublicIdentity;
  enrollment: AgentEnrollment;
}): void {
  if (enrollment.installationId !== installationId) {
    throw new CryptoError('binding-mismatch', 'Enrollment is for another installation');
  }
  if (owner.kind !== 'human') throw new CryptoError('malformed', 'Only people can enroll agents');
  if (enrollment.ownerId !== owner.id || enrollment.ownerKeyVersion !== owner.keyVersion) {
    throw new CryptoError('binding-mismatch', 'Enrollment names another owner');
  }
  if (enrollment.agent.kind !== 'agent')
    throw new CryptoError('malformed', 'Enrollment is not for an agent');
  // Agents never rotate, so every reference to one is at key version 1.
  if (enrollment.agent.keyVersion !== 1)
    throw new CryptoError('malformed', 'Agents are enrolled at key version 1 only');
  requireDerivedAgentId({ installationId, ownerId: owner.id, agent: enrollment.agent });
  requireUsableKeys(enrollment.agent);
  if (!verifySignature(owner, agentEnrollmentBytes(enrollment), enrollment.signature)) {
    throw new CryptoError(
      'bad-signature',
      `Enrollment for ${enrollment.agent.id} is not signed by its owner`,
    );
  }
}

function requireDerivedAgentId({
  installationId,
  ownerId,
  agent,
}: {
  installationId: InstallationId;
  ownerId: IdentityId;
  agent: PublicIdentity;
}): void {
  if (agent.id !== agentIdentityId({ installationId, ownerId, ...agent })) {
    throw new CryptoError(
      'binding-mismatch',
      `${agent.id} is not this owner's agent with these keys`,
    );
  }
}

/**
 * A person as the server's directory lists them: a key, and the display name
 * and email it shows. The name and email become the pin's label the first
 * time the key is seen (section 8.2).
 */
export type DirectoryEntry = { identity: PublicIdentity; name: string; email: string };

/**
 * A directory entry as the app is about to use it. `foundBy` is the email the
 * person typed when they found someone by email, or the one the list of
 * people showed for the person they picked (section 7.3): the directory's
 * email must be that one, the key-change check by email uses it, and a
 * first-seen label stores it (sections 8.2 and 8.4). It is `null` only for
 * a lookup that wasn't by email, say by the identity an envelope names;
 * then the directory's email stands. It is required so that every caller
 * decides which.
 */
export type Lookup = DirectoryEntry & { foundBy: string | null };

export type TrustCheck =
  | { kind: 'pinned'; identity: PublicIdentity }
  /** A key change (section 8.4): the pin this key differs from, by ID or by email. */
  | { kind: 'changed'; pinned: PublicIdentity }
  /** A key the person declined or unpinned, which is never used again unless they confirm it. */
  | { kind: 'removed' }
  | { kind: 'unknown' };

/**
 * The keys this client trusts, for one installation, loaded from and saved to
 * the person's contacts record. The server's directory is untrusted: a key is
 * pinned the first time it is used (section 8.3), and a key that differs from
 * its pin, or from the label of the email it was found by, is a key change.
 * Nothing seals to a changed key, and nothing it signed is accepted, until
 * the person confirms it (section 8.4). Pins never change silently.
 *
 * Every pin, confirmation and decline is also queued as a contacts change;
 * the app writes them with its next contacts write (`takeChanges`).
 *
 * A person who replaced their keys also has **earlier keys**: keys a valid
 * chain of rotation statements reached before their pin (section 4.6). They
 * verify what the person signed with them, for opening only, and are never
 * pinned, sealed to or used to accept anything (`requireForOpening`).
 */
export class TrustStore {
  readonly installationId: InstallationId;
  readonly #pins = new Map<IdentityId, Readonly<PublicIdentity>>();
  // Each person's earlier keys, by key version. Each map came from a chain
  // that ended at their pin, and goes when the pin does.
  readonly #earlier = new Map<IdentityId, ReadonlyMap<number, Readonly<PublicIdentity>>>();
  readonly #removed = new Set<string>();
  // Each person whose rotation the person declined, and the key hash of the
  // pin it restored (`wikistow.declined`, section 8.4): while it is their
  // pin, it counts for opening only, and nothing of theirs is followed.
  readonly #declined = new Map<IdentityId, Set<string>>();
  // Each pin as the record holds it, with its method and when it was made.
  readonly #pinRecords = new Map<IdentityId, Pin>();
  // Each label's key, by its normalized email.
  readonly #labels = new Map<string, { id: string; keyHash: string }>();
  readonly #now: () => Date;
  #changes: ContactsChange[] = [];

  constructor(installationId: InstallationId, now: () => Date = () => new Date()) {
    this.installationId = installationId;
    this.#now = now;
  }

  /**
   * Pin this client's own identity, proven by holding its secret keys. The
   * retired keys its vault holds (`openWithRetired`) are its earlier keys,
   * for opening what it signed and sealed with them (section 4.6).
   */
  pinSelf(identity: PrivateIdentity): void {
    if (!hasMatchingKeys(identity)) {
      throw new CryptoError('malformed', 'Secret keys do not match the public identity');
    }
    this.#pin(identity.public);
    const earlier = new Map(this.#earlier.get(identity.public.id));
    for (const key of retiredKeys(identity)) {
      if (
        key.public.id === identity.public.id &&
        key.public.keyVersion < identity.public.keyVersion &&
        hasMatchingKeys(key)
      ) {
        earlier.set(key.public.keyVersion, Object.freeze({ ...key.public }));
      }
    }
    if (earlier.size > 0) this.#earlier.set(identity.public.id, earlier);
  }

  /**
   * Load the pins, removed keys and labels of the person's opened contacts
   * record. An agent, which never sees the private payload, has no labels.
   */
  load({ shared, private: own }: Pick<OpenedContacts, 'shared' | 'private'>): void {
    for (const pin of shared.contacts) {
      const held = this.#pins.get(pin.identity.id);
      // The record moved the pin since this session took it, as when another
      // device confirmed a key or followed a rotation: the record, which
      // only the person signs, wins.
      if (held && !sameKeys(held, pin.identity)) {
        this.#pins.delete(pin.identity.id);
        this.#earlier.delete(pin.identity.id);
      }
      this.#pin(pin.identity);
      this.#pinRecords.set(pin.identity.id, pin);
    }
    for (const { keyHash: removed } of shared.removed) this.#removed.add(removed);
    this.#declined.clear();
    for (const { id, keyHash: hashed } of declinedIn(shared.extensions)) {
      const ids = this.#declined.get(id) ?? new Set<string>();
      ids.add(hashed);
      this.#declined.set(id, ids);
    }
    for (const { id, keyHash: hashed, email } of own?.labels ?? []) {
      this.#labels.set(email, { id, keyHash: hashed });
    }
  }

  /**
   * `load` a record whose pins or labels disagree with the first-sight pins
   * of `dropped`, as when another device saw those people first (section
   * 8.6): this session's pins of them are forgotten and the record's taken,
   * so the keys this session saw are a key change, or not pinned, from now on.
   */
  reload(
    payloads: Pick<OpenedContacts, 'shared' | 'private'>,
    dropped: readonly PublicIdentity[],
  ): void {
    for (const { id } of dropped) {
      this.#pins.delete(id);
      this.#earlier.delete(id);
    }
    this.load(payloads);
  }

  /**
   * For an agent's own session (section 9.3): pin its person, whose key it
   * pinned at enrollment, once `enrollment` verifies under that key and
   * names exactly this agent, `self`, whose secret keys it holds.
   */
  pinOwnPerson(person: PublicIdentity, enrollment: AgentEnrollment, self: PrivateIdentity): void {
    verifyEnrollment({ installationId: this.installationId, owner: person, enrollment });
    if (!sameKeys(enrollment.agent, self.public)) {
      throw new CryptoError('binding-mismatch', 'The enrollment is for another agent');
    }
    this.pinSelf(self);
    this.#pin(person);
  }

  /**
   * Pin an agent from an enrollment signed by its already-pinned human owner,
   * for this installation. `raw` comes from the server.
   */
  pinEnrolledAgent(raw: unknown): void {
    const parsed = AgentEnrollment.safeParse(raw);
    if (!parsed.success)
      throw new CryptoError('malformed', 'Enrollment has an invalid shape', {
        cause: parsed.error,
      });
    const enrollment = parsed.data;
    const owner = this.require(enrollment.ownerId, enrollment.ownerKeyVersion);
    verifyEnrollment({ installationId: this.installationId, owner, enrollment });
    this.#pin(enrollment.agent);
  }

  /**
   * Compare a key with the pins (section 8.4): by its ID, and, when `email` is
   * given, with the label for that email.
   */
  check(identity: PublicIdentity, email?: string): TrustCheck {
    if (this.#removed.has(keyHash(identity))) return { kind: 'removed' };
    const pinned = this.#pins.get(identity.id);
    // A pin a decline restored counts for opening only (section 8.4).
    if (pinned && this.isDeclined(pinned)) return { kind: 'removed' };
    if (pinned && !sameKeys(pinned, identity)) return { kind: 'changed', pinned };
    const label = email === undefined ? undefined : this.#labels.get(normalizeEmail(email));
    if (label && (label.id !== identity.id || label.keyHash !== keyHash(identity))) {
      const labelled = this.#pins.get(IdentityId.parse(label.id));
      if (labelled) return { kind: 'changed', pinned: labelled };
    }
    return pinned ? { kind: 'pinned', identity: pinned } : { kind: 'unknown' };
  }

  /**
   * The pinned key for checking a signature by `id`. Only the pin: what an
   * earlier key signed counts for opening alone, so it never passes here
   * (`requireForOpening`).
   */
  require(id: IdentityId, keyVersion: number): PublicIdentity {
    const pinned = this.#pins.get(id);
    if (!pinned || pinned.keyVersion !== keyVersion) {
      throw new CryptoError('unknown-identity', `No pinned key for ${id} version ${keyVersion}`);
    }
    return pinned;
  }

  /**
   * The key for checking what `id` signed at `keyVersion`, for **opening
   * only** (section 4.6, **Using an earlier key**): their pin, or one of
   * their earlier keys, with `earlier` saying which. What an earlier key
   * signed is read as the person's earlier writing, with no mark, and counts
   * for nothing else: not for writing, accepting an owner or an agent, or
   * sealing. A key they declined is never returned (`unknown-identity`).
   */
  requireForOpening(
    id: IdentityId,
    keyVersion: number,
  ): { identity: PublicIdentity; earlier: boolean } {
    const pinned = this.#pins.get(id);
    const found =
      pinned?.keyVersion === keyVersion
        ? { identity: pinned, earlier: false }
        : { identity: this.#earlier.get(id)?.get(keyVersion), earlier: true };
    const { identity, earlier } = found;
    if (!identity || this.#removed.has(keyHash(identity))) {
      throw new CryptoError('unknown-identity', `No key for ${id} version ${keyVersion}`);
    }
    return { identity, earlier };
  }

  /** Whether `identity` is an earlier key of its person: one a valid chain moved past. */
  isEarlier(identity: PublicIdentity): boolean {
    const held = this.#earlier.get(identity.id)?.get(identity.keyVersion);
    return held !== undefined && sameKeys(held, identity);
  }

  /** The earlier keys of `id` this store holds, in ascending key version. */
  earlierKeys(id: IdentityId): PublicIdentity[] {
    return [...(this.#earlier.get(id)?.values() ?? [])].sort((a, b) => a.keyVersion - b.keyVersion);
  }

  /** The pin of `id` as the record holds it, or null. */
  pinOf(id: IdentityId): Pin | null {
    return this.#pinRecords.get(id) ?? null;
  }

  /**
   * Whether `pin` is a pin the person's decline restored (`wikistow.declined`):
   * it counts for opening only, and no rotation of theirs is followed.
   */
  isDeclined(pin: PublicIdentity): boolean {
    return this.#declined.get(pin.id)?.has(keyHash(pin)) ?? false;
  }

  /**
   * The contacts change that follows `chain` (section 8.4): from the pin of
   * its person, which must be where it starts, to its end, a key no
   * decline, removed key or earlier follow stands in the way of. It changes
   * nothing here: following is a confirmed write, and the pin moves when
   * the record holding it is loaded (`load`). Null when there is nothing to
   * follow; `identity-key-changed` when the chain can't be followed, which
   * is then a key change.
   */
  followChange(chain: RotationChain): Extract<ContactsChange, { kind: 'follow-key' }> | null {
    if (!(chain instanceof RotationChain)) {
      throw new CryptoError('malformed', 'Only a checked chain is followed');
    }
    if (chain.installationId !== this.installationId) {
      throw new CryptoError('binding-mismatch', 'The chain was checked for another installation');
    }
    const [start] = chain.keys;
    const end = chain.last;
    if (!start || chain.keys.length < 2) return null;
    const pinned = this.#pins.get(end.id);
    const record = this.#pinRecords.get(end.id);
    if (!pinned || !record || !sameKeys(pinned, start)) {
      throw new CryptoError('identity-key-changed', `The chain of ${end.id} starts at another key`);
    }
    if (this.isDeclined(pinned)) {
      throw new CryptoError('identity-key-changed', `A rotation of ${end.id} was declined`);
    }
    if (chain.keys.some((key) => this.#removed.has(keyHash(key)))) {
      throw new CryptoError('identity-key-changed', `The chain of ${end.id} has a declined key`);
    }
    return {
      kind: 'follow-key',
      from: record,
      to: {
        identity: asHuman(PublicIdentity.parse(end)),
        verifiedAt: this.#timestamp(),
        method: 'first-seen',
      },
      chain: chain.keys.map((key) => keyHash(key)),
    };
  }

  /**
   * Take the earlier keys of a pinned person from `chain`, which must end at
   * their pin (section 4.6). Earlier keys from another chain, as from a
   * shorter fetch, must agree with it at every key version both hold. One
   * checked for another installation is `binding-mismatch`. A
   * chain that ends at another key, passes through a key in `removed`, or
   * disagrees with earlier keys taken before is `identity-key-changed`,
   * and nothing is taken. A person not pinned is `unknown-identity`.
   */
  addEarlierKeys(chain: RotationChain): void {
    if (!(chain instanceof RotationChain)) {
      throw new CryptoError('malformed', 'Only a checked chain gives earlier keys');
    }
    if (chain.installationId !== this.installationId) {
      throw new CryptoError('binding-mismatch', 'The chain was checked for another installation');
    }
    const end = chain.last;
    const pinned = this.#pins.get(end.id);
    if (!pinned) throw new CryptoError('unknown-identity', `${end.id} isn’t pinned`);
    if (!sameKeys(pinned, end)) {
      throw new CryptoError('identity-key-changed', `The chain of ${end.id} ends at another key`);
    }
    if (chain.keys.some((key) => this.#removed.has(keyHash(key)))) {
      throw new CryptoError('identity-key-changed', `The chain of ${end.id} has a declined key`);
    }
    const earlier = new Map(this.#earlier.get(end.id));
    for (const key of chain.keys.slice(0, -1)) {
      const held = earlier.get(key.keyVersion);
      if (held && !sameKeys(held, key)) {
        throw new CryptoError('identity-key-changed', `Two chains of ${end.id} disagree`);
      }
      earlier.set(key.keyVersion, key);
    }
    this.#earlier.set(end.id, earlier);
  }

  /**
   * The key to use for someone the directory lists: to seal to them, or to
   * check what they signed. A person seen for the first time is pinned
   * (trust on first sight, A4), labelled with the email they were found by.
   * A key change or a removed key throws `identity-key-changed`, so it stops
   * the action until the person confirms. A directory email other than
   * `foundBy` is `binding-mismatch`, and a first-seen person with no usable
   * label (section 8.2) is `malformed`.
   */
  use(entry: Lookup): PublicIdentity {
    this.#requireUsable([entry]);
    return this.#resolve(entry);
  }

  /**
   * `use` for everyone a dialog seals to, all or nothing: if any one of them
   * is a key change, nobody is pinned and the whole seal stops.
   */
  recipients(entries: readonly Lookup[]): PublicIdentity[] {
    this.#requireUsable(entries);
    return entries.map((entry) => this.#resolve(entry));
  }

  // Throws for any key change or removed key in `entries`, before anything is
  // pinned. Within one batch too, one ID or one email names one key.
  #requireUsable(entries: readonly Lookup[]): void {
    const ids = new Map<string, string>();
    const emails = new Map<string, string>();
    for (const entry of entries) {
      const { identity, name } = entry;
      const normalized = labelEmail(entry);
      const result = this.check(identity, normalized);
      const hashed = keyHash(identity);
      if (
        result.kind === 'changed' ||
        result.kind === 'removed' ||
        (ids.get(identity.id) ?? hashed) !== hashed ||
        (emails.get(normalized) ?? hashed) !== hashed
      ) {
        throw new CryptoError(
          'identity-key-changed',
          result.kind === 'removed'
            ? `The key for ${identity.id} was declined or unpinned`
            : `Key for ${identity.id} changed since it was pinned`,
        );
      }
      if (result.kind === 'unknown') {
        requireHuman(identity);
        if (!isUsableLabel({ name, email: normalized })) {
          throw new CryptoError(
            'malformed',
            `The directory gives ${identity.id} no usable name and email to label them by`,
          );
        }
      }
      ids.set(identity.id, hashed);
      emails.set(normalized, hashed);
    }
  }

  #resolve(entry: Lookup): PublicIdentity {
    return this.#pins.get(entry.identity.id) ?? this.#firstSeen(entry);
  }

  /**
   * The person confirmed a changed key after the warning, having checked it
   * with its owner (section 8.4): it replaces the pin, and the label keeps its
   * name and email. A key they declined or unpinned can be confirmed the same
   * way. A key whose email is another contact's label is refused: that
   * contact must be unpinned first. Someone not pinned yet is labelled by
   * the directory's name, which must be usable (section 8.2), or `malformed`.
   */
  confirmKey(entry: Lookup): PublicIdentity {
    const { identity } = entry;
    requireHuman(identity);
    requireUsableKeys(identity);
    const email = labelEmail(entry);
    const label = this.#labels.get(email);
    if (label && label.id !== identity.id) {
      throw new CryptoError('identity-key-changed', `${email} is another contact's email`);
    }
    const hashed = keyHash(identity);
    const pinned = this.#pins.get(identity.id);
    if (!pinned && !isUsableLabel({ name: entry.name, email })) {
      throw new CryptoError(
        'malformed',
        `The directory gives ${identity.id} no usable name and email to label them by`,
      );
    }
    const declined = pinned !== undefined && this.isDeclined(pinned);
    if (pinned && sameKeys(pinned, identity) && !this.#removed.has(hashed) && !declined) {
      return pinned;
    }
    const confirmed = Object.freeze(PublicIdentity.parse(identity));
    this.#pins.set(identity.id, confirmed);
    // Earlier keys came from a chain to the pin this replaces.
    if (pinned && !sameKeys(pinned, confirmed)) this.#earlier.delete(identity.id);
    this.#removed.delete(hashed);
    this.#declined.delete(identity.id);
    const pin = {
      identity: asHuman(confirmed),
      verifiedAt: this.#timestamp(),
      method: 'confirmed',
    } as const;
    if (pinned) {
      const replaced = keyHash(pinned);
      for (const [email, named] of this.#labels) {
        if (named.id === identity.id) this.#labels.set(email, { id: identity.id, keyHash: hashed });
      }
      this.#changes.push({ kind: 'confirm-key', pin, replaced });
      this.#pinRecords.set(identity.id, pin);
    } else {
      this.#labels.set(email, { id: identity.id, keyHash: hashed });
      this.#changes.push({ kind: 'pin', pin, label: { name: entry.name, email } });
      this.#pinRecords.set(identity.id, pin);
    }
    return confirmed;
  }

  /** The person declined a changed key: it goes into `removed`, and the pin stays. */
  declineKey(identity: PublicIdentity): void {
    const hashed = keyHash(identity);
    if (this.#removed.has(hashed)) return;
    this.#removed.add(hashed);
    this.#changes.push({
      kind: 'decline-key',
      id: identity.id,
      keyHash: hashed,
      removedAt: this.#timestamp(),
    });
  }

  /**
   * The pins, confirmations and declines made since the last call, for the
   * next contacts write. The caller re-applies them on a lost race
   * (`applyContactsChange`).
   */
  takeChanges(): ContactsChange[] {
    const changes = this.#changes;
    this.#changes = [];
    return changes;
  }

  #firstSeen(entry: Lookup): PublicIdentity {
    const { identity, name } = entry;
    const pinned = this.#pin(identity);
    const normalized = labelEmail(entry);
    this.#labels.set(normalized, { id: identity.id, keyHash: keyHash(pinned) });
    const pin = {
      identity: asHuman(pinned),
      verifiedAt: this.#timestamp(),
      method: 'first-seen',
    } as const;
    this.#changes.push({ kind: 'pin', pin, label: { name, email: normalized } });
    this.#pinRecords.set(identity.id, pin);
    return pinned;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  // Pins are validated, frozen copies. Keeping the caller's object would let
  // any later in-place edit to it (a directory cache entry, say) move the pin.
  // Keys libraries disagree about are never pinned (`bad-key`).
  #pin(raw: PublicIdentity): Readonly<PublicIdentity> {
    const identity = Object.freeze(PublicIdentity.parse(raw));
    requireUsableKeys(identity);
    const existing = this.#pins.get(identity.id);
    if (existing && !sameKeys(existing, identity)) {
      throw new CryptoError(
        'identity-key-changed',
        `${identity.id} is already pinned to different keys`,
      );
    }
    this.#pins.set(identity.id, identity);
    return identity;
  }
}

// The email a lookup's label is checked and stored under: the one the person
// typed, which the directory's must match, or else the directory's.
function labelEmail({ identity, email, foundBy }: Lookup): string {
  if (foundBy === null) return normalizeEmail(email);
  const typed = normalizeEmail(foundBy);
  if (normalizeEmail(email) !== typed) {
    throw new CryptoError(
      'binding-mismatch',
      `The directory answered ${typed} with ${identity.id}, listed under another email`,
    );
  }
  return typed;
}

// Agents are trusted through their person's enrollment, never on first sight.
function requireHuman(identity: PublicIdentity): void {
  if (identity.kind !== 'human' || identity.id.startsWith('agent-')) {
    throw new CryptoError('malformed', 'Agents are trusted through their owner’s enrollment');
  }
}

const asHuman = (identity: PublicIdentity) => ({ ...identity, kind: 'human' as const });

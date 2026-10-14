import {
  FolderKeyEnvelope,
  OwnerStatement,
  SealedMetadata,
  SealedMetadataV2,
  type SpaceId,
} from '@wikistow/contracts';
import type { ContactsChange, SpaceOwners } from './contacts.ts';
import { canonical } from './encoding.ts';
import { recordProtocol } from './envelope.ts';
import { CryptoError } from './errors.ts';
import { folderKeyEnvelopeBytes } from './folder-keys.ts';
import {
  keyHash,
  requireUsableKeys,
  sign,
  verifySignature,
  type PrivateIdentity,
  type PublicIdentity,
} from './identity.ts';
import { IdentityId, type InstallationId } from './ids.ts';
import { metadataRecordBytes, metadataRecordV2Bytes } from './metadata.ts';
import { opensFor, writesFor, type OpensOwner, type WritesOwner } from './owner-predicates.ts';
import type { DirectoryEntry, TrustStore } from './trust.ts';

export { OwnerStatement };

/** The bytes a signer signs for an owner statement. The server verifies them too. */
export const ownerStatementBytes = (s: Omit<OwnerStatement, 'signature'>) =>
  canonical('space-owner/v1', [
    s.installationId,
    s.spaceId,
    s.owner.id,
    s.owner.keyVersion,
    s.owner.keyHash,
    s.signerId,
    s.signerKeyVersion,
  ]);

/**
 * Sign a statement that `owner` owns the space, at their exact key (section
 * 6.5): the adder's app names a new co-owner, and the new owner's app names
 * the adder once its person confirms the co-owner dialog. Never at unlock.
 */
export function signOwnerStatement({
  signer,
  installationId,
  spaceId,
  owner,
}: {
  signer: PrivateIdentity;
  installationId: InstallationId;
  spaceId: SpaceId;
  owner: PublicIdentity;
}): OwnerStatement {
  if (owner.kind !== 'human') throw new CryptoError('malformed', 'Only people can own a space');
  const unsigned = {
    installationId,
    spaceId,
    owner: { id: owner.id, keyVersion: owner.keyVersion, keyHash: keyHash(owner) },
    signerId: signer.public.id,
    signerKeyVersion: signer.public.keyVersion,
  };
  return { ...unsigned, signature: sign(signer, ownerStatementBytes(unsigned)) };
}

// Only this module holds it, so only `acceptOwners` makes `AcceptedOwners`.
const minted = Symbol('AcceptedOwners');

type SealingOptions = { removing?: IdentityId; adding?: PublicIdentity };

/**
 * What a person's app has worked out about one space's owners (section 6.5).
 * Opaque: only `acceptOwners` makes one, so a caller can't pair real
 * predicates with sealing owners from somewhere else.
 */
export class AcceptedOwners {
  /**
   * Opening: any owner this app has ever accepted for the space, at the key
   * it accepted, whether or not the server still lists them or this person
   * removed them, so history stays readable.
   */
  readonly opens: OpensOwner;
  /**
   * Writing, rotating from, sealing to agents and the No going back mark:
   * accepted owners this person hasn't removed. A key version counts for
   * these only when its envelope was sealed by one of them.
   */
  readonly writes: WritesOwner;
  /**
   * The signer of the first statement naming this app's person, at their
   * current key, that the app accepts: the owner who added them, whom their
   * app names back in a statement of its own. `null` when there is none.
   */
  readonly adder: PublicIdentity | null;
  /**
   * When the server lists this app's person as an owner but the app has
   * accepted nobody, the adder the co-owner dialog asks the person to
   * confirm. Nobody is accepted until they do (pass it as `confirmedAdder`).
   */
  readonly adderToConfirm: PublicIdentity | null;
  /**
   * The owner this app accepted by first sight (step 2) this time, whom
   * Shared with me names as the person who shared (section 7.7). `null`
   * when step 2 accepted nobody now, as when the space's contacts entry
   * already accepts someone.
   */
  readonly firstSight: PublicIdentity | null;
  /** Owners newly accepted, for the next contacts write. */
  readonly changes: ContactsChange[];
  readonly #sealingOwners: (options: SealingOptions) => PublicIdentity[];

  constructor(
    token: typeof minted,
    fields: Pick<
      AcceptedOwners,
      'opens' | 'writes' | 'adder' | 'adderToConfirm' | 'firstSight' | 'changes'
    > & {
      sealingOwners: (options: SealingOptions) => PublicIdentity[];
    },
  ) {
    if (token !== minted) throw new CryptoError('malformed', 'Only acceptOwners makes owners');
    this.opens = fields.opens;
    this.writes = fields.writes;
    this.adder = fields.adder;
    this.adderToConfirm = fields.adderToConfirm;
    this.firstSight = fields.firstSight;
    this.changes = fields.changes;
    this.#sealingOwners = fields.sealingOwners;
  }

  /**
   * The owners to seal owner-region content and new key versions to: the
   * owners the server lists, each of whom must be accepted, not removed, and
   * listed at a key this app accepted for them. Otherwise `unaccepted-owner`,
   * naming them. `removing` is the owner this action removes, left out
   * without refusing; `adding` is the co-owner being added, at the key the
   * person chose.
   */
  sealingOwners(options: SealingOptions = {}): PublicIdentity[] {
    return this.#sealingOwners(options);
  }
}

const ownerKey = (owner: { id: string; keyHash: string }) => `${owner.id} ${owner.keyHash}`;

/**
 * The predicates of a space's contacts entry alone, with no first sight or
 * statements: what an agent uses, since it accepts owners only from its
 * person's contacts record (section 16), and the basis of `acceptOwners`.
 */
export const ownersFromContacts = (
  entry: SpaceOwners | undefined,
): Pick<AcceptedOwners, 'opens' | 'writes'> =>
  predicates(
    new Set((entry?.owners ?? []).map(ownerKey)),
    new Set<string>(entry?.removedOwners ?? []),
  );

/**
 * What an agent works with in a space (sections 6.4 and 9.3). Records open
 * from the owners its person's contacts entry accepts (`ownersFromContacts`),
 * and it writes, and marks No going back, only under key versions its own
 * person sealed to it: the person at the key it pinned at enrollment. It
 * never seals, so it has no sealing owners (`unaccepted-owner`).
 */
export function agentOwners({
  entry,
  person,
}: {
  entry: SpaceOwners | undefined;
  person: PublicIdentity;
}): AcceptedOwners {
  const sealedBy = keyHash(person);
  return new AcceptedOwners(minted, {
    opens: ownersFromContacts(entry).opens,
    writes: writesFor((sealer) => sealer.id === person.id && keyHash(sealer) === sealedBy),
    adder: null,
    adderToConfirm: null,
    firstSight: null,
    changes: [],
    sealingOwners() {
      throw new CryptoError('unaccepted-owner', 'Agents never seal to owners');
    },
  });
}

// `accepted` holds `ownerKey`s, `removed` IDs. Both are read when called, so
// the predicates see owners accepted after they were made.
function predicates(
  accepted: ReadonlySet<string>,
  removed: ReadonlySet<string>,
): Pick<AcceptedOwners, 'opens' | 'writes'> {
  const opens = opensFor((owner) =>
    accepted.has(ownerKey({ id: owner.id, keyHash: keyHash(owner) })),
  );
  return { opens, writes: writesFor((owner) => opens(owner) && !removed.has(owner.id)) };
}

/**
 * Work out the owners the app of `self` accepts for one space (section 6.5),
 * from what it recorded in its contacts entry and what the server serves:
 *
 * 1. itself, if it authored the space's first name record;
 * 2. otherwise, if it has accepted nobody yet, the signer of the first owner
 *    statement, then folder key envelope, that verifies and names it at its
 *    current key: trust on first sight. If the server lists `self` as an
 *    owner, only statements count, and only once the person confirms the
 *    co-owner dialog naming the signer (`confirmedAdder`);
 * 3. everyone a statement signed by an accepted owner names, repeatedly.
 *
 * Owners this person removed are never accepted, and their statements don't
 * count. The server's owner list never adds anyone. Keys come from
 * `directory` and must pass the trust store (section 8.4); a key seen for the
 * first time is pinned there.
 */
export function acceptOwners({
  installationId,
  spaceId,
  self,
  trust,
  entry,
  nameRecords,
  statements,
  envelopes,
  listedOwners,
  directory,
  confirmedAdder,
}: {
  installationId: InstallationId;
  spaceId: SpaceId;
  /** This app's identity, at its current key. */
  self: PublicIdentity;
  trust: TrustStore;
  /** The space's entry in the person's contacts record, if any. */
  entry: SpaceOwners | undefined;
  /** The space's own name records as served, signed, without payloads. */
  nameRecords: readonly unknown[];
  /** The space's owner statements, in the order the server serves them. */
  statements: readonly unknown[];
  /** Every folder key envelope addressed to `self` in the space. */
  envelopes: readonly unknown[];
  /** The owners the server lists, at the keys it lists them with. */
  listedOwners: readonly PublicIdentity[];
  /** The directory's keys for the signers and owners named above. */
  directory: readonly DirectoryEntry[];
  /** The adder the person confirmed in the co-owner dialog, by ID and key hash. */
  confirmedAdder?: { id: string; keyHash: string };
}): AcceptedOwners {
  const removed = new Set<string>(entry?.removedOwners ?? []);
  const accepted = new Set((entry?.owners ?? []).map(ownerKey));
  const changes: ContactsChange[] = [];
  // Whether `owner` is newly accepted. Callers never pass a removed owner.
  const accept = (owner: PublicIdentity): boolean => {
    const owned = { id: owner.id, keyHash: keyHash(owner) };
    if (accepted.has(ownerKey(owned))) return false;
    accepted.add(ownerKey(owned));
    changes.push({ kind: 'accept-owner', spaceId, owner: owned });
    return true;
  };
  const keys = new Keys(trust, directory);
  const selfHash = keyHash(self);
  const namesSelf = (owner: OwnerStatement['owner']) =>
    owner.id === self.id && owner.keyVersion === self.keyVersion && owner.keyHash === selfHash;

  const served = statements.flatMap((raw) => {
    const statement = OwnerStatement.safeParse(raw);
    return statement.success &&
      statement.data.installationId === installationId &&
      statement.data.spaceId === spaceId
      ? [statement.data]
      : [];
  });
  // A statement's signer, if the signature verifies under their key.
  const signerOf = (statement: OwnerStatement) => {
    const signer = keys.find(statement.signerId, statement.signerKeyVersion);
    return signer && verifySignature(signer, ownerStatementBytes(statement), statement.signature)
      ? signer
      : null;
  };

  // 1. Itself, as the author of the space's first name record.
  if (nameRecords.some((raw) => isOwnFirstName(raw, { installationId, spaceId, self }))) {
    accept(self);
  }

  // 2. First sight, decided once per space.
  let adderToConfirm: PublicIdentity | null = null;
  let firstSight: PublicIdentity | null = null;
  if (accepted.size === 0) {
    const listed = listedOwners.some((owner) => owner.id === self.id);
    const fromStatements = served.flatMap((statement) => {
      if (!namesSelf(statement.owner) || removed.has(statement.signerId)) return [];
      const signer = signerOf(statement);
      return signer ? [signer] : [];
    });
    const fromEnvelopes = listed
      ? []
      : envelopes
          .flatMap((raw) => {
            const envelope = FolderKeyEnvelope.safeParse(raw);
            return envelope.success ? [envelope.data] : [];
          })
          .filter(
            (envelope) =>
              envelope.spaceId === spaceId &&
              envelope.recipientId === self.id &&
              envelope.recipientKeyVersion === self.keyVersion &&
              !removed.has(envelope.sealerId),
          )
          .sort((a, b) => ascii(a.shareId, b.shareId) || a.keyVersion - b.keyVersion)
          .flatMap((envelope) => {
            const sealer = keys.find(envelope.sealerId, envelope.sealerKeyVersion);
            const bytes = folderKeyEnvelopeBytes(installationId, envelope);
            return sealer && verifySignature(sealer, bytes, envelope.signature) ? [sealer] : [];
          });
    const [first] = [...fromStatements, ...fromEnvelopes];
    if (first && !listed) {
      firstSight = keys.pin(first);
      accept(firstSight);
    } else if (first) {
      if (
        confirmedAdder &&
        ownerKey(confirmedAdder) === ownerKey({ id: first.id, keyHash: keyHash(first) })
      ) {
        firstSight = keys.pin(first);
        accept(firstSight);
      } else {
        adderToConfirm = first;
      }
    }
  }

  // 3. Statements signed by accepted owners, until nothing more is accepted.
  const counts = (signer: PublicIdentity) =>
    !removed.has(signer.id) && accepted.has(ownerKey({ id: signer.id, keyHash: keyHash(signer) }));
  for (let grew = true; grew;) {
    grew = false;
    for (const statement of served) {
      const named = statement.owner;
      if (removed.has(named.id) || accepted.has(ownerKey(named))) continue;
      const signer = signerOf(statement);
      if (!signer || !counts(signer)) continue;
      const owner = keys.find(named.id, named.keyVersion);
      if (!owner || owner.kind !== 'human' || keyHash(owner) !== named.keyHash) continue;
      grew = accept(keys.pin(owner)) || grew;
    }
  }

  const adder =
    served.flatMap((statement) => {
      if (!namesSelf(statement.owner)) return [];
      const signer = signerOf(statement);
      return signer && counts(signer) ? [signer] : [];
    })[0] ?? null;

  const { opens, writes } = predicates(accepted, removed);

  return new AcceptedOwners(minted, {
    opens,
    writes,
    sealingOwners({ removing, adding }) {
      const kept = listedOwners.filter((owner) => owner.id !== removing);
      const refused = kept.filter((owner) => !writes(owner));
      if (refused.length > 0) {
        throw new CryptoError(
          'unaccepted-owner',
          `The server lists owners this app doesn't accept: ${refused.map((o) => o.id).join(', ')}`,
        );
      }
      const owners = kept.map((owner) => keys.toSeal(owner));
      return adding ? [...owners, adding] : owners;
    },
    adder,
    adderToConfirm,
    firstSight,
    changes,
  });
}

const ascii = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Whether `raw` is the space's first name record, written by `self` at its
// current key and signed by it.
function isOwnFirstName(
  raw: unknown,
  {
    installationId,
    spaceId,
    self,
  }: { installationId: InstallationId; spaceId: SpaceId; self: PublicIdentity },
): boolean {
  let protocol: 1 | 2;
  try {
    protocol = recordProtocol(raw, 'Name record');
  } catch {
    return false;
  }
  const parsed =
    protocol === 1
      ? SealedMetadata.pick({ record: true, signature: true }).safeParse(raw)
      : SealedMetadataV2.pick({ record: true, signature: true }).safeParse(raw);
  if (!parsed.success) return false;
  const { record, signature } = parsed.data;
  return (
    record.installationId === installationId &&
    record.spaceId === spaceId &&
    record.subjectKind === 'space' &&
    record.subjectId === spaceId &&
    record.basedOn === null &&
    record.authorId === self.id &&
    record.authorKeyVersion === self.keyVersion &&
    verifySignature(
      self,
      record.protocol === 1 ? metadataRecordBytes(record) : metadataRecordV2Bytes(record),
      signature,
    )
  );
}

// Keys from the directory, as the trust store allows them: a pinned key, or
// one seen for the first time, which is pinned only once it is used to
// accept someone. A key change or a removed key is never found. Every key is
// looked up by the identity a record names, never by email, so the
// directory's email labels a first-seen key.
class Keys {
  readonly #trust: TrustStore;
  readonly #directory: readonly DirectoryEntry[];

  constructor(trust: TrustStore, directory: readonly DirectoryEntry[]) {
    this.#trust = trust;
    this.#directory = directory;
  }

  find(id: string, keyVersion: number): PublicIdentity | null {
    const entry = this.#entry(id, keyVersion);
    if (!entry) return this.#pinned(id, keyVersion);
    try {
      requireUsableKeys(entry.identity);
    } catch {
      return null;
    }
    const result = this.#trust.check(entry.identity, entry.email);
    if (result.kind === 'pinned') return result.identity;
    return result.kind === 'unknown' && entry.identity.kind === 'human' ? entry.identity : null;
  }

  // An owner's key to seal to, which must pass the pins (section 8.4): pinned
  // now if seen for the first time, and refused if it changed.
  toSeal(owner: PublicIdentity): PublicIdentity {
    const entry = this.#entry(owner.id, owner.keyVersion);
    if (entry && keyHash(entry.identity) === keyHash(owner)) {
      return this.#trust.use({ ...entry, foundBy: null });
    }
    const result = this.#trust.check(owner);
    if (result.kind === 'pinned') return result.identity;
    throw new CryptoError(
      result.kind === 'unknown' ? 'unknown-identity' : 'identity-key-changed',
      `No usable key for the owner ${owner.id}`,
    );
  }

  pin(identity: PublicIdentity): PublicIdentity {
    const entry = this.#entry(identity.id, identity.keyVersion);
    return entry ? this.#trust.use({ ...entry, foundBy: null }) : identity;
  }

  #pinned(id: string, keyVersion: number): PublicIdentity | null {
    try {
      return this.#trust.require(IdentityId.parse(id), keyVersion);
    } catch {
      return null;
    }
  }

  #entry(id: string, keyVersion: number): DirectoryEntry | undefined {
    return this.#directory.find(
      ({ identity }) => identity.id === id && identity.keyVersion === keyVersion,
    );
  }
}

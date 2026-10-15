import {
  AgentEnrollment,
  AgentId,
  ContactsRecord,
  Hash32,
  HumanId,
  IdentityId,
  PlainName,
  PublicIdentity,
  SealedContacts,
  ShareId,
  SignedContactsRecord,
  SpaceId,
  Timestamp,
} from '@wikistow/contracts';
import { z } from 'zod';
import { withAppAgentSecret, type AppAgentSecret } from './app-agents.ts';
import {
  aeadDecrypt,
  aeadEncrypt,
  canonical,
  FORMAT_INTEGERS,
  hash,
  keepParsed,
  parseJson,
  parseWith,
  sealedBytes,
  utf8,
} from './encoding.ts';
import { keyCommitment, openSealedKey, requireCommittedKey, sealKeyTo } from './envelope.ts';
import { CryptoError } from './errors.ts';
import { keyHash, sameKeys, sign, verifySignature, type PrivateIdentity } from './identity.ts';
import type { InstallationId } from './ids.ts';
import type { JsonPathPattern } from './json.ts';
import { Format } from './payload.ts';
import { withPluginApproval, type PluginApproval } from './plugin-approvals.ts';
import { sodium } from './sodium.ts';
import { verifyEnrollment } from './trust.ts';

export { ContactsRecord, SealedContacts, SignedContactsRecord };

export const CONTACTS_FORMAT = { major: 1, minor: 0 } as const;

const ContactsFormat = Format.extend({ major: z.literal(CONTACTS_FORMAT.major) });
const Extensions = z.record(z.string(), z.json());

// Payloads are loose, so fields from a newer minor version survive a save.
// Rules that break the whole payload (shapes, timestamps, hashes, and two
// items under one key, section 8.2) are here; label rules only degrade their
// own entry, so they are checked where labels are read (`pinLabel`,
// `agentLabelName`).

// IDs never hold a space, so joining two with one is unambiguous.
const shareKey = (share: Pick<AgentShare, 'spaceId' | 'shareId'>) =>
  `${share.spaceId} ${share.shareId}`;
const ownerKey = (owner: AcceptedOwner) => `${owner.id} ${owner.keyHash}`;

const ascii = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Sorted by key in ASCII order, keeping the first item for each key.
const sortedSet = <T>(items: readonly T[], key: (item: T) => string): T[] =>
  [...new Map(items.toReversed().map((item) => [key(item), item])).values()].sort((a, b) =>
    ascii(key(a), key(b)),
  );

const Pin = z.looseObject({
  identity: PublicIdentity.extend({ id: HumanId, kind: z.literal('human') }),
  verifiedAt: Timestamp,
  /** Pinned when first seen (section 8.3), or accepted after a key-change warning (8.4). */
  method: z.enum(['first-seen', 'confirmed']),
});
export type Pin = z.infer<typeof Pin>;

const Removed = z.looseObject({ id: IdentityId, keyHash: Hash32, removedAt: Timestamp });

/** A share the person granted their agent, and whether its draft keys go to the agent. */
const AgentShare = z.looseObject({ spaceId: SpaceId, shareId: ShareId, drafts: z.boolean() });
export type AgentShare = z.infer<typeof AgentShare>;

const OwnAgent = z
  .looseObject({
    enrollment: AgentEnrollment,
    label: z.looseObject({ name: z.string(), enrolledAt: Timestamp }),
    shares: z.array(AgentShare),
  })
  .superRefine((agent, ctx) => {
    // A set: the same share twice is fine, but not with two answers about drafts.
    const drafts = new Map<string, boolean>();
    for (const share of agent.shares) {
      const key = shareKey(share);
      if (drafts.get(key) === !share.drafts) {
        ctx.addIssue({ code: 'custom', message: 'A share is listed with two drafts values' });
      }
      drafts.set(key, share.drafts);
    }
  });
export type OwnAgent = z.infer<typeof OwnAgent>;
const RevokedAgent = z.looseObject({ agentId: AgentId, revokedAt: Timestamp });

/** An owner this person's app accepted for a space, at one exact key (section 6.5). */
const AcceptedOwner = z.looseObject({ id: HumanId, keyHash: Hash32 });
export type AcceptedOwner = z.infer<typeof AcceptedOwner>;

/**
 * One space's accepted owners, and the owners this person removed from it,
 * whom their apps don't accept again unless this person adds them back.
 */
const SpaceOwners = z.looseObject({
  spaceId: SpaceId,
  owners: z.array(AcceptedOwner),
  removedOwners: z.array(HumanId),
});
export type SpaceOwners = z.infer<typeof SpaceOwners>;

/** The shared payload: readable by the owner and the agents they enrolled. */
export const SharedContacts = z
  .looseObject({
    format: ContactsFormat,
    contacts: z.array(Pin),
    removed: z.array(Removed),
    agents: z.array(OwnAgent),
    revokedAgents: z.array(RevokedAgent),
    spaceOwners: z.array(SpaceOwners),
    extensions: Extensions,
  })
  .superRefine((payload, ctx) => {
    requireUnique(ctx, payload.contacts, (pin) => pin.identity.id, 'contact');
    requireUnique(ctx, payload.agents, (agent) => agent.enrollment.agent.id, 'agent');
    requireUnique(ctx, payload.agents, (agent) => agent.label.name, 'agent name');
    requireUnique(ctx, payload.spaceOwners, (entry) => entry.spaceId, 'space owners entry');
  });
export type SharedContacts = z.infer<typeof SharedContacts>;

const Label = z.looseObject({
  id: IdentityId,
  keyHash: Hash32,
  name: z.string(),
  email: z.string(),
});
export type Label = z.infer<typeof Label>;

/** The private payload: the owner's alone. */
export const PrivateContacts = z
  .looseObject({
    format: ContactsFormat,
    labels: z.array(Label),
    extensions: Extensions,
  })
  .superRefine((payload, ctx) => {
    requireUnique(ctx, payload.labels, (label) => label.id, 'label');
    requireUnique(ctx, payload.labels, (label) => label.email, 'label email');
  });
export type PrivateContacts = z.infer<typeof PrivateContacts>;

function requireUnique<T>(
  ctx: z.RefinementCtx,
  items: readonly T[],
  identity: (item: T) => string,
  what: string,
): void {
  const ids = items.map(identity);
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({ code: 'custom', message: `Two ${what}s share one key` });
}

/**
 * The shared payload as writers store it (section 8.2): `removed`,
 * `revokedAgents`, each agent's `shares`, and each space's `owners` and
 * `removedOwners` are sets, sorted by their keys without duplicates.
 */
export function normalizeSharedContacts(shared: SharedContacts): SharedContacts {
  return {
    ...shared,
    removed: sortedSet(shared.removed, (entry) => entry.keyHash),
    revokedAgents: sortedSet(shared.revokedAgents, (entry) => entry.agentId),
    agents: shared.agents.map((agent) => ({ ...agent, shares: sortedSet(agent.shares, shareKey) })),
    spaceOwners: shared.spaceOwners.map((entry) => ({
      ...entry,
      owners: sortedSet(entry.owners, ownerKey),
      removedOwners: sortedSet(entry.removedOwners, (id) => id),
    })),
  };
}

/** Shared payload fields typed as integers. */
const SHARED_INTEGERS: readonly JsonPathPattern[] = [
  ...FORMAT_INTEGERS,
  ['contacts', '*', 'identity', 'keyVersion'],
  ['agents', '*', 'enrollment', 'ownerKeyVersion'],
  ['agents', '*', 'enrollment', 'agent', 'keyVersion'],
];

// Both keep the parsed object rather than Zod's copy (`keepParsed`), so
// unknown members, `__proto__` included, survive into the next version.

/** Decode and parse decrypted shared contacts. */
export const parseSharedContacts = (bytes: Uint8Array): SharedContacts => {
  const json = parseJson(z.unknown(), bytes, 'Shared contacts', { integers: SHARED_INTEGERS });
  return keepParsed(SharedContacts, json, 'Shared contacts');
};

/** Decode and parse decrypted private contacts. */
export const parsePrivateContacts = (bytes: Uint8Array): PrivateContacts => {
  const json = parseJson(z.unknown(), bytes, 'Private contacts');
  return keepParsed(PrivateContacts, json, 'Private contacts');
};

/** The bytes the owner signs. `contactsHash` is their hash, chaining versions. */
export const contactsBytes = (r: ContactsRecord) =>
  canonical('contacts/v1', [
    r.protocol,
    r.installationId,
    r.ownerId,
    r.ownerKeyVersion,
    r.version,
    r.prevHash,
    r.payloadHash,
    r.keyCommitment,
    r.privatePayloadHash,
    r.privateKeyCommitment,
  ]);

export const contactsHash = (record: ContactsRecord): string => hash(contactsBytes(record));

type AdFields = Pick<ContactsRecord, 'installationId' | 'ownerId' | 'ownerKeyVersion' | 'version'>;
const sharedAd = (r: AdFields) =>
  canonical('contacts-payload/v1', [r.installationId, r.ownerId, r.ownerKeyVersion, r.version]);
const privateAd = (r: AdFields) =>
  canonical('contacts-private-payload/v1', [
    r.installationId,
    r.ownerId,
    r.ownerKeyVersion,
    r.version,
  ]);

/**
 * The agents whose enrollment verifies under the owner's key and who aren't
 * revoked: the readers of the shared payload besides the owner.
 */
export function contactsReaders(
  owner: PublicIdentity,
  installationId: InstallationId,
  shared: SharedContacts,
): PublicIdentity[] {
  const revoked = new Set(shared.revokedAgents.map((entry) => entry.agentId));
  return shared.agents.flatMap(({ enrollment }) => {
    if (revoked.has(enrollment.agent.id)) return [];
    try {
      verifyEnrollment({ installationId, owner, enrollment });
      return [enrollment.agent];
    } catch {
      return [];
    }
  });
}

/**
 * Seal a version of the owner's contacts record. The shared key goes to the
 * owner and to each verified, unrevoked agent in the shared payload itself,
 * never to a list the server gave; the private key goes to the owner alone.
 * The shared payload's sets are stored sorted (`normalizeSharedContacts`).
 * Refuses a payload its own readers would read as malformed.
 */
export function sealContacts({
  owner,
  installationId,
  previous,
  shared: sharedPayload,
  private: privatePayload,
}: {
  owner: PrivateIdentity;
  installationId: InstallationId;
  /** The version this one replaces, or `null` for version 1. */
  previous: ContactsRecord | null;
  shared: SharedContacts;
  private: PrivateContacts;
}): SealedContacts {
  const ownerId = HumanId.parse(owner.public.id);
  const shared = normalizeSharedContacts(sharedPayload);
  // Round-trip through JSON text, so the writer checks exactly what readers will parse.
  parseSharedContacts(utf8(JSON.stringify(shared)));
  parsePrivateContacts(utf8(JSON.stringify(privatePayload)));
  const binding = {
    installationId,
    ownerId,
    ownerKeyVersion: owner.public.keyVersion,
    version: previous === null ? 1 : previous.version + 1,
  };
  const contentKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const privateKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  try {
    const payload = aeadEncrypt({
      key: contentKey,
      plaintext: utf8(JSON.stringify(shared)),
      ad: sharedAd(binding),
    });
    const sealedPrivate = aeadEncrypt({
      key: privateKey,
      plaintext: utf8(JSON.stringify(privatePayload)),
      ad: privateAd(binding),
    });
    const record: ContactsRecord = {
      protocol: 1,
      ...binding,
      prevHash: previous === null ? null : contactsHash(previous),
      payloadHash: hash(sealedBytes(payload)),
      keyCommitment: keyCommitment(contentKey),
      privatePayloadHash: hash(sealedBytes(sealedPrivate)),
      privateKeyCommitment: keyCommitment(privateKey),
    };
    const readers = [owner.public, ...contactsReaders(owner.public, installationId, shared)];
    return {
      record,
      signature: sign(owner, contactsBytes(record)),
      payload,
      keys: readers.map((reader) => ({
        recipientId: reader.id,
        recipientKeyVersion: reader.keyVersion,
        sealedKey: sealKeyTo(contentKey, reader),
      })),
      private: sealedPrivate,
      privateKey: sealKeyTo(privateKey, owner.public),
    };
  } finally {
    sodium.memzero(contentKey);
    sodium.memzero(privateKey);
  }
}

export type OpenedContacts = {
  record: ContactsRecord;
  shared: SharedContacts;
  /** `null` for an agent, which never sees the private payload. */
  private: PrivateContacts | null;
};

/**
 * Open a contacts record as its owner or one of the owner's agents. Checks the
 * owner's signature, the payload hashes, and each key against its signed
 * commitment before decrypting. `owner` is the vault identity for a human, or
 * the human pinned at enrollment for an agent. The caller checks the result
 * against its contacts mark (`compareContactsMark`).
 */
export function openContacts({
  reader,
  owner,
  installationId,
  sealed: raw,
}: {
  reader: PrivateIdentity;
  owner: PublicIdentity;
  installationId: InstallationId;
  sealed: unknown;
}): OpenedContacts {
  const sealed = parseWith(SealedContacts, raw, 'Contacts');
  const { record } = sealed;
  checkContactsRecord({ owner, installationId, record, signature: sealed.signature });
  if (hash(sealedBytes(sealed.payload)) !== record.payloadHash) {
    throw new CryptoError('hash-mismatch', 'Shared contacts do not match their signed hash');
  }
  const shared = openSharedPayload(reader, sealed);
  if (reader.public.id !== owner.id) return { record, shared, private: null };

  if (hash(sealedBytes(sealed.private)) !== record.privatePayloadHash) {
    throw new CryptoError('hash-mismatch', 'Private contacts do not match their signed hash');
  }
  const privatePayload = decryptWith(
    openSealedKey(reader, sealed.privateKey),
    record.privateKeyCommitment,
    (key) =>
      parsePrivateContacts(aeadDecrypt({ key, sealed: sealed.private, ad: privateAd(record) })),
  );
  return { record, shared, private: privatePayload };
}

// The keys aren't signed, so the server can add entries for this reader. It
// can't stop the true one opening, so every matching entry is tried in turn.
// Only the true key meets the record's commitment, so once one does, what it
// opens to is final; if none does, the last failure is reported.
function openSharedPayload(reader: PrivateIdentity, sealed: SealedContacts): SharedContacts {
  const { record } = sealed;
  const mine = sealed.keys.filter(
    (key) =>
      key.recipientId === reader.public.id && key.recipientKeyVersion === reader.public.keyVersion,
  );
  let failure: unknown = new CryptoError('wrong-recipient', 'No contacts key for this reader');
  for (const { sealedKey } of mine) {
    let key: Uint8Array;
    try {
      key = requireCommittedKey(openSealedKey(reader, sealedKey), record.keyCommitment);
    } catch (error) {
      failure = error;
      continue;
    }
    return decryptWith(key, record.keyCommitment, (opened) =>
      parseSharedContacts(
        aeadDecrypt({ key: opened, sealed: sealed.payload, ad: sharedAd(record) }),
      ),
    );
  }
  throw failure;
}

function decryptWith<T>(key: Uint8Array, commitment: string, open: (key: Uint8Array) => T): T {
  requireCommittedKey(key, commitment);
  try {
    return open(key);
  } finally {
    sodium.memzero(key);
  }
}

/** Check a record's self-signature by its owner, for this installation. Throws a `CryptoError`. */
export function verifyContactsRecord({
  owner,
  installationId,
  signed: raw,
}: {
  owner: PublicIdentity;
  installationId: InstallationId;
  signed: unknown;
}): ContactsRecord {
  const { record, signature } = parseWith(SignedContactsRecord, raw, 'Contacts record');
  checkContactsRecord({ owner, installationId, record, signature });
  return record;
}

function checkContactsRecord({
  owner,
  installationId,
  record,
  signature,
}: {
  owner: PublicIdentity;
  installationId: InstallationId;
  record: ContactsRecord;
  signature: string;
}): void {
  if (
    record.installationId !== installationId ||
    record.ownerId !== owner.id ||
    record.ownerKeyVersion !== owner.keyVersion
  ) {
    throw new CryptoError(
      'binding-mismatch',
      'Contacts record is for another owner or installation',
    );
  }
  if ((record.prevHash === null) !== (record.version === 1)) {
    throw new CryptoError('malformed', 'Only version 1 has no previous version');
  }
  if (!verifySignature(owner, contactsBytes(record), signature)) {
    throw new CryptoError('bad-signature', 'Contacts record is not signed by its owner');
  }
}

/** The newest version a client has accepted of its own (or its human's) record. */
export type ContactsMark = { version: number; contactsHash: string };

/**
 * Compare a served, verified record with the client's mark. A lower version
 * is `contacts-rollback`, the same version with another hash `contacts-fork`.
 * A higher one must be chained to the mark with `requireContactsChain`.
 */
export function compareContactsMark(mark: ContactsMark, record: ContactsRecord): 'same' | 'newer' {
  if (record.version < mark.version) {
    throw new CryptoError('contacts-rollback', 'The server served an older contacts record');
  }
  if (record.version > mark.version) return 'newer';
  if (contactsHash(record) !== mark.contactsHash) {
    throw new CryptoError('contacts-fork', 'The server served another record at the same version');
  }
  return 'same';
}

/**
 * Check that `chain`, every version after the mark up to the served one,
 * links back to the mark: each signed by the owner and naming the previous
 * version's hash. A gap or a mismatch is `contacts-fork`.
 */
export function requireContactsChain({
  owner,
  installationId,
  mark,
  chain,
}: {
  owner: PublicIdentity;
  installationId: InstallationId;
  mark: ContactsMark;
  chain: readonly unknown[];
}): ContactsRecord {
  let previous = mark;
  let last: ContactsRecord | undefined;
  for (const signed of chain) {
    const record = verifyContactsRecord({ owner, installationId, signed });
    if (record.version !== previous.version + 1 || record.prevHash !== previous.contactsHash) {
      throw new CryptoError('contacts-fork', 'The contacts chain does not link to the mark');
    }
    previous = { version: record.version, contactsHash: contactsHash(record) };
    last = record;
  }
  if (!last) throw new CryptoError('contacts-fork', 'No versions after the mark');
  return last;
}

/**
 * A label email in its stored form: surrounding spaces, tabs and line breaks
 * removed, and A-Z lowercased. Nothing else changes, so a U+FEFF or a
 * non-breaking space stays and makes the email mismatch.
 */
export const normalizeEmail = (email: string): string =>
  email.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '').replace(/[A-Z]/g, (letter) => letter.toLowerCase());

const EMAIL =
  // oxlint-disable-next-line no-useless-escape -- the pattern of section 3.2, verbatim
  /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;

// 1 to 100 code points, with no control or bidi characters (section 3.3, rule 5).
const LabelName = PlainName(100);
const isUsableName = (name: string) => LabelName.safeParse(name).success;

/** Whether a label is fit to name a pin: a plain name, and an email stored normalized. */
export const isUsableLabel = ({ name, email }: Pick<Label, 'name' | 'email'>): boolean =>
  isUsableName(name) && email === normalizeEmail(email) && email.length <= 254 && EMAIL.test(email);

/**
 * The label that names a pin, or `null` when it must be shown by its
 * fingerprint only: no label for its key, or a label that breaks the rules
 * (section 8.2). A parsed payload never holds two labels for one ID.
 */
export function pinLabel(pin: Pin, labels: readonly Label[]): Label | null {
  const pinHash = keyHash(pin.identity);
  const matching = labels.filter(
    (label) => label.id === pin.identity.id && label.keyHash === pinHash,
  );
  const [only] = matching;
  return matching.length === 1 && only && isUsableLabel(only) ? only : null;
}

/**
 * The name of one of the owner's agents, or `null` when the interface must
 * show it by ID and ask for a rename: a broken name. A parsed payload never
 * holds two entries for one agent, or two agents with one name.
 */
export function agentLabelName(agentId: string, agents: readonly OwnAgent[]): string | null {
  const entries = agents.filter((agent) => agent.enrollment.agent.id === agentId);
  const [only] = entries;
  if (entries.length !== 1 || !only || !isUsableName(only.label.name)) return null;
  const sharing = agents.filter((agent) => agent.label.name === only.label.name);
  return sharing.length === 1 ? only.label.name : null;
}

/** A change one device made, re-applied on top of a newer record after a lost race (section 8.6). */
export type ContactsChange =
  | { kind: 'pin'; pin: Pin; label: Pick<Label, 'name' | 'email'> }
  /** A changed key the person confirmed: `pin` replaces the pin whose key hash is `replaced`. */
  | { kind: 'confirm-key'; pin: Pin; replaced: string }
  /** A changed key the person declined: it goes into `removed`, and the pin stays. */
  | { kind: 'decline-key'; id: string; keyHash: string; removedAt: string }
  | {
      kind: 'relabel';
      id: string;
      keyHash: string;
      label: Pick<Label, 'name' | 'email'>;
      replaced: Pick<Label, 'name' | 'email'>;
    }
  | { kind: 'unpin'; id: string; keyHash: string; removedAt: string }
  | { kind: 'enroll'; agent: OwnAgent }
  | { kind: 'rename-agent'; agentId: string; name: string; replaced: string }
  | { kind: 'revoke-agent'; agentId: string; revokedAt: string }
  /** An agent this person's app runs: its secrets, in the private payload (`APP_AGENTS_NAMESPACE`). */
  | { kind: 'app-agent'; secret: AppAgentSecret }
  /** Shares added to an agent, or whose `drafts` changed, and shares taken away. */
  | {
      kind: 'agent-shares';
      agentId: string;
      set: readonly AgentShare[];
      unset: readonly Pick<AgentShare, 'spaceId' | 'shareId'>[];
    }
  | { kind: 'accept-owner'; spaceId: SpaceId; owner: AcceptedOwner }
  | { kind: 'remove-owner'; spaceId: SpaceId; ownerId: string }
  | { kind: 'add-co-owner'; spaceId: SpaceId; owner: AcceptedOwner }
  /**
   * Library plugins (`PLUGINS_NAMESPACE`), merged per plugin, the last write
   * standing: an approval sets the whole entry; a change sets its fields if
   * the entry is still there, so a plugin removed on another device stays
   * removed; a removal drops it.
   */
  | { kind: 'plugin-approve'; approval: PluginApproval }
  | {
      kind: 'plugin-change';
      pluginId: string;
      set: Partial<Omit<PluginApproval, 'id'>>;
    }
  | { kind: 'plugin-remove'; pluginId: string };

export type ContactsPayloads = { shared: SharedContacts; private: PrivateContacts };

const conflict = (message: string) => new CryptoError('contacts-conflict', message);
const sameLabel = (a: Pick<Label, 'name' | 'email'>, b: Pick<Label, 'name' | 'email'>) =>
  a.name === b.name && a.email === b.email;

/**
 * Re-apply one pending change on top of a newer record's payloads. Never
 * overwrites what the newer record holds: where the two disagree in a way the
 * person must decide, it throws `contacts-conflict`.
 */
export function applyContactsChange(
  base: ContactsPayloads,
  change: ContactsChange,
): ContactsPayloads {
  const { shared, private: own } = base;
  switch (change.kind) {
    case 'pin': {
      const { identity } = change.pin;
      const pinHash = keyHash(identity);
      const existing = shared.contacts.find((pin) => pin.identity.id === identity.id);
      if (existing) {
        if (sameKeys(existing.identity, identity)) return base;
        throw conflict(`${identity.id} is pinned to other keys`);
      }
      if (own.labels.some((label) => label.email === change.label.email)) {
        throw conflict('Another contact has this email');
      }
      return {
        shared: {
          ...shared,
          contacts: [...shared.contacts, change.pin],
          removed: shared.removed.filter((entry) => entry.keyHash !== pinHash),
        },
        private: {
          ...own,
          labels: [...own.labels, { id: identity.id, keyHash: pinHash, ...change.label }],
        },
      };
    }
    case 'confirm-key': {
      const { identity } = change.pin;
      const pinHash = keyHash(identity);
      const index = shared.contacts.findIndex((pin) => pin.identity.id === identity.id);
      const current = shared.contacts[index];
      const removed = shared.removed.filter((entry) => entry.keyHash !== pinHash);
      // Already pinned, as when another device confirmed it first. A decline
      // re-applied over that can leave the key in `removed` too, which the
      // confirmation takes out.
      if (current && keyHash(current.identity) === pinHash) {
        if (removed.length === shared.removed.length) return base;
        return { shared: { ...shared, removed }, private: own };
      }
      if (!current || keyHash(current.identity) !== change.replaced) {
        throw conflict(`${identity.id} holds a key this device didn't confirm over`);
      }
      return {
        shared: {
          ...shared,
          contacts: shared.contacts.with(index, change.pin),
          removed,
        },
        private: {
          ...own,
          labels: own.labels.map((label) =>
            label.id === identity.id && label.keyHash === change.replaced
              ? { ...label, keyHash: pinHash }
              : label,
          ),
        },
      };
    }
    case 'decline-key': {
      if (shared.removed.some((entry) => entry.keyHash === change.keyHash)) return base;
      const entry = {
        id: IdentityId.parse(change.id),
        keyHash: change.keyHash,
        removedAt: change.removedAt,
      };
      return { shared: { ...shared, removed: [...shared.removed, entry] }, private: own };
    }
    case 'relabel': {
      const index = own.labels.findIndex((l) => l.id === change.id && l.keyHash === change.keyHash);
      const current = own.labels[index];
      if (!current || !sameLabel(current, change.replaced)) {
        throw conflict('This contact was relabelled or removed on another device');
      }
      const others = own.labels.filter((_, i) => i !== index);
      if (others.some((label) => label.email === change.label.email)) {
        throw conflict('Another contact has this email');
      }
      return {
        shared,
        private: { ...own, labels: own.labels.with(index, { ...current, ...change.label }) },
      };
    }
    case 'unpin': {
      const matches = (entry: { id: string; keyHash: string }) =>
        entry.id === change.id && entry.keyHash === change.keyHash;
      return {
        shared: {
          ...shared,
          contacts: shared.contacts.filter(
            (pin) => !(pin.identity.id === change.id && keyHash(pin.identity) === change.keyHash),
          ),
          removed: shared.removed.some(matches)
            ? shared.removed
            : [
                ...shared.removed,
                {
                  id: IdentityId.parse(change.id),
                  keyHash: change.keyHash,
                  removedAt: change.removedAt,
                },
              ],
        },
        private: { ...own, labels: own.labels.filter((label) => !matches(label)) },
      };
    }
    case 'enroll': {
      const agentId = change.agent.enrollment.agent.id;
      if (shared.agents.some((agent) => agent.enrollment.agent.id === agentId)) return base;
      if (shared.agents.some((agent) => agent.label.name === change.agent.label.name)) {
        throw conflict('Another agent has this name; rename this one');
      }
      return { shared: { ...shared, agents: [...shared.agents, change.agent] }, private: own };
    }
    case 'rename-agent': {
      const index = shared.agents.findIndex(
        (agent) => agent.enrollment.agent.id === change.agentId,
      );
      const current = shared.agents[index];
      if (!current) throw conflict('This agent is not in the newer record');
      if (current.label.name === change.name) return base;
      if (current.label.name !== change.replaced)
        throw conflict('This agent was renamed on another device');
      if (shared.agents.some((agent) => agent.label.name === change.name)) {
        throw conflict('Another agent has this name');
      }
      const renamed = { ...current, label: { ...current.label, name: change.name } };
      return { shared: { ...shared, agents: shared.agents.with(index, renamed) }, private: own };
    }
    case 'revoke-agent': {
      if (shared.revokedAgents.some((entry) => entry.agentId === change.agentId)) return base;
      const entry = { agentId: AgentId.parse(change.agentId), revokedAt: change.revokedAt };
      return {
        shared: { ...shared, revokedAgents: [...shared.revokedAgents, entry] },
        private: own,
      };
    }
    case 'app-agent':
      return { shared, private: withAppAgentSecret(own, change.secret) };
    case 'agent-shares': {
      const index = shared.agents.findIndex(
        (agent) => agent.enrollment.agent.id === change.agentId,
      );
      const current = shared.agents[index];
      if (!current) throw conflict('This agent is not in the newer record');
      // Only the items this device changed; the rest of the list is the newer record's.
      const touched = new Set([...change.set, ...change.unset].map(shareKey));
      const shares = [
        ...current.shares.filter((share) => !touched.has(shareKey(share))),
        ...change.set,
      ];
      return {
        shared: { ...shared, agents: shared.agents.with(index, { ...current, shares }) },
        private: own,
      };
    }
    // Each owner change returns the entry itself when it changes nothing, so
    // writing one again is a no-op (section 7.6).
    case 'accept-owner':
      return withSpaceOwners(base, change.spaceId, (entry) =>
        entry.removedOwners.includes(HumanId.parse(change.owner.id)) ||
        hasOwner(entry, change.owner)
          ? entry
          : { ...entry, owners: [...entry.owners, change.owner] },
      );
    case 'remove-owner': {
      const ownerId = HumanId.parse(change.ownerId);
      return withSpaceOwners(base, change.spaceId, (entry) =>
        entry.removedOwners.includes(ownerId)
          ? entry
          : { ...entry, removedOwners: [...entry.removedOwners, ownerId] },
      );
    }
    case 'add-co-owner':
      return withSpaceOwners(base, change.spaceId, (entry) => {
        const owned = hasOwner(entry, change.owner);
        if (owned && !entry.removedOwners.includes(change.owner.id)) return entry;
        return {
          ...entry,
          owners: owned ? entry.owners : [...entry.owners, change.owner],
          removedOwners: entry.removedOwners.filter((id) => id !== change.owner.id),
        };
      });
    case 'plugin-approve':
      return withPlugin(base, change.approval.id, () => change.approval);
    case 'plugin-change':
      return withPlugin(base, change.pluginId, (current) =>
        current ? { ...current, ...change.set } : null,
      );
    case 'plugin-remove':
      return withPlugin(base, change.pluginId, () => null);
    default: {
      const _exhaustive: never = change;
      return _exhaustive;
    }
  }
}

const hasOwner = (entry: SpaceOwners, owner: { id: string; keyHash: string }) =>
  entry.owners.some((held) => held.id === owner.id && held.keyHash === owner.keyHash);

// One space's owners entry, changed by `update`, adding the entry if the
// space has none yet. Its lists are sets, sorted when written.
function withSpaceOwners(
  base: ContactsPayloads,
  spaceId: SpaceId,
  update: (entry: SpaceOwners) => SpaceOwners,
): ContactsPayloads {
  const { spaceOwners } = base.shared;
  const index = spaceOwners.findIndex((entry) => entry.spaceId === spaceId);
  const current = spaceOwners[index] ?? { spaceId, owners: [], removedOwners: [] };
  const updated = update(current);
  if (updated === current) return base;
  return {
    shared: {
      ...base.shared,
      spaceOwners: index === -1 ? [...spaceOwners, updated] : spaceOwners.with(index, updated),
    },
    private: base.private,
  };
}

// One library plugin's approval, changed by `update`; the same payloads when it changes nothing.
function withPlugin(
  base: ContactsPayloads,
  pluginId: string,
  update: (current: PluginApproval | null) => PluginApproval | null,
): ContactsPayloads {
  const own = withPluginApproval(base.private, pluginId, update);
  return own === base.private ? base : { shared: base.shared, private: own };
}

/** An empty first version's payloads. */
export const newContactsPayloads = (): ContactsPayloads => ({
  shared: {
    format: { ...CONTACTS_FORMAT },
    contacts: [],
    removed: [],
    agents: [],
    revokedAgents: [],
    spaceOwners: [],
    extensions: {},
  },
  private: {
    format: { ...CONTACTS_FORMAT },
    labels: [],
    extensions: {},
  },
});

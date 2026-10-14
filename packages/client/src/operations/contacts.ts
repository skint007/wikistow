// The person's contacts record on the server (protocol section 8): read and
// checked once per session, and written by compare-and-swap, re-applying
// this device's changes on top of anything newer, never overwriting it.
import { contactsRoutes, type ContactsRecord, type InstallationId } from '@wikistow/contracts';
import { ApiError, type ApiClient } from '../api/client.ts';
import {
  applyContactsChange,
  compareContactsMark,
  contactsHash,
  newContactsPayloads,
  openContacts,
  requireContactsChain,
  sealContacts,
  type ContactsChange,
  type ContactsMark,
  type ContactsPayloads,
} from '../contacts.ts';
import { CryptoError } from '../errors.ts';
import type { PrivateIdentity, PublicIdentity } from '../identity.ts';

/**
 * The newest contacts record this session has accepted, and its payloads.
 * `mark` is the session's contacts mark: the browser keeps it in memory
 * only, so it catches a rollback within one session (section 8.5, Q2).
 */
export type ContactsBook = {
  record: ContactsRecord | null;
  payloads: ContactsPayloads;
  mark: ContactsMark | null;
};

type Owner = { api: ApiClient; installationId: InstallationId; identity: PrivateIdentity };

/**
 * Read and check the person's own record: signed by their own key, each
 * payload matching its signed hash and key commitment, and, against the
 * session's mark, never older and never another record at the same
 * version. A newer one must chain to the mark. Throws a `CryptoError`
 * (`contacts-rollback`, `contacts-fork`, or another code for an invalid
 * record, on which the client must stop).
 */
export async function readContacts(
  { api, installationId, identity }: Owner,
  mark: ContactsMark | null,
): Promise<ContactsBook> {
  const served = await api.call(contactsRoutes.getContacts, {
    query: mark ? { after: mark.version } : {},
  });
  if (served.record === null) {
    if (mark) throw new CryptoError('contacts-rollback', 'The server has no contacts record now');
    return { record: null, payloads: newContactsPayloads(), mark: null };
  }
  const opened = openContacts({
    reader: identity,
    owner: identity.public,
    installationId,
    sealed: served.record,
  });
  if (!opened.private) throw new CryptoError('malformed', 'The private part is missing');
  if (mark && compareContactsMark(mark, opened.record) === 'newer') {
    const last = requireContactsChain({
      owner: identity.public,
      installationId,
      mark,
      chain: served.chain,
    });
    if (contactsHash(last) !== contactsHash(opened.record)) {
      throw new CryptoError('contacts-fork', 'The contacts chain ends at another record');
    }
  }
  return {
    record: opened.record,
    payloads: { shared: opened.shared, private: opened.private },
    mark: { version: opened.record.version, contactsHash: contactsHash(opened.record) },
  };
}

/**
 * An agent's read of its person's record (sections 8.5 and 9.3): signed by
 * the person's key it pinned at enrollment, with the shared payload, which
 * is sealed to it, and the same mark checks as the person's own. It never
 * sees the private payload, and never writes the record.
 */
export async function readPersonContacts(
  {
    api,
    installationId,
    agent,
    person,
  }: {
    api: ApiClient;
    installationId: InstallationId;
    agent: PrivateIdentity;
    person: PublicIdentity;
  },
  mark: ContactsMark | null,
): Promise<ContactsBook> {
  const served = await api.call(contactsRoutes.getContacts, {
    query: mark ? { after: mark.version } : {},
  });
  if (served.record === null) {
    throw new CryptoError('contacts-rollback', 'The server has no contacts record for the person');
  }
  const opened = openContacts({
    reader: agent,
    owner: person,
    installationId,
    sealed: served.record,
  });
  if (mark && compareContactsMark(mark, opened.record) === 'newer') {
    const last = requireContactsChain({ owner: person, installationId, mark, chain: served.chain });
    if (contactsHash(last) !== contactsHash(opened.record)) {
      throw new CryptoError('contacts-fork', 'The contacts chain ends at another record');
    }
  }
  return {
    record: opened.record,
    payloads: { shared: opened.shared, private: newContactsPayloads().private },
    mark: { version: opened.record.version, contactsHash: contactsHash(opened.record) },
  };
}

/** How many times a write re-applies its changes after losing a race. */
const ATTEMPTS = 5;

/**
 * Write a new version of the record with `changes` applied (section 8.6).
 * After a lost race it reads the newer record and re-applies them to that
 * instead, so another device's changes are kept; a change the two disagree
 * on throws `contacts-conflict` for the person to decide. With `holds`, the
 * write is **confirmed**: the record is read back, and must be this version
 * or a later one chained to it, still satisfying `holds`; otherwise it
 * throws `contacts-unconfirmed`, and the caller must not take the step that
 * depended on it. Returns the book after the write.
 */
export async function writeContacts(
  owner: Owner,
  book: ContactsBook,
  changes: readonly ContactsChange[],
  { holds }: { holds?: (payloads: ContactsPayloads) => boolean } = {},
): Promise<ContactsBook> {
  let base = book;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const next = changes.reduce(applyContactsChange, base.payloads);
    const sealed = sealContacts({
      owner: owner.identity,
      installationId: owner.installationId,
      previous: base.record,
      shared: next.shared,
      private: next.private,
    });
    try {
      await owner.api.call(contactsRoutes.putContacts, {
        body: { expectedVersion: base.record?.version ?? 0, record: sealed },
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale-head') {
        base = await readContacts(owner, base.mark);
        continue;
      }
      throw error;
    }
    const written: ContactsBook = {
      record: sealed.record,
      payloads: next,
      mark: { version: sealed.record.version, contactsHash: contactsHash(sealed.record) },
    };
    if (!holds) return written;
    // Confirmed: read it back. A later version must chain to this one.
    const reread = await readContacts(owner, written.mark).catch((error: unknown) => {
      if (error instanceof CryptoError || error instanceof ApiError) return null;
      throw error;
    });
    if (!reread || !holds(reread.payloads)) {
      throw new CryptoError('contacts-unconfirmed', 'The contacts change could not be confirmed');
    }
    return reread;
  }
  throw new CryptoError('contacts-unconfirmed', 'Contacts kept changing on another device');
}

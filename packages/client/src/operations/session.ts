import { systemRoutes, type InstallationId, type SpaceId } from '@wikistow/contracts';
import type { ApiClient } from '../api/client.ts';
import {
  applyContactsChange,
  type ContactsChange,
  type ContactsMark,
  type ContactsPayloads,
  type OwnAgent,
} from '../contacts.ts';
import { CryptoError } from '../errors.ts';
import { FolderKeyring } from '../folder-keys.ts';
import { keyHash, type PrivateIdentity, type PublicIdentity } from '../identity.ts';
import { MemoryKeyVersionMarks, type KeyVersionMarks } from '../key-versions.ts';
import { RevisionCache } from '../revision-cache.ts';
import { TrustStore } from '../trust.ts';
import type { UnlockedVault } from '../vault.ts';
import { readContacts, readPersonContacts, writeContacts, type ContactsBook } from './contacts.ts';
import type { SpaceKeys } from './keys.ts';

/**
 * Everything an operation needs once the vault is open: the API, this
 * installation, the person's keys, the keys they have verified, and their
 * contacts record. Operations are the single place each action is
 * implemented, shared by the web app, the desktop app, and the CLI.
 */
export type ClientContext = {
  api: ApiClient;
  installationId: InstallationId;
  identity: PrivateIdentity;
  trust: TrustStore;
  /**
   * The person's contacts record as this session last accepted it, and the
   * changes made since that aren't written yet (`saveContacts`).
   */
  contacts: { book: ContactsBook; pending: ContactsChange[] };
  /** The folder keys this session has opened, wiped when it locks (`closeSession`). */
  keyring: FolderKeyring;
  /** Opened revisions in memory only, dropped when access changes or the session locks. */
  revisions: RevisionCache;
  /** The No going back marks: the browser keeps them for one session (section 6.8). */
  marks: KeyVersionMarks;
  /** Each space as this session last worked it out (`spaceKeys`). */
  spaces: Map<SpaceId, Promise<SpaceKeys>>;
  /**
   * Set when this session is an agent's (`openAgentSession`): the person it
   * acts for, at the key it pinned at enrollment, its own entry in that
   * person's contacts record, and where it keeps its first-seen pins.
   * Absent for a person's own session.
   */
  agent?: { person: PublicIdentity; entry: OwnAgent; pins: AgentPins };
};

/**
 * Where an agent keeps the first-seen pins it makes (sections 8.3 and 9.3)
 * from one run to the next: the CLI's local file. It never writes them to
 * its person's record. `save` gets each batch of contacts changes the
 * session made, in order, to keep after the ones before; `load` gives back
 * all of them, in the same order.
 */
export interface AgentPins {
  load(): readonly ContactsChange[] | Promise<readonly ContactsChange[]>;
  save(changes: readonly ContactsChange[]): void | Promise<void>;
}

/** Pins kept in memory, for one process: tests, or an agent that keeps nothing. */
export class MemoryAgentPins implements AgentPins {
  #changes: ContactsChange[] = [];

  load(): readonly ContactsChange[] {
    return [...this.#changes];
  }

  save(changes: readonly ContactsChange[]): void {
    this.#changes.push(...changes);
  }
}

/**
 * Build the context for an unlocked vault: pin the person's own keys, read
 * their contacts record and load the keys they have pinned. A record that
 * fails its checks stops the session, since nothing may be sealed or signed
 * until the person resolves it (section 8.5).
 */
export async function openSession(api: ApiClient, vault: UnlockedVault): Promise<ClientContext> {
  const { installationId } = await api.call(systemRoutes.installation);
  const trust = new TrustStore(installationId);
  trust.pinSelf(vault.identity);
  const book = await readContacts({ api, installationId, identity: vault.identity }, null);
  trust.load(book.payloads);
  return {
    api,
    installationId,
    identity: vault.identity,
    trust,
    contacts: { book, pending: [] },
    keyring: new FolderKeyring(),
    revisions: new RevisionCache(),
    marks: new MemoryKeyVersionMarks(),
    spaces: new Map(),
  };
}

/**
 * Open an agent's session (section 9.3): its own keys, its bearer token in
 * `api`, and its person at the key it pinned at enrollment. It reads its
 * person's contacts record, which is sealed to it, finds its own entry
 * there, checks that entry's enrollment under the person's key and against
 * its own keys, and trusts the person's pins, then its own first-seen
 * `pins`. Where its own pin disagrees with the record, the record wins, as
 * on another device (section 8.6). A revoked agent, or a record that fails
 * its checks, stops the session.
 *
 * What the CLI keeps in its local file between runs comes in: `mark`, the
 * contacts mark from its last session, if any; `marks`, its No going back
 * marks (section 6.8); and `pins`. Keep `agentContactsMark(ctx)` as the
 * next session's `mark`.
 */
export async function openAgentSession(
  api: ApiClient,
  {
    identity,
    person,
    mark = null,
    marks,
    pins,
  }: {
    identity: PrivateIdentity;
    person: PublicIdentity;
    mark?: ContactsMark | null;
    marks: KeyVersionMarks;
    pins: AgentPins;
  },
): Promise<ClientContext> {
  const { installationId } = await api.call(systemRoutes.installation);
  const book = await readPersonContacts({ api, installationId, agent: identity, person }, mark);
  const { shared } = book.payloads;
  const entry = shared.agents.find((agent) => agent.enrollment.agent.id === identity.public.id);
  if (!entry) throw new CryptoError('wrong-recipient', 'The person’s record lists no such agent');
  if (shared.revokedAgents.some((revoked) => revoked.agentId === identity.public.id)) {
    throw new CryptoError('agent-revoked', 'The person revoked this agent');
  }
  const trust = new TrustStore(installationId);
  trust.pinOwnPerson(person, entry.enrollment, identity);
  let trusted = book.payloads;
  for (const change of await pins.load()) {
    try {
      trusted = applyContactsChange(trusted, change);
    } catch (error) {
      if (!(error instanceof CryptoError && error.code === 'contacts-conflict')) throw error;
    }
  }
  trust.load(trusted);
  return {
    api,
    installationId,
    identity,
    trust,
    contacts: { book, pending: [] },
    keyring: new FolderKeyring(),
    revisions: new RevisionCache(),
    marks,
    spaces: new Map(),
    agent: { person, entry, pins },
  };
}

/**
 * The contacts mark an agent's session accepted, for the CLI to keep as its
 * next session's `mark` (section 9.3).
 */
export function agentContactsMark(ctx: ClientContext): ContactsMark | null {
  if (!ctx.agent) throw new CryptoError('malformed', 'Only an agent keeps its person’s mark');
  return ctx.contacts.book.mark;
}

/**
 * End the session when the app locks: drop opened revisions, wipe every
 * folder key it opened, and forget what it worked out about each space.
 * The context can't be used after this; unlocking opens a new session.
 */
export function closeSession(ctx: ClientContext): void {
  ctx.revisions.close();
  ctx.keyring.wipe();
  ctx.spaces.clear();
}

// Each session writes its contacts record one change set at a time, each
// starting from the record the last one left, so writes from operations
// running side by side never race each other.
const writing = new WeakMap<ClientContext['contacts'], Promise<unknown>>();

/**
 * Write the pins this session made, any changes queued in `ctx.contacts`,
 * and `changes`, as the next version of the contacts record (section 8.6).
 * With `holds` the write is confirmed (`writeContacts`); with `confirm`, it
 * is confirmed to hold every change it wrote. If it fails, every change
 * stays queued for the next write.
 *
 * A pin the record already holds at other keys, as when another device saw
 * the person first, can never be written: it is dropped, the trust store
 * is reloaded from the record, and the rest is written. So that person's
 * key is a key change from then on. With `sealTo`, the keys about to be
 * sealed to, each must be pinned at that key once the write is done, or it
 * throws `identity-key-changed`.
 *
 * An agent never writes the record (section 8.3): its first-seen pins go to
 * its own store (`AgentPins`), and asking it to write a change is
 * `malformed`.
 */
export function saveContacts(
  ctx: ClientContext,
  changes: readonly ContactsChange[] = [],
  {
    sealTo = [],
    ...options
  }: {
    holds?: (payloads: ContactsPayloads) => boolean;
    confirm?: boolean;
    sealTo?: readonly PublicIdentity[];
  } = {},
): Promise<void> {
  if (ctx.agent) {
    if (changes.length > 0 || sealTo.length > 0) {
      return Promise.reject(new CryptoError('malformed', 'Agents never write a contacts record'));
    }
    return keepAgentPins(ctx, ctx.agent.pins);
  }
  const write = () => writeQueued(ctx, changes, options);
  const run = (writing.get(ctx.contacts) ?? Promise.resolve()).then(write, write);
  writing.set(
    ctx.contacts,
    run.catch(() => {}),
  );
  return run.then(() => {
    for (const identity of sealTo) {
      if (ctx.trust.check(identity).kind !== 'pinned') {
        throw new CryptoError(
          'identity-key-changed',
          `The contacts record holds no pin of ${identity.id} at this key`,
        );
      }
    }
  });
}

// An agent's first-seen pins go to its own store; if that fails, they stay
// queued for the next save.
async function keepAgentPins(ctx: ClientContext, pins: AgentPins): Promise<void> {
  const all = [...ctx.contacts.pending, ...ctx.trust.takeChanges()];
  ctx.contacts.pending = [];
  if (all.length === 0) return;
  try {
    await pins.save(all);
  } catch (error) {
    ctx.contacts.pending = [...all, ...ctx.contacts.pending];
    throw error;
  }
}

async function writeQueued(
  ctx: ClientContext,
  changes: readonly ContactsChange[],
  {
    holds,
    confirm = false,
  }: { holds?: (payloads: ContactsPayloads) => boolean; confirm?: boolean },
): Promise<void> {
  let all = [...ctx.contacts.pending, ...ctx.trust.takeChanges(), ...changes];
  ctx.contacts.pending = [];
  const owner = { api: ctx.api, installationId: ctx.installationId, identity: ctx.identity };
  for (;;) {
    if (all.length === 0) return;
    const writing = all;
    const confirmed = confirm
      ? (payloads: ContactsPayloads) =>
          writing.every((change) => changeHolds(change, payloads)) && (holds?.(payloads) ?? true)
      : holds;
    try {
      ctx.contacts.book = await writeContacts(
        owner,
        ctx.contacts.book,
        all,
        confirmed ? { holds: confirmed } : {},
      );
      break;
    } catch (error) {
      const kept =
        error instanceof CryptoError && error.code === 'contacts-conflict'
          ? await withoutConflictingPins(ctx, all).catch(() => null)
          : null;
      if (!kept) {
        ctx.contacts.pending = [...all, ...ctx.contacts.pending];
        throw error;
      }
      all = kept;
    }
  }
  // Pins another device wrote meanwhile.
  ctx.trust.load(ctx.contacts.book.payloads);
}

// The changes left once every pin the stored record disagrees with is
// dropped, with the book and trust store reloaded from that record; or
// null if no pin is the conflict.
async function withoutConflictingPins(
  ctx: ClientContext,
  changes: readonly ContactsChange[],
): Promise<ContactsChange[] | null> {
  const owner = { api: ctx.api, installationId: ctx.installationId, identity: ctx.identity };
  const stored = await readContacts(owner, ctx.contacts.book.mark);
  const conflicts = (change: ContactsChange) => {
    if (change.kind !== 'pin') return false;
    try {
      applyContactsChange(stored.payloads, change);
      return false;
    } catch (error) {
      if (error instanceof CryptoError && error.code === 'contacts-conflict') return true;
      throw error;
    }
  };
  const dropped = changes.filter(conflicts);
  if (dropped.length === 0) return null;
  ctx.contacts.book = stored;
  ctx.trust.reload(
    stored.payloads,
    dropped.flatMap((change) => (change.kind === 'pin' ? [change.pin.identity] : [])),
  );
  return changes.filter((change) => !dropped.includes(change));
}

// Whether the record holds what `change` says: a pin at its key, an owner
// accepted or removed. Other changes aren't confirmed.
function changeHolds(change: ContactsChange, { shared }: ContactsPayloads): boolean {
  const entry = (spaceId: string) => shared.spaceOwners.find((e) => e.spaceId === spaceId);
  switch (change.kind) {
    case 'pin':
    case 'confirm-key': {
      const { identity } = change.pin;
      return shared.contacts.some(
        (c) => c.identity.id === identity.id && keyHash(c.identity) === keyHash(identity),
      );
    }
    case 'accept-owner':
    case 'add-co-owner': {
      const { owner } = change;
      const found = entry(change.spaceId);
      return (
        !!found?.owners.some((o) => o.id === owner.id && o.keyHash === owner.keyHash) &&
        !found.removedOwners.some((id) => id === owner.id)
      );
    }
    case 'remove-owner':
      return !!entry(change.spaceId)?.removedOwners.some((id) => id === change.ownerId);
    default:
      return true;
  }
}

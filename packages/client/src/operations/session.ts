import {
  identityRoutes,
  systemRoutes,
  vaultRoutes,
  type InstallationId,
  type ServedVaultWrapper,
  type SpaceId,
} from '@wikistow/contracts';
import { ApiError, type ApiClient } from '../api/client.ts';
import {
  applyContactsChange,
  type ContactsChange,
  type ContactsMark,
  type ContactsPayloads,
  type OwnAgent,
} from '../contacts.ts';
import { CryptoError } from '../errors.ts';
import { FolderKeyring } from '../folder-keys.ts';
import {
  keyHash,
  openWithRetired,
  type PrivateIdentity,
  type PublicIdentity,
} from '../identity.ts';
import { KeptMarks, type KeptFile } from '../kept-marks.ts';
import type { KeptStore } from '../kept-store.ts';
import { keptUnlock } from '../kept-unlock.ts';
import { MemoryKeyVersionMarks, type KeyVersionMarks } from '../key-versions.ts';
import { unseenRestore } from '../restore.ts';
import { RevisionCache } from '../revision-cache.ts';
import { TrustStore } from '../trust.ts';
import { unlocks, type UnlockedVault } from '../vault.ts';
import {
  openKeptContacts,
  readContacts,
  readPersonContacts,
  writeContacts,
  type ContactsBook,
} from './contacts.ts';
import { chainFrom } from './chains.ts';
import { KeptContent, keptUnderEarlierKeys, sealKeptAgain } from './kept.ts';
import type { SpaceKeys } from './keys.ts';
import { keepWrapper } from './vault.ts';

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
  /**
   * The No going back marks (section 6.8): kept between sessions where the
   * device keeps them (`kept`), else for one session.
   */
  marks: KeyVersionMarks;
  /**
   * What this device keeps between sessions, if it keeps anything: `marks`
   * and the contacts mark with its record, which follow `contacts.book`
   * (`openSession`).
   */
  kept?: KeptMarks;
  /**
   * Pages and what they show kept on this device for offline use (ADR
   * 0009), where the app keeps them: versions are read from here before
   * the server, and the keeper keeps them current (`keep`).
   */
  keptContent?: KeptContent;
  /** Each space as this session last worked it out (`spaceKeys`). */
  spaces: Map<SpaceId, Promise<SpaceKeys>>;
  /**
   * Set while a session opened with no answer from the server waits for
   * one: the vault version it unlocked against, which `confirmSession`
   * checks with the rest of what opening skipped (ADR 0009, decision 5).
   */
  unconfirmed?: { vaultVersion: number };
  /**
   * Set when this session is an agent's (`openAgentSession`): the person it
   * acts for, at the key it pinned at enrollment, its own entry in that
   * person's contacts record, and where it keeps its first-seen pins.
   * Absent for a person's own session.
   */
  agent?: {
    person: PublicIdentity;
    entry: OwnAgent;
    pins: AgentPins;
    /**
     * The person's key the agent had pinned, when it followed their chain
     * from it to `person` in this session (section 4.6, **Agents**): the
     * CLI keeps the new key and says so once.
     */
    followedFrom: PublicIdentity | null;
  };
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
 *
 * With `kept`, the device's file (the browser's, or the desktop app's with
 * a trusted keyring), the session starts from the contacts mark and No
 * going back marks kept there and keeps them as they rise, with the record
 * (`KeptMarks`). After a restore of the server those marks haven't seen,
 * they are dropped first, so what the server serves now is the starting
 * point (`unseenRestore`); the app tells the person itself. Without `kept`
 * each session starts with none. With `content`, the session reads and
 * keeps pages there (`keptContent`), and keeps the installation ID for
 * opening offline (`openKeptSession`).
 */
export async function openSession(
  api: ApiClient,
  vault: UnlockedVault,
  { kept: file, content }: { kept?: KeptFile; content?: KeptStore } = {},
): Promise<ClientContext> {
  const { installationId, restore } = await api.call(systemRoutes.installation);
  // The vault's retired keys open what was sealed to them (section 4.6).
  openWithRetired(vault.identity, vault.retired);
  const kept =
    file &&
    (await KeptMarks.open(file, {
      identity: vault.identity,
      installationId,
      retired: vault.retired,
    }));
  try {
    return await sessionFrom(api, vault, { installationId, restore, kept, content });
  } catch (error) {
    // A session that never started leaves no marks listening.
    kept?.close();
    throw error;
  }
}

async function sessionFrom(
  api: ApiClient,
  vault: UnlockedVault,
  {
    installationId,
    restore,
    kept,
    content,
  }: {
    installationId: InstallationId;
    restore: Parameters<typeof unseenRestore>[0];
    kept: KeptMarks | undefined;
    content: KeptStore | undefined;
  },
): Promise<ClientContext> {
  const unseen = kept && unseenRestore(restore, kept.restoredAt);
  if (unseen) kept.startOver(unseen.restoredAt);
  const trust = new TrustStore(installationId);
  trust.pinSelf(vault.identity);
  const owner = { api, installationId, identity: vault.identity };
  const book = await readContacts(owner, kept?.contactsMark ?? null);
  kept?.keepContacts(book);
  trust.load(book.payloads);
  const who = { identity: vault.identity, installationId };
  // What this device kept under an earlier key is sealed again under this
  // one first (section 4.6). If that fails, the session keeps nothing there,
  // so it stays for the next one.
  const resealed =
    content &&
    (await sealKeptAgain(content, { ...who, retired: vault.retired }).then(
      async () => !(await keptUnderEarlierKeys(content, { ...who, retired: vault.retired })),
      () => false,
    ));
  const keptContent = content && resealed ? await KeptContent.open(content, who) : undefined;
  // For a session opened offline later (`openKeptSession`).
  if (content)
    await keptUnlock(content)
      .keepInstallationId(installationId)
      .catch(() => {});
  return {
    api,
    installationId,
    identity: vault.identity,
    trust,
    contacts: { book, pending: [] },
    keyring: new FolderKeyring(),
    revisions: new RevisionCache(),
    marks: kept ?? new MemoryKeyVersionMarks(),
    ...(kept && { kept }),
    ...(keptContent && { keptContent }),
    spaces: new Map(),
  };
}

/**
 * Open a session with no answer from the server (ADR 0009, decision 5): from
 * the installation ID this device kept in `content`, and the contacts record
 * kept with its mark in `kept`, checked as a served record is
 * (`openKeptContacts`), which stops the session if it fails. Null if the
 * device kept no installation ID, so it can't open offline. The session reads what's
 * kept; nothing is signed or written until it is back online, where
 * `confirmSession` runs what this skipped. `vaultVersion` is the version of
 * the wrapper the vault opened against, or that a remembered unlock was
 * taken at.
 */
export async function openKeptSession(
  api: ApiClient,
  vault: UnlockedVault,
  {
    kept: file,
    content,
    vaultVersion,
  }: { kept: KeptFile; content: KeptStore; vaultVersion: number },
): Promise<ClientContext | null> {
  const installationId = await keptUnlock(content).installationId();
  if (!installationId) return null;
  openWithRetired(vault.identity, vault.retired);
  // Kept under earlier keys only: nothing opens offline until an online
  // session seals it again (`sealKeptAgain`).
  const who = { identity: vault.identity, installationId };
  if (await keptUnderEarlierKeys(content, { ...who, retired: vault.retired })) return null;
  const kept = await KeptMarks.open(file, { ...who, retired: vault.retired });
  const owner = { installationId, identity: vault.identity };
  let book: ReturnType<typeof openKeptContacts>;
  try {
    book = openKeptContacts(owner, kept.contactsMark, kept.contactsRecord);
  } catch (error) {
    // A session that never started leaves no marks listening.
    kept.close();
    throw error;
  }
  const trust = new TrustStore(installationId);
  trust.pinSelf(vault.identity);
  trust.load(book.payloads);
  const keptContent = await KeptContent.open(content, { identity: vault.identity, installationId });
  return {
    api,
    installationId,
    identity: vault.identity,
    trust,
    contacts: { book, pending: [] },
    keyring: new FolderKeyring(),
    revisions: new RevisionCache(),
    marks: kept,
    kept,
    keptContent,
    spaces: new Map(),
    unconfirmed: { vaultVersion },
  };
}

/**
 * Once the server answers again, run what opening a session offline skipped
 * (ADR 0009, decision 5): the installation, the vault's version, and the
 * contacts record against the session's mark. Another installation means
 * nothing kept opens for it, and a newer vault version that the passphrase
 * changed elsewhere: either ends the session, which the app does by
 * locking. A vault now in a format this version doesn't unlock, as after
 * someone replaced their keys with a newer app, ends it too, but asks to
 * update (`update-app`): the app keeps a remembered unlock and the wrapper
 * it kept. A restore not seen starts the marks over, as `openSession` does.
 * The wrapper served is kept for the next offline unlock. A record that
 * fails its checks throws a `CryptoError`, and the session must stop.
 * Otherwise the session is confirmed and goes on as one opened online.
 */
export async function confirmSession(
  ctx: ClientContext,
): Promise<'confirmed' | 'other-installation' | 'passphrase-changed' | 'update-app'> {
  const unconfirmed = ctx.unconfirmed;
  if (!unconfirmed) return 'confirmed';
  const { installationId, restore } = await ctx.api.call(systemRoutes.installation);
  if (installationId !== ctx.installationId) return 'other-installation';
  const served = await ctx.api.call(vaultRoutes.getVault);
  if (!unlocks(served.wrapper)) return 'update-app';
  const store = ctx.keptContent?.store;
  // A passphrase changed elsewhere keeps the keyring as it was: its new
  // wrapper is kept for unlocking offline. A new keyring, as after keys
  // were replaced elsewhere, isn't kept yet: the person may say they didn't,
  // and the device keeps what it had (section 4.6).
  const kept = store && (await keptUnlock(store).vault());
  if (store && (!kept || sameKeyring(kept.wrapper, served.wrapper))) {
    await keepWrapper(store, served);
  }
  if (served.version !== unconfirmed.vaultVersion) return 'passphrase-changed';
  const unseen = ctx.kept && unseenRestore(restore, ctx.kept.restoredAt);
  if (unseen) ctx.kept?.startOver(unseen.restoredAt);
  const owner = { api: ctx.api, installationId, identity: ctx.identity };
  const book = await readContacts(owner, unseen ? null : ctx.contacts.book.mark);
  ctx.contacts.book = book;
  ctx.kept?.keepContacts(book);
  // Pins from the record served now, as an online unlock takes them: a key
  // another device confirmed meanwhile replaces the one kept.
  const trust = new TrustStore(installationId);
  trust.pinSelf(ctx.identity);
  trust.load(book.payloads);
  ctx.trust = trust;
  // Spaces worked out meanwhile under the kept pins are worked out again
  // under these, as after a contacts write (`forgetSpaces`).
  ctx.spaces.clear();
  delete ctx.unconfirmed;
  return 'confirmed';
}

/**
 * Open an agent's session (section 9.3): its own keys, its bearer token in
 * `api`, and its person at the key it pinned at enrollment, or since
 * followed. If its person replaced their keys, it follows the chain from
 * that key to their current one first, and refuses one that doesn't check
 * out (`identity-key-changed`); the session then holds the new key in
 * `agent.person`, with the one it came from in `agent.followedFrom`. It
 * reads its person's contacts record, which is sealed to it, finds its own entry
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
    person: pinned,
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
  // A server from before following serves no history to agents: nothing
  // to follow there, as nobody can have replaced their keys.
  const chain = await chainFrom(api, installationId, pinned).catch((error: unknown) => {
    if (servesAgentsNoHistory(error)) return null;
    throw error;
  });
  const person = chain?.last ?? pinned;
  // Every earlier key of the person, from key version 1, as what they sealed
  // to this agent before still opens: after this session too, when the key
  // file holds the new key and there is nothing more to follow.
  const history =
    person.keyVersion > 1
      ? await (async () => {
          const { identity: first } = await api.call(identityRoutes.version, {
            params: { identityId: person.id, keyVersion: 1 },
          });
          return chainFrom(api, installationId, first, person);
        })().catch((error: unknown) => {
          // A server that serves agents no history: earlier writing stays closed.
          if (servesAgentsNoHistory(error)) return null;
          throw error;
        })
      : null;
  const earlier = history?.keys.slice(0, -1) ?? [];
  const book = await readPersonContacts(
    { api, installationId, agent: identity, person, earlier },
    mark,
  );
  const { shared } = book.payloads;
  const entry = shared.agents.find((agent) => agent.enrollment.agent.id === identity.public.id);
  if (!entry) throw new CryptoError('wrong-recipient', 'The person’s record lists no such agent');
  if (shared.revokedAgents.some((revoked) => revoked.agentId === identity.public.id)) {
    throw new CryptoError('agent-revoked', 'The person revoked this agent');
  }
  const trust = new TrustStore(installationId);
  trust.pinOwnPerson(person, entry.enrollment, identity);
  // What the person signed and sealed before, for opening only.
  if (history) trust.addEarlierKeys(history);
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
    agent: { person, entry, pins, followedFrom: chain ? pinned : null },
  };
}

// A server from before following answers an agent's history request as a
// route it doesn't have or won't serve it; anything else, as a busy server,
// is an error to try again.
const servesAgentsNoHistory = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);

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
 * folder key it opened, forget what it worked out about each space, and
 * stop writing kept marks.
 * The context can't be used after this; unlocking opens a new session.
 */
export function closeSession(ctx: ClientContext): void {
  ctx.kept?.close();
  ctx.keptContent?.close();
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
      ctx.kept?.keepContacts(ctx.contacts.book);
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
  ctx.kept?.keepContacts(stored);
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
    // Held when the pin is the followed key, or a later one (section 8.6).
    case 'follow-key': {
      const { identity } = change.to;
      const pin = shared.contacts.find((c) => c.identity.id === identity.id);
      return (
        !!pin &&
        (keyHash(pin.identity) === keyHash(identity) ||
          pin.identity.keyVersion > identity.keyVersion)
      );
    }
    // Held once every key above the restored pin is removed.
    case 'decline-follow': {
      const removed = new Set(shared.removed.map((r) => r.keyHash));
      const fromHash = keyHash(change.from.identity);
      return change.chain.every((hashed) => hashed === fromHash || removed.has(hashed));
    }
    default:
      return true;
  }
}

// Whether two wrappers seal the same keyring: a passphrase change leaves it
// byte for byte as it was.
function sameKeyring(a: ServedVaultWrapper, b: ServedVaultWrapper): boolean {
  const keyring = (w: ServedVaultWrapper) =>
    'keyring' in w && typeof w.keyring === 'object' && w.keyring !== null
      ? (w.keyring as { nonce?: unknown; ciphertext?: unknown })
      : null;
  const [x, y] = [keyring(a), keyring(b)];
  return x !== null && y !== null && x.nonce === y.nonce && x.ciphertext === y.ciphertext;
}

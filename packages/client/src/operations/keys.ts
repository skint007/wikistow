// What a person's app works out about one space before it opens or writes
// anything there (protocol sections 6.4 and 6.5): the owners it accepts, and
// the folder keys it holds, opened from the envelopes addressed to it.
import {
  ownerRoutes,
  peopleRoutes,
  sharingRoutes,
  type FolderKeyEnvelope,
  type IdentityId,
  type OwnerStatement,
  type ShareId,
  type SpaceId,
} from '@wikistow/contracts';
import { applyContactsChange, type ContactsChange, type SpaceOwners } from '../contacts.ts';
import { CryptoError, type CryptoErrorCode } from '../errors.ts';
import { openFolderKeys } from '../folder-keys.ts';
import { keyHash, type PublicIdentity } from '../identity.ts';
import { markOpened } from '../key-versions.ts';
import { opensFor, type OpensOwner } from '../owner-predicates.ts';
import { acceptOwners, agentOwners, type AcceptedOwners } from '../owners.ts';
import type { DirectoryEntry } from '../trust.ts';
import { saveContacts, type ClientContext } from './session.ts';

/** One space as this app sees it. */
export type SpaceKeys = {
  spaceId: SpaceId;
  owners: AcceptedOwners;
  /** The owners the server lists, as the directory names them. */
  listed: readonly DirectoryEntry[];
  /** The space's permission version, which owner changes carry. */
  permissionVersion: number;
  statements: readonly OwnerStatement[];
  /** Every folder key envelope addressed to this person in the space, as served. */
  envelopes: readonly FolderKeyEnvelope[];
  /** Envelopes addressed to this person that it refused, and why: possibly an attack. */
  refused: readonly { shareId: ShareId; keyVersion: number; code: CryptoErrorCode }[];
};

/**
 * The space as this app sees it, worked out once per session and again
 * after anything that could change it: an owner action, a contacts write,
 * or `refresh`. Pass `confirmedAdder` once the person confirms the co-owner
 * dialog for `owners.adderToConfirm` (section 6.5, step 2).
 */
export function spaceKeys(
  ctx: ClientContext,
  spaceId: SpaceId,
  { refresh = false, confirmedAdder }: { refresh?: boolean; confirmedAdder?: PublicIdentity } = {},
): Promise<SpaceKeys> {
  const cached = ctx.spaces.get(spaceId);
  if (cached && !refresh && !confirmedAdder) return cached;
  const loading = ctx.agent
    ? loadAgentSpaceKeys(ctx, spaceId, ctx.agent.person)
    : loadSpaceKeys(ctx, spaceId, confirmedAdder);
  ctx.spaces.set(spaceId, loading);
  loading.catch(() => {
    if (ctx.spaces.get(spaceId) === loading) ctx.spaces.delete(spaceId);
  });
  return loading;
}

// The owner each space's first sight accepted in this session, which a
// contacts record, keeping accepted owners as a set, doesn't record.
const firstSights = new WeakMap<ClientContext['contacts'], Map<SpaceId, PublicIdentity>>();
const firstSeen = (ctx: ClientContext) => {
  let seen = firstSights.get(ctx.contacts);
  if (!seen) firstSights.set(ctx.contacts, (seen = new Map()));
  return seen;
};

/** The owner this session's app accepted in `spaceId` by first sight (section 6.5, step 2), if any. */
export const firstSightIn = (ctx: ClientContext, spaceId: SpaceId): PublicIdentity | null =>
  firstSeen(ctx).get(spaceId) ?? null;

/** Forget what was worked out for every space, so the next operation works it out again. */
export function forgetSpaces(ctx: ClientContext): void {
  ctx.spaces.clear();
}

async function loadSpaceKeys(
  ctx: ClientContext,
  spaceId: SpaceId,
  confirmedAdder: PublicIdentity | undefined,
): Promise<SpaceKeys> {
  const [served, { statements }, { envelopes }] = await Promise.all([
    ctx.api.call(ownerRoutes.owners, { params: { spaceId } }),
    ctx.api.call(ownerRoutes.statements, { params: { spaceId } }),
    ctx.api.call(sharingRoutes.myEnvelopes, { params: { spaceId } }),
  ]);
  const listed = served.owners;
  const named = new Set<IdentityId>();
  for (const statement of statements) {
    named.add(statement.signerId);
    named.add(statement.owner.id);
  }
  for (const envelope of envelopes) named.add(envelope.sealerId);
  for (const owner of listed) named.delete(owner.identity.id);
  const directory = [...listed, ...(await lookupPeople(ctx, [...named]))];
  const owners = acceptOwners({
    installationId: ctx.installationId,
    spaceId,
    self: ctx.identity.public,
    trust: ctx.trust,
    entry: ownersEntry(ctx, spaceId),
    nameRecords: served.nameRecords,
    statements,
    envelopes,
    listedOwners: listed.map((owner) => owner.identity),
    directory,
    ...(confirmedAdder
      ? { confirmedAdder: { id: confirmedAdder.id, keyHash: keyHash(confirmedAdder) } }
      : {}),
  });
  if (owners.firstSight) firstSeen(ctx).set(spaceId, owners.firstSight);
  // Owners accepted, and keys pinned on the way, are recorded before
  // anything is opened with them (section 6.5, step 5).
  await saveContacts(ctx, owners.changes, { confirm: true });
  return {
    spaceId,
    owners,
    listed,
    permissionVersion: served.permissionVersion,
    statements,
    envelopes,
    refused: openEnvelopes(ctx, spaceId, owners, envelopes, owners.opens),
  };
}

/**
 * The space as an agent sees it (sections 6.4 and 9.3): owners only as its
 * person's contacts record accepts them, and folder keys only from the
 * envelopes its person sealed to it. It reads no owner list or statements,
 * and accepts no owner of its own.
 */
async function loadAgentSpaceKeys(
  ctx: ClientContext,
  spaceId: SpaceId,
  person: PublicIdentity,
): Promise<SpaceKeys> {
  const { envelopes } = await ctx.api.call(sharingRoutes.myEnvelopes, { params: { spaceId } });
  const owners = agentOwners({ entry: ownersEntry(ctx, spaceId), person });
  const sealedBy = keyHash(person);
  const byPerson = opensFor((sealer) => sealer.id === person.id && keyHash(sealer) === sealedBy);
  return {
    spaceId,
    owners,
    listed: [],
    // Owner actions carry it, and agents take none.
    permissionVersion: 0,
    statements: [],
    envelopes,
    refused: openEnvelopes(ctx, spaceId, owners, envelopes, byPerson),
  };
}

// Open every envelope addressed to this app into the keyring, sealed by
// someone `sealers` accepts (an accepted owner, or an agent's own person),
// and raise each share's No going back mark. One that fails doesn't stop
// the others; it is reported.
function openEnvelopes(
  ctx: ClientContext,
  spaceId: SpaceId,
  owners: AcceptedOwners,
  envelopes: readonly FolderKeyEnvelope[],
  sealers: OpensOwner,
): SpaceKeys['refused'] {
  const refused: { shareId: ShareId; keyVersion: number; code: CryptoErrorCode }[] = [];
  const shares = new Set<ShareId>();
  for (const envelope of envelopes) {
    try {
      ctx.keyring.add(
        openFolderKeys({
          reader: ctx.identity,
          trust: ctx.trust,
          installationId: ctx.installationId,
          envelope,
          expect: { spaceId, shareId: envelope.shareId },
          sealers,
        }),
      );
      shares.add(envelope.shareId);
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      refused.push({
        shareId: envelope.shareId,
        keyVersion: envelope.keyVersion,
        code: error.code,
      });
    }
  }
  for (const shareId of shares) {
    markOpened({ keyring: ctx.keyring, marks: ctx.marks, spaceId, shareId, writes: owners.writes });
  }
  return refused;
}

/**
 * The space's entry in the person's contacts record, with the owner changes
 * this session made that aren't written yet.
 */
export function ownersEntry(ctx: ClientContext, spaceId: SpaceId): SpaceOwners | undefined {
  const pending = ctx.contacts.pending.filter(isOwnerChange);
  const payloads = pending.reduce(applyContactsChange, ctx.contacts.book.payloads);
  return payloads.shared.spaceOwners.find((entry) => entry.spaceId === spaceId);
}

const isOwnerChange = (change: ContactsChange) =>
  change.kind === 'accept-owner' ||
  change.kind === 'remove-owner' ||
  change.kind === 'add-co-owner';

/** The directory's entries for these identities, in batches the route takes. */
export async function lookupPeople(
  ctx: ClientContext,
  ids: readonly string[],
): Promise<DirectoryEntry[]> {
  return (await lookupDirectory(ctx, ids)).people;
}

/**
 * The directory's people for these identities, and its agents among them,
 * each with the enrollment its person signed (section 9.5).
 */
export async function lookupDirectory(
  ctx: ClientContext,
  ids: readonly string[],
): Promise<{ people: DirectoryEntry[]; agents: peopleRoutes.DirectoryAgent[] }> {
  const unique = [...new Set(ids)];
  const people: DirectoryEntry[] = [];
  const agents: peopleRoutes.DirectoryAgent[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    const found = await ctx.api.call(peopleRoutes.directory, {
      query: { ids: unique.slice(i, i + 100).join(',') },
    });
    people.push(...found.people);
    agents.push(...found.agents);
  }
  return { people, agents };
}

/**
 * Pin, seen for the first time, the authors of records about to be opened
 * whom this app hasn't pinned yet (section 8.3), so their signatures can be
 * checked, and record the pins in a confirmed contacts write, so the next
 * session warns if a key changes. An agent author is pinned only from the
 * enrollment its person signed, once that person is pinned (section 9.5).
 * An author the directory can't give, or whose key changed, stays unpinned,
 * and their records fail to open on their own.
 */
export async function pinAuthors(
  ctx: ClientContext,
  authors: readonly { authorId: IdentityId; authorKeyVersion: number }[],
): Promise<void> {
  const unpinned = authors.filter(({ authorId, authorKeyVersion }) => {
    try {
      ctx.trust.require(authorId, authorKeyVersion);
      return false;
    } catch {
      return true;
    }
  });
  if (unpinned.length === 0) return;
  const { people, agents } = await lookupDirectory(
    ctx,
    unpinned.map((author) => author.authorId),
  );
  const tryTo = (pin: () => void) => {
    try {
      pin();
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
    }
  };
  for (const entry of people) tryTo(() => ctx.trust.use({ ...entry, foundBy: null }));
  for (const { enrollment } of agents) tryTo(() => ctx.trust.pinEnrolledAgent(enrollment));
  await saveContacts(ctx, [], { confirm: true });
}

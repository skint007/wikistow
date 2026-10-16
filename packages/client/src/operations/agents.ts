// A person's side of their agents (protocol sections 9.2, 9.4 and 9.7):
// claiming an enrollment and approving it, granting and removing picks,
// sealing at unlock the key versions their agents lack, and revoking.
// Only a person's own app ever seals to their agents.
import {
  agentRoutes,
  type FolderId,
  type FolderKeyEnvelope,
  type GroupId,
  type IdentityId,
  type ShareId,
  type SpaceId,
} from '@wikistow/contracts';
import type { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { sealForAgent, type MissingVersions } from '../agents.ts';
import type { AgentShare, ContactsChange, ContactsPayloads, OwnAgent } from '../contacts.ts';
import { enrollmentDeadline } from '../enrollment.ts';
import { CryptoError } from '../errors.ts';
import { sealFolderKeys } from '../folder-keys.ts';
import {
  agentIdentityId,
  enrollmentFingerprint,
  requireUsableKeys,
  type PublicIdentity,
} from '../identity.ts';
import { OWNER_REGION, requireRegion } from '../regions.ts';
import { enrollAgent } from '../trust.ts';
import { spaceKeys } from './keys.ts';
import { openName, treeTarget } from './records.ts';
import { saveContacts, type ClientContext } from './session.ts';
import { shareFolder, versionsToGive, type SharePreview, type ShareRole } from './sharing.ts';

/** An enrollment this person claimed, with what their screen shows to compare. */
export type Claim = {
  enrollmentId: string;
  /** The agent's identity: its ID derives from this person and the keys the server served. */
  agent: PublicIdentity;
  /** Shown next to the lookup code; the CLI prints its own copy. */
  fingerprint: string;
  /** The earlier of the server's `expiresAt` and this app's start plus ten minutes. */
  deadline: Date;
};

/**
 * Step 2: claim the enrollment a lookup code names (after a recent
 * sign-in). The agent's keys come from the server, so the fingerprint is
 * what the person compares with the CLI's before approving.
 */
export async function claimEnrollment(
  ctx: ClientContext,
  lookupCode: string,
  now: () => Date = () => new Date(),
): Promise<Claim> {
  requirePerson(ctx);
  const startedAt = now();
  const claimed = await ctx.api.call(agentRoutes.claimEnrollment, { body: { lookupCode } });
  const keys = { boxPublicKey: claimed.boxPublicKey, signPublicKey: claimed.signPublicKey };
  requireUsableKeys(keys);
  const agent: PublicIdentity = {
    id: agentIdentityId({
      installationId: ctx.installationId,
      ownerId: ctx.identity.public.id,
      ...keys,
    }),
    kind: 'agent',
    keyVersion: 1,
    ...keys,
  };
  return {
    enrollmentId: claimed.enrollmentId,
    agent,
    fingerprint: enrollmentFingerprint({
      installationId: ctx.installationId,
      owner: ctx.identity.public,
      agent,
    }),
    deadline: enrollmentDeadline(claimed.expiresAt, startedAt),
  };
}

/** Where a claimed enrollment is: approve once it is `cli-confirmed`. */
export async function enrollmentState(ctx: ClientContext, claim: Pick<Claim, 'enrollmentId'>) {
  return (
    await ctx.api.call(agentRoutes.enrollmentState, {
      params: { enrollmentId: claim.enrollmentId },
    })
  ).state;
}

/**
 * The fingerprints didn't match, or the person changed their mind. An
 * approval tried earlier with this claim may have left a live entry for
 * its agent in the record (a refusal a retry could pass); turned down, it
 * never will be made, so it is recorded as revoked (`forgetUnmade`), even
 * if the server already let the enrollment go.
 */
export async function rejectEnrollment(
  ctx: ClientContext,
  claim: Pick<Claim, 'enrollmentId' | 'agent'>,
  now: () => Date = () => new Date(),
): Promise<void> {
  try {
    await ctx.api.call(agentRoutes.rejectEnrollment, {
      params: { enrollmentId: claim.enrollmentId },
    });
  } finally {
    await forgetUnmade(ctx, claim.agent.id, now);
  }
}

/**
 * A folder or space an agent is to work in, inside a share this person
 * holds: the whole share when `folderId` is its root (or `null` for a
 * space share), else that folder. Publish only where the person can.
 * `shareId`, when given, is the share the folder must be in.
 */
export type AgentPick = {
  spaceId: SpaceId;
  folderId: FolderId | null;
  role: ShareRole;
  canPublish?: boolean;
  shareId?: ShareId;
};

/** A pick resolved against the share it is in, as this app opened the folder's name. */
type ResolvedPick = {
  spaceId: SpaceId;
  shareId: ShareId;
  folderId: FolderId | null;
  role: ShareRole;
  canPublish: boolean;
  currentKeyVersion: number;
};

/**
 * Step 5, once the person compared the fingerprints and pressed approve:
 * sign the enrollment, record the agent with its picks in a confirmed
 * contacts write, seal every key version of each picked share to it, and
 * send it all. `comparedFingerprint` is the one on screen while they
 * compared; a lapsed deadline, by this app's clock, refuses. Picks in the
 * owner region come afterwards (`pickInOwnerRegion`).
 *
 * A name another of this person's agents has is `duplicate` before
 * anything is written. If the server refuses the approval after the record
 * lists the agent, the agent is recorded as revoked, so the record never
 * keeps a live agent that doesn't exist.
 */
export async function approveEnrollment(
  ctx: ClientContext,
  {
    claim,
    comparedFingerprint,
    name,
    picks,
    now = () => new Date(),
  }: {
    claim: Claim;
    comparedFingerprint: string;
    name: string;
    picks: readonly AgentPick[];
    now?: () => Date;
  },
): Promise<IdentityId> {
  requirePerson(ctx);
  if (now().getTime() >= claim.deadline.getTime()) {
    throw new CryptoError('binding-mismatch', 'The enrollment has expired; start again');
  }
  // A refusal that ended this enrollment put its agent in `revokedAgents`;
  // approving it now would make an agent nothing is ever sealed to.
  if (
    ctx.contacts.book.payloads.shared.revokedAgents.some(
      (revoked) => revoked.agentId === claim.agent.id,
    )
  ) {
    throw new CryptoError('binding-mismatch', 'This enrollment was refused; start again');
  }
  // Approving the same enrollment again (a retry) isn't another agent.
  const other = (agentId: string) => agentId !== claim.agent.id;
  if (
    ctx.contacts.book.payloads.shared.agents.some(
      (agent) => other(agent.enrollment.agent.id) && agent.label.name === name,
    ) ||
    (await listAgents(ctx)).some(
      (agent) => other(agent.agentId) && agent.revokedAt === null && agent.name === name,
    )
  ) {
    throw new ApiError(409, 'duplicate', 'Another of your agents has that name');
  }
  const enrollment = enrollAgent({
    installationId: ctx.installationId,
    owner: ctx.identity,
    agent: claim.agent,
    comparedFingerprint,
  });
  const resolved = [];
  for (const pick of picks) resolved.push(await resolvePick(ctx, pick));
  const agent: OwnAgent = {
    enrollment,
    label: { name, enrolledAt: now().toISOString() },
    shares: resolved.map(sharedOf),
  };
  // The agent can read the shared payload, and the app knows what it may
  // seal to it, before any key is sealed (sections 9.2 and 9.4).
  await saveContacts(ctx, [{ kind: 'enroll', agent }], {
    holds: (payloads) => holdsShares(payloads, enrollment.agent.id, agent.shares),
  });
  try {
    const envelopes: FolderKeyEnvelope[] = [];
    for (const pick of resolved) envelopes.push(...(await sealPick(ctx, enrollment.agent, pick)));
    const { agentId } = await ctx.api.call(agentRoutes.approveEnrollment, {
      params: { enrollmentId: claim.enrollmentId },
      body: { enrollment, name, grants: resolved.map(grantOf), envelopes },
    });
    return agentId;
  } catch (error) {
    if (endsEnrollment(error)) await forgetUnmade(ctx, enrollment.agent.id, now);
    throw error;
  }
}

/**
 * Pick a folder, or the space, in the owner region of a space this person
 * owns for one of their agents (section 9.4): it becomes a share, with the
 * agent as its only member besides the owners. `preview` is the one the
 * person looked over (`previewShare`), as for any new share.
 */
export async function pickInOwnerRegion(
  ctx: ClientContext,
  {
    agentId,
    preview,
    role,
    canPublish = false,
  }: { agentId: IdentityId; preview: SharePreview; role: ShareRole; canPublish?: boolean },
): Promise<ShareId> {
  ownAgent(ctx, agentId);
  return shareFolder(ctx, { preview, people: [], agents: [{ agentId, role, canPublish }] });
}

/**
 * Grant one of this person's agents a pick inside a share, or change its
 * role there (section 9.4): its `shares` entry first, in a confirmed
 * contacts write, then every version of the share sealed to it again.
 */
export async function grantAgent(
  ctx: ClientContext,
  agentId: IdentityId,
  pick: AgentPick,
): Promise<void> {
  const agent = ownAgent(ctx, agentId);
  const resolved = await resolvePick(ctx, pick);
  const share = sharedOf(resolved);
  await saveContacts(ctx, [{ kind: 'agent-shares', agentId, set: [share], unset: [] }], {
    holds: (payloads) => holdsShares(payloads, agentId, [share]),
  });
  await ctx.api.call(agentRoutes.putAgentGrant, {
    params: { agentId, shareId: resolved.shareId },
    body: {
      folderId: resolved.folderId,
      role: resolved.role,
      canPublish: resolved.canPublish,
      envelopes: await sealPick(ctx, agent.enrollment.agent, resolved),
    },
  });
}

/**
 * Take a pick away from an agent (section 9.4). It keeps the keys it had
 * (A6); an owner of the share can rotate them (section 7.5).
 */
export async function removeAgentPick(
  ctx: ClientContext,
  agentId: IdentityId,
  share: { spaceId: SpaceId; shareId: ShareId },
): Promise<void> {
  ownAgent(ctx, agentId);
  await saveContacts(ctx, [{ kind: 'agent-shares', agentId, set: [], unset: [share] }], {
    holds: ({ shared }) =>
      !shared.agents.some(
        (agent) =>
          agent.enrollment.agent.id === agentId &&
          agent.shares.some((s) => s.spaceId === share.spaceId && s.shareId === share.shareId),
      ),
  });
  await ctx.api.call(agentRoutes.deleteAgentGrant, {
    params: { agentId, shareId: share.shareId },
  });
}

/**
 * At unlock (section 9.4): seal to each of this person's agents that isn't
 * revoked the key versions it lacks in the shares on its list, and in the
 * shares of the groups on its list, up to the highest that counts for this
 * app's writing, with draft keys only where the list says so. The server
 * says what is missing; `sealForAgent` seals only what the person's own
 * record allows. Answers how many envelopes went out. One agent the server
 * no longer knows doesn't stop the others.
 *
 * Agents the server revoked with every other credential of the account (a
 * password reset, an administrator, section 9.7) go into `revokedAgents`
 * first, in a confirmed write, so no app of this person's seals to them.
 */
export async function resealAgents(ctx: ClientContext): Promise<number> {
  requirePerson(ctx);
  await recordRevokedAgents(ctx);
  // A server from before agents in groups (Milestone 5) lists none.
  const groups = await listAgentGroups(ctx).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === 'not-found') return [];
    throw error;
  });
  // Each space's keys, worked out afresh once for all the agents.
  const writes: SpaceWrites = new Map();
  let sealed = 0;
  for (const agent of ctx.contacts.book.payloads.shared.agents) {
    sealed += await resealAgent(ctx, agent, groups, writes);
  }
  return sealed;
}

type SpaceWrites = Map<SpaceId, Awaited<ReturnType<typeof spaceKeys>>>;

// Seal one agent what it lacks, as `resealAgents` does for each.
async function resealAgent(
  ctx: ClientContext,
  agent: OwnAgent,
  groups: readonly AgentGroupListing[],
  writes: SpaceWrites,
): Promise<number> {
  const { shared } = ctx.contacts.book.payloads;
  const agentId = agent.enrollment.agent.id;
  if (shared.revokedAgents.some((revoked) => revoked.agentId === agentId)) return 0;
  let missing: MissingVersions[];
  try {
    ({ missing } = await ctx.api.call(agentRoutes.missingVersions, { params: { agentId } }));
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not-found') return 0;
    throw error;
  }
  for (const spaceId of new Set(missing.map((m) => m.spaceId))) {
    if (!writes.has(spaceId)) writes.set(spaceId, await spaceKeys(ctx, spaceId, { refresh: true }));
  }
  const envelopes = sealForAgent({
    person: ctx.identity,
    installationId: ctx.installationId,
    contacts: shared,
    agent,
    missing,
    groups: groups.filter((group) => group.agentId === agentId && group.confirmed),
    keyring: ctx.keyring,
    writes: (spaceId) => {
      const keys = writes.get(spaceId);
      if (!keys) throw new CryptoError('missing-key', `No keys worked out for ${spaceId}`);
      return keys.owners.writes;
    },
  });
  if (envelopes.length === 0) return 0;
  await ctx.api.call(agentRoutes.addAgentEnvelopes, { params: { agentId }, body: { envelopes } });
  return envelopes.length;
}

/** A group one of this person's agents is in, as the server lists it (section 9.4). */
export type AgentGroupListing = z.output<
  typeof agentRoutes.myAgentGroups.response
>['groups'][number];

/**
 * The groups this person's live agents are in, with the shares each has
 * and whether this person confirmed it. The server's list: only groups
 * this person's own record lists are ever sealed for.
 */
export async function listAgentGroups(ctx: ClientContext): Promise<AgentGroupListing[]> {
  requirePerson(ctx);
  return (await ctx.api.call(agentRoutes.myAgentGroups)).groups;
}

/**
 * Confirm a group an owner put one of this person's agents in (section
 * 9.4): the group into the agent's `groups` in a confirmed contacts write,
 * then the server's grants, then every version this app holds of the
 * group's shares sealed to it, as at unlock. With `drafts` false it gets
 * the published keys only, as a reader, whatever the group's access.
 */
export async function confirmAgentGroup(
  ctx: ClientContext,
  {
    agentId,
    spaceId,
    groupId,
    drafts = true,
  }: { agentId: IdentityId; spaceId: SpaceId; groupId: GroupId; drafts?: boolean },
): Promise<void> {
  ownAgent(ctx, agentId);
  const group = { spaceId, groupId, drafts };
  await saveContacts(ctx, [{ kind: 'agent-groups', agentId, set: [group], unset: [] }], {
    holds: ({ shared }) =>
      shared.agents.some(
        (agent) =>
          agent.enrollment.agent.id === agentId &&
          agent.groups?.some(
            (g) => g.spaceId === spaceId && g.groupId === groupId && g.drafts === drafts,
          ),
      ),
  });
  await ctx.api.call(agentRoutes.confirmAgentGroup, {
    params: { agentId, groupId },
    body: { drafts },
  });
  await resealAgent(ctx, ownAgent(ctx, agentId), await listAgentGroups(ctx), new Map());
}

/**
 * Take one of this person's agents out of a group, confirmed or not: out
 * of its `groups` in a confirmed write, then out of the group. It keeps
 * the keys it had (A6); the group's owners can rotate them (section 7.5).
 */
export async function leaveAgentGroup(
  ctx: ClientContext,
  { agentId, spaceId, groupId }: { agentId: IdentityId; spaceId: SpaceId; groupId: GroupId },
): Promise<void> {
  const agent = ownAgent(ctx, agentId);
  if (agent.groups?.some((g) => g.spaceId === spaceId && g.groupId === groupId)) {
    await saveContacts(
      ctx,
      [{ kind: 'agent-groups', agentId, set: [], unset: [{ spaceId, groupId }] }],
      {
        holds: ({ shared }) =>
          !shared.agents.some(
            (a) =>
              a.enrollment.agent.id === agentId &&
              a.groups?.some((g) => g.spaceId === spaceId && g.groupId === groupId),
          ),
      },
    );
  }
  await ctx.api.call(agentRoutes.leaveAgentGroup, { params: { agentId, groupId } });
}

// Agents on this person's record that the server lists as revoked but the
// record doesn't yet, added to `revokedAgents`.
async function recordRevokedAgents(ctx: ClientContext): Promise<void> {
  const { shared } = ctx.contacts.book.payloads;
  const recorded = new Set(shared.revokedAgents.map((entry) => entry.agentId));
  const onRecord = new Set(
    shared.agents.map((agent) => agent.enrollment.agent.id).filter((id) => !recorded.has(id)),
  );
  if (onRecord.size === 0) return;
  const changes: ContactsChange[] = (await listAgents(ctx)).flatMap((listed) =>
    listed.revokedAt !== null && onRecord.has(listed.agentId)
      ? [{ kind: 'revoke-agent', agentId: listed.agentId, revokedAt: listed.revokedAt }]
      : [],
  );
  if (changes.length === 0) return;
  await saveContacts(ctx, changes, {
    holds: (payloads) =>
      changes.every((change) =>
        payloads.shared.revokedAgents.some(
          (entry) => change.kind === 'revoke-agent' && entry.agentId === change.agentId,
        ),
      ),
  });
}

/**
 * Revoke one of this person's agents (section 9.7): into `revokedAgents`
 * in a confirmed write, so no app of theirs seals to it again, then its
 * token and grants end. It keeps the keys it already held (A6).
 */
export async function revokeAgent(
  ctx: ClientContext,
  agentId: IdentityId,
  now: () => Date = () => new Date(),
): Promise<void> {
  ownAgent(ctx, agentId);
  await recordRevoked(ctx, agentId, now().toISOString());
  await ctx.api.call(agentRoutes.revokeAgent, { params: { agentId } });
}

/**
 * Rename one of this person's agents in their contacts record, where agent
 * names are unique (section 8.2). A revoked agent keeps its name there, so
 * reusing that name for a new agent means renaming the revoked one first.
 * The server keeps the name it was approved with, which other people's
 * apps show as the server's.
 */
export async function renameAgent(
  ctx: ClientContext,
  agentId: IdentityId,
  name: string,
): Promise<void> {
  const agent = ownAgent(ctx, agentId);
  if (agent.label.name === name) return;
  if (ctx.contacts.book.payloads.shared.agents.some((other) => other.label.name === name)) {
    throw new ApiError(409, 'duplicate', 'Another of your agents has that name');
  }
  await saveContacts(ctx, [{ kind: 'rename-agent', agentId, name, replaced: agent.label.name }], {
    holds: ({ shared }) =>
      shared.agents.some((a) => a.enrollment.agent.id === agentId && a.label.name === name),
  });
}

// Refusals after which this enrollment can never be approved, and keys
// this app couldn't seal, so nothing was sent. Any other refusal (a sign-in
// to repeat, a limit, a pick that changed meanwhile) may pass on a retry of
// the same claim, and without an answer the approval may yet be made, so
// the entry stays live for either.
const endsEnrollment = (error: unknown): boolean =>
  error instanceof CryptoError ||
  (error instanceof ApiError &&
    ['enrollment-state', 'not-found', 'binding-mismatch', 'bad-signature', 'duplicate'].includes(
      error.code,
    ));

/**
 * Once an enrollment can't be approved any more (a refusal that ended it,
 * or the person turning it down): an agent the record lists live but the
 * server doesn't know was never made, so it goes into `revokedAgents`
 * rather than stay a live entry that holds its name and is sealed to. One
 * the server knows was approved before (a retry) and stays, as does
 * anything the record doesn't list live. Best effort: what ended the
 * enrollment is what the caller reports.
 */
export async function forgetUnmade(
  ctx: ClientContext,
  agentId: IdentityId,
  now: () => Date = () => new Date(),
): Promise<void> {
  const { shared } = ctx.contacts.book.payloads;
  if (
    !shared.agents.some((agent) => agent.enrollment.agent.id === agentId) ||
    shared.revokedAgents.some((revoked) => revoked.agentId === agentId)
  ) {
    return;
  }
  try {
    if ((await listAgents(ctx)).some((agent) => agent.agentId === agentId)) return;
    await recordRevoked(ctx, agentId, now().toISOString());
  } catch {
    // The entry stays; resealing skips an agent the server doesn't know.
  }
}

// Put `agentId` in `revokedAgents`, in a confirmed write.
function recordRevoked(ctx: ClientContext, agentId: IdentityId, revokedAt: string) {
  return saveContacts(ctx, [{ kind: 'revoke-agent', agentId, revokedAt }], {
    holds: ({ shared }) => shared.revokedAgents.some((r) => r.agentId === agentId),
  });
}

/** This person's agents as the server lists them, revoked ones too. */
export async function listAgents(ctx: ClientContext) {
  requirePerson(ctx);
  return (await ctx.api.call(agentRoutes.myAgents)).agents;
}

// Agents act; only their person manages them.
function requirePerson(ctx: ClientContext) {
  if (ctx.agent) throw new CryptoError('malformed', 'Only a person manages agents');
}

// One of this person's agents, from their own contacts record.
function ownAgent(ctx: ClientContext, agentId: IdentityId): OwnAgent {
  requirePerson(ctx);
  const agent = ctx.contacts.book.payloads.shared.agents.find(
    (entry) => entry.enrollment.agent.id === agentId,
  );
  if (!agent) throw new CryptoError('wrong-recipient', 'This person enrolled no such agent');
  return agent;
}

/**
 * The share a pick is in, from the region of the picked folder's (or the
 * space's) own name record as this app opens it, which the server's tree
 * must agree with (section 6.1). A pick in the owner region is
 * `region-mismatch`: it becomes a share first (`pickInOwnerRegion`). A
 * folder outside the pick's own `shareId` is `binding-mismatch`, so a
 * server can't move a change of access into another share.
 */
async function resolvePick(ctx: ClientContext, pick: AgentPick): Promise<ResolvedPick> {
  const { spaceId, folderId } = pick;
  const target = await treeTarget(ctx, spaceId, folderId);
  if (!target.name) throw new ApiError(404, 'not-found', 'There is no such folder');
  const name = await openName(
    ctx,
    folderId === null
      ? { spaceId, subjectKind: 'space', subjectId: spaceId }
      : { spaceId, subjectKind: 'folder', subjectId: folderId },
    target.name,
  );
  const { share } = target;
  requireRegion({
    write: name.region,
    tree: share ? { kind: 'share', spaceId, shareId: share.shareId } : OWNER_REGION,
  });
  if (!share) {
    throw new CryptoError('region-mismatch', 'A pick in the owner region must become a share');
  }
  if (pick.shareId !== undefined && pick.shareId !== share.shareId) {
    throw new CryptoError('binding-mismatch', 'The folder is in another share than the pick');
  }
  return {
    spaceId,
    shareId: share.shareId,
    folderId: folderId === share.rootId ? null : folderId,
    role: pick.role,
    canPublish: pick.role === 'editor' && (pick.canPublish ?? false),
    currentKeyVersion: share.currentKeyVersion,
  };
}

const sharedOf = (pick: ResolvedPick): AgentShare => ({
  spaceId: pick.spaceId,
  shareId: pick.shareId,
  drafts: pick.role === 'editor',
});

const grantOf = (pick: ResolvedPick) => ({
  shareId: pick.shareId,
  folderId: pick.folderId,
  role: pick.role,
  canPublish: pick.canPublish,
});

// Whether the record lists `agentId` with each of `shares`, drafts and all.
function holdsShares(
  { shared }: ContactsPayloads,
  agentId: string,
  shares: readonly AgentShare[],
): boolean {
  const agent = shared.agents.find((entry) => entry.enrollment.agent.id === agentId);
  return (
    !!agent &&
    shares.every((share) =>
      agent.shares.some(
        (held) =>
          held.spaceId === share.spaceId &&
          held.shareId === share.shareId &&
          held.drafts === share.drafts,
      ),
    )
  );
}

/**
 * Every version of a picked share this app can pass on, sealed to the
 * agent: both keys for an editor pick, the published key otherwise. The
 * current version must count for this app's writing (section 9.4).
 */
async function sealPick(
  ctx: ClientContext,
  agent: PublicIdentity,
  pick: ResolvedPick,
): Promise<FolderKeyEnvelope[]> {
  const keys = await spaceKeys(ctx, pick.spaceId);
  return versionsToGive(ctx, keys, {
    shareId: pick.shareId,
    currentKeyVersion: pick.currentKeyVersion,
  }).map((held) => {
    if (pick.role === 'editor' && !held.draftKey) {
      throw new CryptoError('missing-key', `No draft key for version ${held.keyVersion}`);
    }
    return sealFolderKeys({
      sealer: ctx.identity,
      installationId: ctx.installationId,
      spaceId: pick.spaceId,
      shareId: pick.shareId,
      keyVersion: held.keyVersion,
      recipient: agent,
      keys: {
        draftKey: pick.role === 'editor' ? held.draftKey : null,
        publishedKey: held.publishedKey,
      },
    });
  });
}

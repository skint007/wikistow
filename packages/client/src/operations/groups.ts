// Groups (protocol sections 7.8 and 7.9): the owner actions on a space's
// groups, and each person's effective access with where it comes from.
// A group holds no keys. Every change that gives or takes access is worked
// out as a `GroupChange` for the owner to confirm, then sent in one request
// by `applyGroupChange`: envelopes for people whose keys fall short of
// their new access, and a rotation of each share where someone's keys
// exceed it, built as sharing with or removing them one by one would be.
import {
  GroupId as GroupIdSchema,
  groupRoutes,
  type GroupId,
  type IdentityId,
  type ShareId,
  type SpaceId,
} from '@wikistow/contracts';
import type { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { isAgentId } from '../identity.ts';
import { MetadataRevisionId, newId } from '../ids.ts';
import { newFolderMetadata, reviseMetadata, sealMetadataV2 } from '../metadata.ts';
import type { DirectoryEntry, Lookup } from '../trust.ts';
import { forgetSpaces, pinAuthors } from './keys.ts';
import { openServedMetadata, treeTarget, type LoadedMetadata } from './records.ts';
import { saveContacts, type ClientContext } from './session.ts';
import {
  listShares,
  ownerKeys,
  planShareRotation,
  sealPlanned,
  sealVersion,
  versionsToGive,
  type PlannedRotation,
  type ShareRole,
} from './sharing.ts';

/** Access in a share: a role, and for an editor, whether they publish. */
export type Access = { role: ShareRole; canPublish: boolean };

/** Reader, editor, editor with publish, in that order; nothing ranks lowest. */
const rank = (access: Access | null) =>
  access === null ? 0 : access.role === 'reader' ? 1 : access.canPublish ? 3 : 2;

/** The highest of some access, as a plain `Access`, or null for none. */
export function highestAccess(all: readonly (Access | null)[]): Access | null {
  const best = all.reduce<Access | null>(
    (top, access) => (rank(access) > rank(top) ? access : top),
    null,
  );
  return best && { role: best.role, canPublish: best.canPublish };
}

/** One share where someone waits for keys, as the server lists it (section 7.9). */
export type WaitingEntry = z.output<typeof groupRoutes.waiting.response>['waiting'][number];

/** A group as its space's owners see it, its name decrypted. */
export type Group = {
  groupId: GroupId;
  /** Null when this app can't open it. */
  name: LoadedMetadata | null;
  /** Its people at their current keys, as the directory names them. */
  members: DirectoryEntry[];
  /** Its agents, each for its person, and whether that person confirmed it (section 9.4). */
  agents: { agentId: IdentityId; confirmed: boolean }[];
  shares: ({ shareId: ShareId } & Access)[];
};

/** An agent an owner sees in a space's groups, or may add: its person, and the server's name. */
export type GroupAgent = { agentId: IdentityId; personId: IdentityId; name: string };

/**
 * A space's groups, shares and direct grants as its owner's app loads them,
 * which every plan here works from. `waiting` is the server's list of who
 * waits for keys here (section 7.9); it decides nothing this app seals.
 */
export type SpaceGroups = {
  spaceId: SpaceId;
  groups: Group[];
  direct: ({ shareId: ShareId; identityId: IdentityId } & Access)[];
  shares: Awaited<ReturnType<typeof listShares>>;
  /** The live agents of the space's owners and of the people in its groups. */
  agents: GroupAgent[];
  waiting: WaitingEntry[];
  /** The space's permission version, which every group change names. */
  permissionVersion: number;
};

/**
 * Load a space's groups, for an owner: each name opened from the owner
 * region (a name the server serves through a share's wrap doesn't open),
 * with the shares, direct grants and who waits.
 */
export async function loadGroups(ctx: ClientContext, spaceId: SpaceId): Promise<SpaceGroups> {
  const keys = await ownerKeys(ctx, spaceId);
  const [listed, shares, { waiting }] = await Promise.all([
    ctx.api.call(groupRoutes.listGroups, { params: { spaceId } }),
    listShares(ctx, spaceId),
    ctx.api.call(groupRoutes.waiting),
  ]);
  await pinAuthors(
    ctx,
    listed.groups.flatMap((group) => (group.name ? [group.name.metadata.record] : [])),
  );
  const groups = listed.groups.map(({ groupId, name, members, agents, shares: held }) => {
    let opened: LoadedMetadata | null = null;
    try {
      opened =
        name &&
        openServedMetadata(ctx, keys, name, {
          installationId: ctx.installationId,
          spaceId,
          subjectKind: 'group',
          subjectId: groupId,
          metadataRevisionId: name.metadata.record.metadataRevisionId,
        });
      if (opened?.region.kind !== 'owner') opened = null;
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
    }
    return { groupId, name: opened, members, agents, shares: held };
  });
  return {
    spaceId,
    groups,
    direct: listed.direct,
    shares,
    agents: listed.agents,
    waiting: waiting.filter((w) => w.spaceId === spaceId),
    permissionVersion: listed.permissionVersion,
  };
}

/** Where some of a person's access in a share comes from. */
export type AccessSource =
  | ({ kind: 'direct' } & Access)
  | ({ kind: 'group'; groupId: GroupId } & Access);

/** A person's effective access in a share, and where it comes from. */
export type PersonAccess = {
  identityId: IdentityId;
  /** The highest of `sources`. */
  access: Access;
  /** Their direct grant first, if any, then each group, in the order listed. */
  sources: AccessSource[];
  /** The keys they hold there, from their member row, or null for none. */
  holds: { role: ShareRole; keyVersion: number } | null;
  /** Whether the server lists them as waiting for keys there (section 7.9). */
  waiting: boolean;
};

/** Who has a share, directly or through groups, for the access list. */
export type ShareAccess = {
  shareId: ShareId;
  groups: { group: Group; access: Access }[];
  people: PersonAccess[];
};

// Where each person's access in a share comes from. Agents in groups are
// left to their person (section 9.4), as the server leaves them.
function sourcesIn(state: SpaceGroups, shareId: ShareId) {
  const out = new Map<string, { identityId: IdentityId; sources: AccessSource[] }>();
  const add = (identityId: IdentityId, source: AccessSource) => {
    const entry = out.get(identityId) ?? { identityId, sources: [] };
    entry.sources.push(source);
    out.set(identityId, entry);
  };
  for (const { shareId: id, identityId, role, canPublish } of state.direct) {
    if (id === shareId) add(identityId, { kind: 'direct', role, canPublish });
  }
  for (const group of state.groups) {
    const held = group.shares.find((s) => s.shareId === shareId);
    if (!held) continue;
    for (const { identity } of group.members) {
      if (isAgentId(identity.id)) continue;
      add(identity.id, {
        kind: 'group',
        groupId: group.groupId,
        role: held.role,
        canPublish: held.canPublish,
      });
    }
  }
  return out;
}

/** A person's effective access in a share, or null for none. */
export const accessOf = (state: SpaceGroups, shareId: ShareId, identityId: string) =>
  highestAccess(sourcesIn(state, shareId).get(identityId)?.sources ?? []);

/**
 * Everyone with access to a share, directly or through groups, with their
 * effective access and its sources, and the groups that have it. People
 * the share lists only through agents, and owners, aren't here.
 */
export function shareAccess(state: SpaceGroups, shareId: ShareId): ShareAccess {
  const share = requireListed(state, shareId);
  const people = [...sourcesIn(state, shareId).values()].flatMap(({ identityId, sources }) => {
    const access = highestAccess(sources);
    if (!access) return [];
    const row = share.members.find((m) => m.identityId === identityId);
    return [
      {
        identityId,
        access,
        sources,
        holds: row ? { role: row.role, keyVersion: row.keyVersion } : null,
        waiting: state.waiting.some(
          (w) => w.shareId === shareId && w.person.identity.id === identityId,
        ),
      },
    ];
  });
  const groups = state.groups.flatMap((group) => {
    const held = group.shares.find((s) => s.shareId === shareId);
    return held ? [{ group, access: { role: held.role, canPublish: held.canPublish } }] : [];
  });
  return { shareId, groups, people };
}

function requireListed(state: SpaceGroups, shareId: ShareId) {
  const share = state.shares.find((s) => s.shareId === shareId);
  if (!share) throw new CryptoError('missing-key', `The server lists no share ${shareId}`);
  return share;
}

function requireGroup(state: SpaceGroups, groupId: GroupId) {
  const group = state.groups.find((g) => g.groupId === groupId);
  if (!group) throw new ApiError(404, 'not-found', 'There is no such group');
  return group;
}

/**
 * Make a group named `name` in a space, with no members or shares. Its name
 * is sealed to the space's owners (section 7.8). Returns its ID.
 */
export async function createGroup(
  ctx: ClientContext,
  { spaceId, name }: { spaceId: SpaceId; name: string },
): Promise<GroupId> {
  const keys = await ownerKeys(ctx, spaceId);
  const groupId = newId(GroupIdSchema);
  const { metadata, envelopes } = sealMetadataV2({
    author: ctx.identity,
    target: {
      installationId: ctx.installationId,
      spaceId,
      subjectKind: 'group',
      subjectId: groupId,
      metadataRevisionId: newId(MetadataRevisionId),
      basedOn: null,
    },
    metadata: newFolderMetadata(name),
    recipients: keys.owners.sealingOwners(),
  });
  await ctx.api.call(groupRoutes.createGroup, {
    params: { spaceId },
    body: { groupId, metadata, envelopes },
  });
  return groupId;
}

/**
 * Rename a group, as a new version of the name the owner was looking at
 * (`current`). If someone renamed it since, the server answers `stale-head`.
 */
export async function renameGroup(
  ctx: ClientContext,
  {
    spaceId,
    groupId,
    current,
    name,
  }: { spaceId: SpaceId; groupId: GroupId; current: LoadedMetadata; name: string },
): Promise<LoadedMetadata> {
  const keys = await ownerKeys(ctx, spaceId);
  const next = reviseMetadata(current.opened, { name });
  const metadataRevisionId = newId(MetadataRevisionId);
  const { metadata, envelopes } = sealMetadataV2({
    author: ctx.identity,
    target: {
      installationId: ctx.installationId,
      spaceId,
      subjectKind: 'group',
      subjectId: groupId,
      metadataRevisionId,
      basedOn: current.head,
    },
    metadata: next,
    recipients: keys.owners.sealingOwners(),
  });
  await ctx.api.call(groupRoutes.renameGroup, {
    params: { groupId },
    body: { metadata, envelopes },
  });
  return {
    head: metadataRevisionId,
    opened: { kind: 'current', metadata: next },
    region: current.region,
  };
}

/** What a group change does, as its request names it. */
export type GroupAction =
  | { kind: 'delete-group'; groupId: GroupId }
  | { kind: 'add-member'; groupId: GroupId; person: Lookup }
  | { kind: 'add-agent'; groupId: GroupId; agentId: IdentityId }
  | { kind: 'remove-member'; groupId: GroupId; identityId: IdentityId }
  | { kind: 'set-share-group'; shareId: ShareId; groupId: GroupId; access: Access }
  | { kind: 'remove-share-group'; shareId: ShareId; groupId: GroupId }
  | { kind: 'remove-direct'; shareId: ShareId; identityId: IdentityId }
  | { kind: 'remove-everywhere'; identityId: IdentityId }
  | { kind: 'give-access'; person: Lookup };

/**
 * A change to who has access, worked out for the owner to confirm, then
 * sent by `applyGroupChange`. If anything changed meanwhile the server
 * answers `stale-head`: plan again and ask the owner again.
 */
export type GroupChange = {
  spaceId: SpaceId;
  action: GroupAction;
  /** One rotation per share where someone's keys exceed their access after the change. */
  rotations: PlannedRotation[];
  /** People sealed every version of these shares, by role, where their keys fall short. */
  seals: { person: Lookup; shares: { shareId: ShareId; role: ShareRole }[] }[];
  /** People the change gives access who will wait instead: their key changed (section 8.4). */
  waits: { person: DirectoryEntry; shareIds: ShareId[] }[];
  /** The space as it will be, for showing what each person keeps (`shareAccess`). */
  after: SpaceGroups;
  /** The permission version the request names: the space's, or the share root's. */
  permissionVersion: number;
};

// The space as it will be after a change: these edit a loaded state.
const editGroup = (state: SpaceGroups, groupId: GroupId, edit: (group: Group) => Group | null) => ({
  ...state,
  groups: state.groups.flatMap((group) => {
    if (group.groupId !== groupId) return [group];
    const edited = edit(group);
    return edited ? [edited] : [];
  }),
});

const withGroupShare = (
  state: SpaceGroups,
  groupId: GroupId,
  shareId: ShareId,
  access: Access | null,
) =>
  editGroup(state, groupId, (group) => ({
    ...group,
    shares: [
      ...group.shares.filter((s) => s.shareId !== shareId),
      ...(access ? [{ shareId, ...access }] : []),
    ],
  }));

// Someone out of a group: a person's agents leave with them.
const withoutMember = (state: SpaceGroups, groupId: GroupId, identityId: string) =>
  editGroup(state, groupId, (group) => ({
    ...group,
    members: group.members.filter((m) => m.identity.id !== identityId),
    agents: group.agents.filter(
      ({ agentId }) =>
        agentId !== identityId &&
        state.agents.find((a) => a.agentId === agentId)?.personId !== identityId,
    ),
  }));

/**
 * The agents reaching a share, by a pick or a confirmed group (section
 * 9.4), as the server works it out for its coverage check.
 */
const agentsIn = (state: SpaceGroups, shareId: ShareId) =>
  new Set<string>([
    ...requireListed(state, shareId).agents.map((pick) => pick.agentId),
    ...state.groups.flatMap((group) =>
      group.shares.some((s) => s.shareId === shareId)
        ? group.agents.filter((a) => a.confirmed).map((a) => a.agentId)
        : [],
    ),
  ]);

const withoutDirect = (state: SpaceGroups, identityId: string, shareId?: ShareId) => ({
  ...state,
  direct: state.direct.filter(
    (d) => d.identityId !== identityId || (shareId !== undefined && d.shareId !== shareId),
  ),
});

/**
 * A rotation of each of `shareIds` where someone the share lists holds
 * keys beyond their access in `after`: leaving them out where nothing is
 * left, demoting them where they keep reading (section 7.9). Also where a
 * confirmed agent reaches the share `before` but not `after`: a rotation
 * leaves it out by itself, as only its person seals to it.
 */
async function rotationsFor(
  ctx: ClientContext,
  before: SpaceGroups,
  after: SpaceGroups,
  shareIds: readonly ShareId[],
): Promise<PlannedRotation[]> {
  const keys = await ownerKeys(ctx, after.spaceId);
  const plans: PlannedRotation[] = [];
  for (const shareId of shareIds) {
    const leaveOut: IdentityId[] = [];
    const demote: IdentityId[] = [];
    for (const row of requireListed(after, shareId).members) {
      const access = accessOf(after, shareId, row.identityId);
      if (access === null) leaveOut.push(row.identityId);
      else if (row.role === 'editor' && access.role === 'reader') demote.push(row.identityId);
    }
    const stays = agentsIn(after, shareId);
    const agentLeaves = [...agentsIn(before, shareId)].some((id) => !stays.has(id));
    if (leaveOut.length === 0 && demote.length === 0 && !agentLeaves) continue;
    plans.push(
      await planShareRotation(ctx, { spaceId: after.spaceId, shareId, leaveOut, demote, keys }),
    );
  }
  return plans;
}

/**
 * For each person, the shares of `shareIds` where the keys they hold at
 * their current key fall short of their access in `after`, each with the
 * role to seal. Someone whose key changed, unconfirmed, waits instead.
 */
function sealsFor(
  ctx: ClientContext,
  after: SpaceGroups,
  shareIds: readonly ShareId[],
  people: readonly Lookup[],
): Pick<GroupChange, 'seals' | 'waits'> {
  const seals: GroupChange['seals'] = [];
  const waits: GroupChange['waits'] = [];
  for (const person of people) {
    const { identity } = person;
    const shares = shareIds.flatMap((shareId) => {
      const access = accessOf(after, shareId, identity.id);
      if (!access) return [];
      const row = requireListed(after, shareId).members.find((m) => m.identityId === identity.id);
      const holds =
        row?.keyVersion === identity.keyVersion &&
        (row.role === 'editor' || access.role === 'reader');
      return holds ? [] : [{ shareId, role: access.role }];
    });
    if (shares.length === 0) continue;
    const check = ctx.trust.check(identity, person.foundBy ?? person.email);
    if (check.kind === 'changed' || check.kind === 'removed') {
      waits.push({ person: entryOf(person), shareIds: shares.map((s) => s.shareId) });
    } else {
      seals.push({ person, shares });
    }
  }
  return { seals, waits };
}

// A change that only takes access away, at the space's permission version.
const takingAway = async (
  ctx: ClientContext,
  state: SpaceGroups,
  action: GroupAction,
  after: SpaceGroups,
  shareIds: readonly ShareId[],
  permissionVersion = state.permissionVersion,
): Promise<GroupChange> => ({
  spaceId: state.spaceId,
  action,
  rotations: await rotationsFor(ctx, state, after, shareIds),
  seals: [],
  waits: [],
  after,
  permissionVersion,
});

const rootVersion = async (ctx: ClientContext, state: SpaceGroups, shareId: ShareId) =>
  (await treeTarget(ctx, state.spaceId, requireListed(state, shareId).rootId)).permissionVersion;

const asLookup = (person: DirectoryEntry): Lookup => ({ ...person, foundBy: null });
const entryOf = ({ identity, name, email }: Lookup): DirectoryEntry => ({ identity, name, email });

/**
 * Delete a group: out of every share it has, rotating each where a member's
 * keys exceed what they keep without it (section 7.9).
 */
export async function planDeleteGroup(
  ctx: ClientContext,
  { spaceId, groupId }: { spaceId: SpaceId; groupId: GroupId },
): Promise<GroupChange> {
  const state = await loadGroups(ctx, spaceId);
  const group = requireGroup(state, groupId);
  const after = editGroup(state, groupId, () => null);
  return takingAway(
    ctx,
    state,
    { kind: 'delete-group', groupId },
    after,
    group.shares.map((s) => s.shareId),
  );
}

/**
 * Add `person`, found by exact email (`findPerson`), to a group: every
 * version of each of its shares where the keys they hold fall short of
 * their new access, in the same request (section 7.8). Their key must be
 * one this app may seal to, or `identity-key-changed`.
 */
export async function planAddMember(
  ctx: ClientContext,
  { spaceId, groupId, person }: { spaceId: SpaceId; groupId: GroupId; person: Lookup },
): Promise<GroupChange> {
  const state = await loadGroups(ctx, spaceId);
  const group = requireGroup(state, groupId);
  if (group.members.some((m) => m.identity.id === person.identity.id)) {
    throw new ApiError(409, 'duplicate', 'Already in the group');
  }
  const after = editGroup(state, groupId, (g) => ({
    ...g,
    members: [...g.members, entryOf(person)],
  }));
  const shareIds = group.shares.map((s) => s.shareId);
  const { seals, waits } = sealsFor(ctx, after, shareIds, [person]);
  requireNoneWaiting(waits);
  return {
    spaceId,
    action: { kind: 'add-member', groupId, person },
    rotations: [],
    seals,
    waits,
    after,
    permissionVersion: state.permissionVersion,
  };
}

/**
 * Put an agent in a group, for its person, who is in the group or owns the
 * space (section 7.8). Nothing is sealed: it gets nothing until its person
 * confirms, on their Agents page, since only they seal to it (section
 * 9.4). An owner adding their own agent confirms next (`confirmAgentGroup`).
 */
export async function planAddAgent(
  ctx: ClientContext,
  { spaceId, groupId, agentId }: { spaceId: SpaceId; groupId: GroupId; agentId: IdentityId },
): Promise<GroupChange> {
  const state = await loadGroups(ctx, spaceId);
  const group = requireGroup(state, groupId);
  if (group.agents.some((a) => a.agentId === agentId)) {
    throw new ApiError(409, 'duplicate', 'Already in the group');
  }
  return {
    spaceId,
    action: { kind: 'add-agent', groupId, agentId },
    rotations: [],
    seals: [],
    waits: [],
    after: editGroup(state, groupId, (g) => ({
      ...g,
      agents: [...g.agents, { agentId, confirmed: false }],
    })),
    permissionVersion: state.permissionVersion,
  };
}

/**
 * Take someone out of a group: for each of its shares, a rotation where
 * their keys exceed what they keep through a direct grant or another
 * group, leaving them out or demoting them (section 7.9). A person's
 * agents leave with them. For an agent, a rotation of each share it no
 * longer reaches once its person confirmed the group, as for a person.
 */
export async function planRemoveMember(
  ctx: ClientContext,
  { spaceId, groupId, identityId }: { spaceId: SpaceId; groupId: GroupId; identityId: IdentityId },
): Promise<GroupChange> {
  const state = await loadGroups(ctx, spaceId);
  const group = requireGroup(state, groupId);
  if (
    !group.members.some((m) => m.identity.id === identityId) &&
    !group.agents.some((a) => a.agentId === identityId)
  ) {
    throw new ApiError(404, 'not-found', 'Not in the group');
  }
  return takingAway(
    ctx,
    state,
    { kind: 'remove-member', groupId, identityId },
    withoutMember(state, groupId, identityId),
    group.shares.map((s) => s.shareId),
  );
}

/**
 * Share a share with a group at `access`, or change its access there
 * (section 7.8). Sharing it, or raising it to editor, seals every version
 * to each member whose keys fall short; lowering it rotates the share,
 * leaving out or demoting the members whose keys exceed their access.
 * Publish rights alone do neither, and nothing but sharing or raising
 * seals to someone already waiting. A member whose key changed waits. To share a folder that isn't a share
 * yet with a group, make the share with it (`shareFolder`'s `groups`).
 */
export async function planShareGroup(
  ctx: ClientContext,
  {
    spaceId,
    shareId,
    groupId,
    access,
  }: { spaceId: SpaceId; shareId: ShareId; groupId: GroupId; access: Access },
): Promise<GroupChange> {
  const state = await loadGroups(ctx, spaceId);
  const group = requireGroup(state, groupId);
  const granted = { role: access.role, canPublish: access.role === 'editor' && access.canPublish };
  const after = withGroupShare(state, groupId, shareId, granted);
  const action = { kind: 'set-share-group', shareId, groupId, access: granted } as const;
  const change = await takingAway(
    ctx,
    state,
    action,
    after,
    [shareId],
    await rootVersion(ctx, state, shareId),
  );
  // Only sharing it, or making the group editors, seals; publish rights or
  // lowering it seal nothing, so anyone short of keys waits, as before.
  const before = group.shares.find((s) => s.shareId === shareId);
  if (before && !(before.role === 'reader' && granted.role === 'editor')) return change;
  return { ...change, ...sealsFor(ctx, after, [shareId], group.members.map(asLookup)) };
}

/**
 * Take a group out of a share: one rotation leaving out the members left
 * with no access, and demoting those left as readers, or none.
 */
export async function planRemoveShareGroup(
  ctx: ClientContext,
  { spaceId, shareId, groupId }: { spaceId: SpaceId; shareId: ShareId; groupId: GroupId },
): Promise<GroupChange> {
  const state = await loadGroups(ctx, spaceId);
  if (!requireGroup(state, groupId).shares.some((s) => s.shareId === shareId)) {
    throw new ApiError(404, 'not-found', 'The group has no such share');
  }
  return takingAway(
    ctx,
    state,
    { kind: 'remove-share-group', shareId, groupId },
    withGroupShare(state, groupId, shareId, null),
    [shareId],
    await rootVersion(ctx, state, shareId),
  );
}

/**
 * Drop someone's direct grant in a share, keeping what their groups give
 * them: a rotation only where their keys exceed that, demoting them if
 * they keep reading. With no group access left, it removes them.
 */
export async function planRemoveDirectGrant(
  ctx: ClientContext,
  { spaceId, shareId, identityId }: { spaceId: SpaceId; shareId: ShareId; identityId: IdentityId },
): Promise<GroupChange> {
  const state = await loadGroups(ctx, spaceId);
  if (!state.direct.some((d) => d.shareId === shareId && d.identityId === identityId)) {
    throw new ApiError(404, 'not-found', 'No direct grant there');
  }
  return takingAway(
    ctx,
    state,
    { kind: 'remove-direct', shareId, identityId },
    withoutDirect(state, identityId, shareId),
    [shareId],
    await rootVersion(ctx, state, shareId),
  );
}

/**
 * "Remove from every folder in this space" (section 7.5): out of every
 * group in the space and every direct grant, with a rotation leaving them
 * out of each share where they hold keys, in one request. Someone in
 * groups but holding no keys anywhere leaves with no rotation at all. An
 * owner is removed as an owner instead (`planOwnerRemoval`).
 */
export async function planRemovalEverywhere(
  ctx: ClientContext,
  { spaceId, identityId }: { spaceId: SpaceId; identityId: IdentityId },
): Promise<GroupChange> {
  const state = await loadGroups(ctx, spaceId);
  let after = withoutDirect(state, identityId);
  for (const group of state.groups) after = withoutMember(after, group.groupId, identityId);
  return takingAway(
    ctx,
    state,
    { kind: 'remove-everywhere', identityId },
    after,
    state.shares.map((s) => s.shareId),
  );
}

/**
 * Give access to someone waiting in a space (section 7.9): every version
 * of each share where their access is more than the keys they hold at
 * their current key, by role. After a key change this seals everything
 * they reach, directly and through groups, to the new key, replacing
 * Share again. `person` is as the waiting list gives them; their key must
 * be confirmed first (`identity-key-changed` otherwise).
 */
export async function planGiveAccess(
  ctx: ClientContext,
  { spaceId, person }: { spaceId: SpaceId; person: DirectoryEntry },
): Promise<GroupChange> {
  const state = await loadGroups(ctx, spaceId);
  const lookup = asLookup(person);
  const { seals, waits } = sealsFor(
    ctx,
    state,
    state.shares.map((s) => s.shareId),
    [lookup],
  );
  requireNoneWaiting(waits);
  return {
    spaceId,
    action: { kind: 'give-access', person: lookup },
    rotations: [],
    seals,
    waits,
    after: state,
    permissionVersion: state.permissionVersion,
  };
}

function requireNoneWaiting(waits: GroupChange['waits']) {
  const [first] = waits;
  if (first) {
    throw new CryptoError(
      'identity-key-changed',
      `Key for ${first.person.identity.id} changed since it was pinned`,
    );
  }
}

/**
 * Send a group change the owner confirmed: the envelopes and rotations it
 * planned, in one request. Each person sealed to is pinned first (section
 * 8.3), all or nothing, and each version is sealed from keys this app may
 * pass on (`versionsToGive`). A rotation's new keys are wiped once sealed.
 */
export async function applyGroupChange(ctx: ClientContext, change: GroupChange): Promise<void> {
  const { spaceId, action, permissionVersion } = change;
  const keys = await ownerKeys(ctx, spaceId);
  // The person an addition or Give access names comes after those sealed to.
  const named =
    action.kind === 'add-member' || action.kind === 'give-access' ? [action.person] : [];
  const pinned = ctx.trust.recipients([...change.seals.map((s) => s.person), ...named]);
  const subject = pinned[change.seals.length];
  await saveContacts(ctx, [], {
    sealTo: [
      ...pinned,
      ...change.rotations.flatMap(({ plan }) => plan.remaining.map((r) => r.identity)),
    ],
  });
  const shares = await listShares(ctx, spaceId);
  const envelopes = change.seals.flatMap(({ shares: given }, i) => {
    const identity = pinned[i];
    if (!identity) throw new CryptoError('malformed', 'Nobody to seal to');
    return given.flatMap(({ shareId, role }) => {
      const share = shares.find((s) => s.shareId === shareId);
      if (!share) throw new CryptoError('missing-key', `The server lists no share ${shareId}`);
      return versionsToGive(ctx, keys, share).flatMap((held) =>
        sealVersion(ctx, spaceId, shareId, held.keyVersion, held, [{ identity, role }]),
      );
    });
  });
  const sealed = change.rotations.map(({ plan }) => ({
    shareId: plan.shareId,
    rotation: sealPlanned(ctx, plan),
  }));
  const rotations = sealed.map(({ shareId, rotation }) => ({ shareId, ...rotation }));
  // A one-share request carries its rotation, if any, on its own.
  const rotation = sealed[0]?.rotation ?? null;
  switch (action.kind) {
    case 'delete-group':
      await ctx.api.call(groupRoutes.deleteGroup, {
        params: { groupId: action.groupId },
        body: { rotations, permissionVersion },
      });
      break;
    case 'add-member':
      if (!subject) throw new CryptoError('malformed', 'Nobody to add');
      await ctx.api.call(groupRoutes.addGroupMember, {
        params: { groupId: action.groupId },
        body: {
          identityId: subject.id,
          keyVersion: subject.keyVersion,
          envelopes,
          permissionVersion,
        },
      });
      break;
    case 'add-agent':
      await ctx.api.call(groupRoutes.addGroupAgent, {
        params: { groupId: action.groupId },
        body: { agentId: action.agentId, permissionVersion },
      });
      break;
    case 'remove-member':
      await ctx.api.call(groupRoutes.removeGroupMember, {
        params: { groupId: action.groupId, identityId: action.identityId },
        body: { rotations, permissionVersion },
      });
      break;
    case 'set-share-group':
      await ctx.api.call(groupRoutes.setShareGroup, {
        params: { shareId: action.shareId, groupId: action.groupId },
        body: { access: action.access, envelopes, rotation, permissionVersion },
      });
      break;
    case 'remove-share-group':
      await ctx.api.call(groupRoutes.removeShareGroup, {
        params: { shareId: action.shareId, groupId: action.groupId },
        body: { rotation, permissionVersion },
      });
      break;
    case 'remove-direct':
      await ctx.api.call(groupRoutes.removeDirectGrant, {
        params: { shareId: action.shareId, identityId: action.identityId },
        body: { rotation, permissionVersion },
      });
      break;
    case 'remove-everywhere':
      await ctx.api.call(groupRoutes.removeFromSpace, {
        params: { spaceId, identityId: action.identityId },
        body: { rotations, permissionVersion },
      });
      break;
    case 'give-access':
      if (!subject) throw new CryptoError('malformed', 'Nobody to give access to');
      await ctx.api.call(groupRoutes.giveAccess, {
        params: { spaceId, identityId: subject.id },
        body: { keyVersion: subject.keyVersion, envelopes, permissionVersion },
      });
      break;
  }
  forgetSpaces(ctx);
}

/** Someone waiting in a space the caller owns, with each share they wait in. */
export type Waiting = {
  spaceId: SpaceId;
  person: DirectoryEntry;
  /** Their key changed since this app pinned it: confirm it before giving access. */
  keyChanged: boolean;
  shares: Omit<WaitingEntry, 'spaceId' | 'person'>[];
};

/**
 * Everyone waiting for keys in the spaces this person owns (section 7.9),
 * by space and person, for the "Waiting for you" note. The list is the
 * server's: Give access (`planGiveAccess`) works out afresh what to seal.
 */
export async function loadWaiting(ctx: ClientContext): Promise<Waiting[]> {
  const { waiting } = await ctx.api.call(groupRoutes.waiting);
  const out: Waiting[] = [];
  for (const { spaceId, person, ...share } of waiting) {
    let entry = out.find(
      (w) => w.spaceId === spaceId && w.person.identity.id === person.identity.id,
    );
    if (!entry) {
      const check = ctx.trust.check(person.identity, person.email);
      entry = {
        spaceId,
        person,
        keyChanged: check.kind === 'changed' || check.kind === 'removed',
        shares: [],
      };
      out.push(entry);
    }
    entry.shares.push(share);
  }
  return out;
}

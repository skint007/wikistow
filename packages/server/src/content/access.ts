import type { PublicIdentity } from '@wikistow/contracts';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import {
  agentGrants,
  groupMembers,
  groups,
  identities,
  nodes,
  shareGroups,
  shareMembers,
  shares,
  spaceOwners,
  spaces,
} from '../db/schema/index.ts';
import { highest } from './effective.ts';
import { ContentError } from './errors.ts';
import { currentIdentity, lookupIdentities } from './identities.ts';

export type AccessRole = 'reader' | 'editor' | 'owner';
export type Access = { role: AccessRole; canPublish: boolean };

export type ShareRow = typeof shares.$inferSelect;

/**
 * Clients follow parent links at most this deep (protocol section 6.1), and
 * so does every walk up the tree here: a cycle or a runaway path stops. No
 * node is made or moved deeper, counting from the top of the space, so
 * every walk of a tree made here is complete.
 */
export const MAX_DEPTH = 256;

// A node and its ancestors, nearest first.
export const ancestorsOf = (spaceId: string, nodeId: string) => sql`
  with recursive ancestors(id, parent_id, depth) as (
    select id, parent_id, 0 from nodes where id = ${nodeId} and space_id = ${spaceId}
    union all
    select n.id, n.parent_id, a.depth + 1 from nodes n
      join ancestors a on n.id = a.parent_id and n.space_id = ${spaceId}
    where a.depth < ${MAX_DEPTH}
  )`;

// A node and everything beneath it, but a copy's hidden nodes, which count
// for nothing outside their copy (section 10). The space is carried through
// the walk rather than compared with a constant: for a space Postgres has
// no statistics on yet, that estimates one row a step, and plans a scan of
// the space's nodes for every node walked.
export const subtreeOf = (spaceId: string, nodeId: string) => sql`
  with recursive subtree(id, space_id, depth) as (
    select id, space_id, 0 from nodes where id = ${nodeId} and space_id = ${spaceId}
    union all
    select n.id, n.space_id, s.depth + 1 from nodes n
      join subtree s on n.space_id = s.space_id and n.parent_id = s.id
    where s.depth < ${MAX_DEPTH} and n.copy_id is null
  )`;

/**
 * The nodes from `nodeId` up to the top of the space, nearest first, or none
 * for the top itself (`null`). Null when the walk doesn't reach the top
 * within `MAX_DEPTH`: a cycle, or a path already too deep.
 */
export async function pathUp(
  db: Database,
  spaceId: string,
  nodeId: string | null,
): Promise<string[] | null> {
  if (nodeId === null) return [];
  const rows = [
    ...(await db.execute<{ id: string; parent_id: string | null }>(sql`
      ${ancestorsOf(spaceId, nodeId)}
      select id, parent_id from ancestors order by depth`)),
  ];
  const top = rows.at(-1);
  return top && top.parent_id === null && rows.length <= MAX_DEPTH ? rows.map((r) => r.id) : null;
}

/**
 * Refuse to put `levels` levels of nodes under `path` (from `pathUp`) when
 * the deepest would be more than `MAX_DEPTH` from the top, or when the path
 * itself didn't reach the top (`too-deep`).
 */
export function requireRoom(path: readonly string[] | null, levels: number) {
  if (!path || path.length + levels > MAX_DEPTH) {
    throw new ContentError('too-deep', `Nothing goes more than ${MAX_DEPTH} levels deep`);
  }
}

/** Whether `identityId` is a current owner of the space. */
export async function isOwner(db: Database, identityId: string, spaceId: string) {
  const [row] = await db
    .select({ id: spaceOwners.identityId })
    .from(spaceOwners)
    .where(
      and(
        eq(spaceOwners.spaceId, spaceId),
        eq(spaceOwners.identityId, identityId),
        isNull(spaceOwners.removedAt),
      ),
    );
  return row !== undefined;
}

/** The space's current owners, at their current keys (section 6.6). */
export async function currentOwners(db: Database, spaceId: string): Promise<PublicIdentity[]> {
  const rows = await db
    .select({ id: spaceOwners.identityId })
    .from(spaceOwners)
    .where(and(eq(spaceOwners.spaceId, spaceId), isNull(spaceOwners.removedAt)));
  return lookupIdentities(
    db,
    rows.map((row) => row.id),
  );
}

/**
 * The share whose region holds a node, or the space's name for `null`
 * (section 6.1): the share rooted at the node or its nearest ancestor that
 * is a share root, else the space share, else none, for the owner region.
 * With `lock`, the share's row is held for the rest of the transaction:
 * writes hold it `share`, and a rotation `update`, so no write lands under
 * a key version older than the one current when it is stored.
 */
export async function shareAt(
  db: Database,
  spaceId: string,
  nodeId: string | null,
  { lock }: { lock?: 'share' | 'update' } = {},
): Promise<ShareRow | null> {
  const rows =
    nodeId === null
      ? await db.execute<{ id: string }>(
          sql`select id from shares where space_id = ${spaceId} and root_id is null`,
        )
      : await db.execute<{ id: string }>(sql`
          ${ancestorsOf(spaceId, nodeId)}
          select s.id from shares s
          left join ancestors a on a.id = s.root_id
          where s.space_id = ${spaceId} and (s.root_id is null or a.id is not null)
          order by a.depth nulls last
          limit 1`);
  const [found] = [...rows];
  if (!found) return null;
  const query = db.select().from(shares).where(eq(shares.id, found.id));
  const [share] = lock ? await query.for(lock) : await query;
  return share ?? null;
}

/** A person's membership in a share, if any. */
export async function membership(db: Database, identityId: string, shareId: string) {
  const [member] = await db
    .select()
    .from(shareMembers)
    .where(and(eq(shareMembers.shareId, shareId), eq(shareMembers.identityId, identityId)));
  return member ?? null;
}

/** Who access is worked out for: a person, or an agent acting for `personId`. */
export type Holder = { identity: { id: string }; personId: string | null };

/**
 * What `who` may do at `nodeId` (or the space root) and the share whose
 * region holds it (section 7.1): owners may do everything anywhere in
 * their space; a member, what their role allows in their share's region.
 * An agent gets the lesser of its grant there and its person's current
 * access (section 9.5), and only at or under the folder it was granted;
 * never anything in the owner region. Null means no access at all.
 */
export async function accessTo(
  db: Database,
  who: Holder,
  { spaceId, nodeId }: { spaceId: string; nodeId: string | null },
): Promise<(Access & { share: ShareRow | null }) | null> {
  if (nodeId !== null && (await isHidden(db, nodeId))) return null;
  const share = await shareAt(db, spaceId, nodeId);
  if (who.personId !== null) {
    if (!share) return null;
    const covering = [];
    for (const grant of await agentGrantsOf(db, {
      agentIds: [who.identity.id],
      shareIds: [share.id],
    })) {
      if (await withinPick(db, spaceId, nodeId, grant.folderId)) covering.push(grant);
    }
    const grant = highest(covering);
    const person = grant && (await personAccess(db, who.personId, share));
    return person && grant && { ...capAgent(grant, person), share };
  }
  if (await isOwner(db, who.identity.id, spaceId))
    return { role: 'owner', canPublish: true, share };
  if (!share) return null;
  const member = await membership(db, who.identity.id, share.id);
  return member ? { role: member.role, canPublish: member.canPublish, share } : null;
}

/**
 * Whether a node is one of a copy's new nodes, not shown yet: nobody has
 * access to it, so no route serves or changes it, and nothing can be made
 * in it, but what its copy does (section 10). Everything under a hidden
 * node is hidden too.
 */
export async function isHidden(db: Database, nodeId: string): Promise<boolean> {
  const [node] = await db.select({ copyId: nodes.copyId }).from(nodes).where(eq(nodes.id, nodeId));
  return node !== undefined && node.copyId !== null;
}

/** A person's own access in a share: an owner of its space, or a member of it. */
export async function personAccess(
  db: Database,
  personId: string,
  share: ShareRow,
): Promise<Access | null> {
  if (await isOwner(db, personId, share.spaceId)) return { role: 'owner', canPublish: true };
  const member = await membership(db, personId, share.id);
  return member && { role: member.role, canPublish: member.canPublish };
}

/**
 * An agent's access: its grant, no more than its person's access, which
 * for an owner counts as editor with publish. It publishes only if both
 * may (section 9.5).
 */
export function capAgent(
  grant: { role: 'reader' | 'editor'; canPublish: boolean },
  person: Access,
): Access {
  const role = grant.role === 'editor' && person.role !== 'reader' ? 'editor' : 'reader';
  return { role, canPublish: role === 'editor' && grant.canPublish && person.canPublish };
}

/** One way an agent reaches a share: its own pick, or a group its person confirmed. */
export type AgentGrant = {
  source: 'pick' | 'group';
  agentId: string;
  shareId: string;
  spaceId: string;
  /** The picked folder, or null for the whole share, as a group's always is. */
  folderId: string | null;
  role: 'reader' | 'editor';
  canPublish: boolean;
};

/**
 * Agents' grants (section 9.4), by agent, space or share: their own picks,
 * and each share of every group their person confirmed for them, whole, at
 * the group's access, or as a reader when the person kept the draft keys
 * from it. One share can have several; the highest that covers a node
 * counts, capped by the person's access (`capAgent`). A revoked agent's
 * groups give it nothing.
 */
export async function agentGrantsOf(
  db: Database,
  where: { agentIds?: readonly string[]; spaceId?: string; shareIds?: readonly string[] },
): Promise<AgentGrant[]> {
  if (where.agentIds?.length === 0 || where.shareIds?.length === 0) return [];
  const picks = await db
    .select({
      agentId: agentGrants.agentId,
      shareId: agentGrants.shareId,
      spaceId: agentGrants.spaceId,
      folderId: agentGrants.folderId,
      role: agentGrants.role,
      canPublish: agentGrants.canPublish,
    })
    .from(agentGrants)
    .where(
      and(
        where.agentIds && inArray(agentGrants.agentId, [...where.agentIds]),
        where.spaceId === undefined ? undefined : eq(agentGrants.spaceId, where.spaceId),
        where.shareIds && inArray(agentGrants.shareId, [...where.shareIds]),
      ),
    );
  const viaGroups = await db
    .select({
      agentId: groupMembers.identityId,
      shareId: shareGroups.shareId,
      spaceId: groups.spaceId,
      role: shareGroups.role,
      canPublish: shareGroups.canPublish,
      drafts: groupMembers.agentDrafts,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(shareGroups, eq(shareGroups.groupId, groupMembers.groupId))
    .innerJoin(
      identities,
      and(eq(identities.id, groupMembers.identityId), eq(identities.keyVersion, 1)),
    )
    .where(
      and(
        isNotNull(groupMembers.agentDrafts),
        isNull(identities.revokedAt),
        where.agentIds && inArray(groupMembers.identityId, [...where.agentIds]),
        where.spaceId === undefined ? undefined : eq(groups.spaceId, where.spaceId),
        where.shareIds && inArray(shareGroups.shareId, [...where.shareIds]),
      ),
    );
  return [
    ...picks.map((pick) => ({ ...pick, source: 'pick' as const })),
    ...viaGroups.map(({ drafts, role, canPublish, ...grant }) => ({
      ...grant,
      source: 'group' as const,
      folderId: null,
      role: drafts ? role : ('reader' as const),
      canPublish: drafts === true && canPublish,
    })),
  ];
}

/**
 * Where an agent's view of a share starts, from its grants there: the
 * share root when one gives the whole share, else its pick.
 */
export const agentStart = (share: ShareRow, grants: readonly Pick<AgentGrant, 'folderId'>[]) =>
  grants.some((grant) => grant.folderId === null)
    ? share.rootId
    : (grants[0]?.folderId ?? share.rootId);

// Whether a node (or the space root, `null`) is at or under the folder an
// agent was granted; a grant of the whole share covers everything in it.
async function withinPick(
  db: Database,
  spaceId: string,
  nodeId: string | null,
  folderId: string | null,
): Promise<boolean> {
  if (folderId === null) return true;
  if (nodeId === null) return false;
  const rows = await db.execute<{ id: string }>(sql`
    ${ancestorsOf(spaceId, nodeId)}
    select id from ancestors where id = ${folderId} limit 1`);
  return [...rows].length > 0;
}

export const canEdit = (access: Access | null) => access !== null && access.role !== 'reader';

type NodeRow = Pick<typeof nodes.$inferSelect, 'id' | 'parentId'>;

/**
 * Which share holds each node of a space: the share rooted at the node or
 * its nearest ancestor that is a share root, else the space's own share,
 * else none. Walks stop at `MAX_DEPTH`, so a cycle can't hang them.
 */
export function sharesByNode(nodeRows: readonly NodeRow[], spaceShares: readonly ShareRow[]) {
  const parents = new Map(nodeRows.map((node) => [node.id, node.parentId]));
  const roots = new Map(spaceShares.flatMap((s) => (s.rootId ? [[s.rootId, s] as const] : [])));
  const spaceShare = spaceShares.find((s) => s.rootId === null) ?? null;
  const out = new Map<string, ShareRow | null>();
  for (const node of nodeRows) {
    let at: string | null | undefined = node.id;
    let found: ShareRow | null = spaceShare;
    for (let depth = 0; at && depth <= MAX_DEPTH; depth++) {
      const share = roots.get(at);
      if (share) {
        found = share;
        break;
      }
      at = parents.get(at);
    }
    out.set(node.id, found);
  }
  return out;
}

/**
 * Where in a space a caller has access: `at` gives the access in the share
 * holding a node, or at the space's name for a `null` node, and `starts`
 * the nodes the caller's view starts at, whose parents are withheld.
 * `held` gives the caller's access in a share as a whole, and where its
 * view of the share starts: the share root, or an agent's pick.
 */
export type TreeView = {
  owner: boolean;
  at: (share: ShareRow | null, nodeId: string | null) => Access | null;
  starts: ReadonlySet<string>;
  held: (share: ShareRow) => { access: Access; rootId: string | null } | null;
};

/**
 * Which spaces, of `spaceIds` or all, a person sees some of the tree of,
 * as `treeView` decides for them: they own the space, or are a member of
 * a share in it.
 */
export async function treesSeenBy(
  db: Database,
  accountId: string,
  spaceIds?: string[],
): Promise<Set<string>> {
  const identity = spaceIds?.length === 0 ? null : await currentIdentity(db, accountId);
  if (!identity) return new Set();
  const rows = await db
    .select({ spaceId: spaceOwners.spaceId })
    .from(spaceOwners)
    .where(
      and(
        eq(spaceOwners.identityId, identity.id),
        isNull(spaceOwners.removedAt),
        spaceIds && inArray(spaceOwners.spaceId, spaceIds),
      ),
    )
    .union(
      db
        .select({ spaceId: shares.spaceId })
        .from(shareMembers)
        .innerJoin(shares, eq(shares.id, shareMembers.shareId))
        .where(
          and(
            eq(shareMembers.identityId, identity.id),
            spaceIds && inArray(shares.spaceId, spaceIds),
          ),
        ),
    );
  return new Set(rows.map((row) => row.spaceId));
}

/** The caller's view of a space, or null when they have no place in it. */
export async function treeView(
  db: Database,
  caller: Holder,
  spaceId: string,
  spaceShares: readonly ShareRow[],
  parents: ReadonlyMap<string, string | null>,
): Promise<TreeView | null> {
  const roots = new Set(spaceShares.flatMap((share) => (share.rootId ? [share.rootId] : [])));
  if (caller.personId === null) {
    const owner = await isOwner(db, caller.identity.id, spaceId);
    const memberships = new Map(
      (
        await db
          .select()
          .from(shareMembers)
          .innerJoin(shares, eq(shares.id, shareMembers.shareId))
          .where(and(eq(shares.spaceId, spaceId), eq(shareMembers.identityId, caller.identity.id)))
      ).map(({ share_members: member }) => [member.shareId, member] as const),
    );
    if (!owner && memberships.size === 0) return null;
    const at: TreeView['at'] = (share) => {
      if (owner) return { role: 'owner', canPublish: true };
      const member = share && memberships.get(share.id);
      return member ? { role: member.role, canPublish: member.canPublish } : null;
    };
    return {
      owner,
      at,
      // A member's view starts at each share root (section 7.7).
      starts: owner ? new Set() : roots,
      held: (share) => {
        const access = at(share, share.rootId);
        return access && { access, rootId: share.rootId };
      },
    };
  }
  // An agent sees what it was granted, within its person's current access,
  // starting at the folder of its pick, or at the share root.
  const grants = await agentGrantsOf(db, { agentIds: [caller.identity.id], spaceId });
  const allowed = new Map<string, { grants: AgentGrant[]; person: Access; start: string | null }>();
  const starts = new Set<string>();
  for (const [shareId, held] of Map.groupBy(grants, (grant) => grant.shareId)) {
    const share = spaceShares.find((s) => s.id === shareId);
    const person = share && (await personAccess(db, caller.personId, share));
    if (!share || !person) continue;
    const start = agentStart(share, held);
    allowed.set(share.id, { grants: held, person, start });
    if (start) starts.add(start);
  }
  if (allowed.size === 0) return null;
  const within = (nodeId: string | null, folderId: string | null) => {
    if (folderId === null) return true;
    let at = nodeId;
    for (let depth = 0; at && depth <= MAX_DEPTH; depth++) {
      if (at === folderId) return true;
      at = parents.get(at) ?? null;
    }
    return false;
  };
  return {
    owner: false,
    at: (share, nodeId) => {
      const held = share && allowed.get(share.id);
      const grant = held && highest(held.grants.filter((g) => within(nodeId, g.folderId)));
      return held && grant ? capAgent(grant, held.person) : null;
    },
    starts,
    // Its pick stands in for the share root, which may be above it, unnamed.
    // Its access there, from the grants that cover where its view starts.
    held: (share) => {
      const held = allowed.get(share.id);
      const whole = held?.grants.filter((g) => g.folderId === null) ?? [];
      const grant = held && highest(whole.length > 0 ? whole : held.grants);
      return held && grant ? { access: capAgent(grant, held.person), rootId: held.start } : null;
    },
  };
}

/**
 * Run `read` in one read-only repeatable-read transaction, so its queries
 * all see the database as it was at one moment, without taking locks.
 * Inside a caller's transaction it runs there as a savepoint, so it only
 * shares one snapshot when that transaction is repeatable read too.
 */
export function readSnapshot<T>(db: Database, read: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(read, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/**
 * `accessTo` for many pages of a space at once, in the same few queries
 * however many there are: the shares holding them, from their paths up as
 * the tree works them out (`sharesByNode`), and the caller's place in each
 * (`treeView`). A page that isn't in the space has no access. The queries
 * share a snapshot, so a move or unshare between two of them can't put a
 * page under a share that never held it. A copy's hidden nodes have none.
 */
export async function accessToPages(
  db: Database,
  who: Holder,
  spaceId: string,
  pageIds: readonly string[],
): Promise<Map<string, Access | null>> {
  if (pageIds.length === 0) return accessToPagesIn(db, who, spaceId, pageIds);
  return readSnapshot(db, (tx) => accessToPagesIn(tx, who, spaceId, pageIds));
}

/** `accessToPages` in the caller's own transaction, as it sees the database. */
export async function accessToPagesIn(
  tx: Database,
  who: Holder,
  spaceId: string,
  pageIds: readonly string[],
): Promise<Map<string, Access | null>> {
  const access = new Map<string, Access | null>(pageIds.map((id) => [id, null]));
  if (pageIds.length === 0) return access;
  // Every node on the pages' paths up, once each, so a cycle ends too.
  const path = [
    ...(await tx.execute<{ id: string; parent_id: string | null }>(sql`
      with recursive up(id, parent_id) as (
        select id, parent_id from nodes
        where space_id = ${spaceId} and id = any(${sql.param([...pageIds])}::text[])
          and copy_id is null
        union
        select n.id, n.parent_id from nodes n
          join up on n.id = up.parent_id and n.space_id = ${spaceId}
      )
      select id, parent_id from up`)),
  ].map(({ id, parent_id }) => ({ id, parentId: parent_id }));
  const spaceShares = await tx.select().from(shares).where(eq(shares.spaceId, spaceId));
  const parents = new Map(path.map((node) => [node.id, node.parentId]));
  const view = await treeView(tx, who, spaceId, spaceShares, parents);
  if (!view) return access;
  const holding = sharesByNode(path, spaceShares);
  for (const id of pageIds) {
    if (parents.has(id)) access.set(id, view.at(holding.get(id) ?? null, id));
  }
  return access;
}

/**
 * Hold the space for the rest of the transaction against changes to its
 * regions: making a share, and owner changes, which lock its row for
 * update. Every content write takes this key-share lock on it first, before
 * any share or node row, so a write sees one region for its whole
 * transaction, and the two never wait on each other's locks. After it,
 * everything takes a share's row before its nodes: writes, rotations and
 * member changes, and deleting a share's root.
 */
export async function lockSpace(tx: Database, spaceId: string): Promise<void> {
  const [space] = await tx
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .for('key share');
  if (!space) throw new ContentError('not-found');
}

/** `lockSpace` for the space a node is in. */
export async function lockSpaceOf(tx: Database, nodeId: string): Promise<void> {
  const [node] = await tx
    .select({ spaceId: nodes.spaceId })
    .from(nodes)
    .where(eq(nodes.id, nodeId));
  if (!node) throw new ContentError('not-found');
  await lockSpace(tx, node.spaceId);
}

/**
 * The share a write in `access.share` goes under, held for the rest of the
 * transaction so no rotation lands before the write is stored, as it is now.
 */
export async function lockShare(tx: Database, share: ShareRow | null): Promise<ShareRow | null> {
  if (!share) return null;
  const [held] = await tx.select().from(shares).where(eq(shares.id, share.id)).for('share');
  return held ?? null;
}

// Effective access with groups (protocol section 7.8): a person's access in
// a share is the highest of their direct grant there and the access of
// their groups that have the share. The server keeps one member row per
// person holding the share's keys, and every change recomputes the rows it
// touches, so access checks read the rows and never expand a group.
import { and, eq, inArray, not, like } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { groupMembers, shareGroups, shareMembers } from '../db/schema/index.ts';
import { ContentError } from './errors.ts';

export type Grant = { role: 'reader' | 'editor'; canPublish: boolean };
export type MemberRow = typeof shareMembers.$inferSelect;

/** Reader, editor, editor with publish, in that order; nothing ranks lowest. */
const rank = (grant: Grant | null) =>
  grant === null ? 0 : grant.role === 'reader' ? 1 : grant.canPublish ? 3 : 2;

/** The highest of some grants, or null for none. */
export const highest = (grants: readonly (Grant | null)[]): Grant | null =>
  grants.reduce<Grant | null>((best, grant) => (rank(grant) > rank(best) ? grant : best), null);

/** Whether keys of class `held` (a member row's role) are more than `access` allows. */
export const keysExceed = (held: Grant['role'], access: Grant | null) =>
  access === null || (held === 'editor' && access.role === 'reader');

/** Whether keys of class `held` give everything `access` needs. */
export const keysCover = (held: Grant['role'], access: Grant) =>
  held === 'editor' || access.role === 'reader';

/** A member row's direct grant, or null. */
export const directOf = (row: MemberRow): Grant | null =>
  row.directRole === null
    ? null
    : { role: row.directRole, canPublish: row.directCanPublish === true };

type ByShare = Map<string, Map<string, Grant>>;

// Raise one person's access in one share to at least `grant`.
const raise = (out: ByShare, shareId: string, identityId: string, grant: Grant | null) => {
  const people = out.get(shareId) ?? new Map<string, Grant>();
  const best = highest([people.get(identityId) ?? null, grant]);
  if (best) people.set(identityId, best);
  out.set(shareId, people);
};

/**
 * Every person's effective access in each of `shareIds`, by share and then
 * identity: direct grants from the member rows, and the access of each
 * group with the share for its human members. Agents in groups are left to
 * their person (section 9.4).
 */
export async function effectiveAccess(tx: Database, shareIds: readonly string[]) {
  const out = await groupAccess(tx, shareIds);
  if (shareIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(shareMembers)
    .where(inArray(shareMembers.shareId, [...shareIds]));
  for (const row of rows) raise(out, row.shareId, row.identityId, directOf(row));
  return out;
}

/** The access people have in each of `shareIds` through groups alone. */
export async function groupAccess(tx: Database, shareIds: readonly string[]) {
  const out: ByShare = new Map();
  if (shareIds.length === 0) return out;
  const viaGroups = await tx
    .select({
      shareId: shareGroups.shareId,
      identityId: groupMembers.identityId,
      role: shareGroups.role,
      canPublish: shareGroups.canPublish,
    })
    .from(shareGroups)
    .innerJoin(groupMembers, eq(groupMembers.groupId, shareGroups.groupId))
    .where(
      and(
        inArray(shareGroups.shareId, [...shareIds]),
        not(like(groupMembers.identityId, 'agent-%')),
      ),
    );
  for (const { shareId, identityId, ...grant } of viaGroups) raise(out, shareId, identityId, grant);
  return out;
}

/**
 * Members of `shareIds` whose keys exceed their effective access: each
 * must be left out of a rotation (`keeps: null`), or for someone who keeps
 * reading, left out or demoted.
 */
export async function excessKeys(tx: Database, shareIds: readonly string[]) {
  if (shareIds.length === 0) return [];
  const access = await effectiveAccess(tx, shareIds);
  const rows = await tx
    .select()
    .from(shareMembers)
    .where(inArray(shareMembers.shareId, [...shareIds]));
  return rows.flatMap((row) => {
    const keeps = access.get(row.shareId)?.get(row.identityId) ?? null;
    return keysExceed(row.role, keeps)
      ? [{ shareId: row.shareId, identityId: row.identityId, keeps: keeps && keeps.role }]
      : [];
  });
}

/**
 * The server's coverage check for a change that takes access away
 * (section 7.9): it carries a rotation for exactly the shares where
 * someone's keys exceed their new access, and each leaves them out, or
 * demotes someone who keeps reading, and for `agentsLost`, the shares a
 * confirmed agent no longer reaches (section 9.4), which a rotation leaves
 * out by itself, since only its person seals to it. Where nobody's keys
 * exceed it, nothing is rotated.
 */
export async function requireRotationsCover(
  tx: Database,
  shareIds: readonly string[],
  rotations: readonly { shareId: string; removed: readonly string[]; demoted: readonly string[] }[],
  agentsLost: ReadonlySet<string> = new Set(),
) {
  const excess = await excessKeys(tx, shareIds);
  const needed = new Set([...excess.map((e) => e.shareId), ...agentsLost]);
  const given = new Map(rotations.map((rotation) => [rotation.shareId, rotation]));
  const exact =
    given.size === rotations.length &&
    given.size === needed.size &&
    [...needed].every((shareId) => given.has(shareId));
  if (!exact) {
    throw new ContentError('stale-head', 'Rotate exactly the shares where keys exceed access');
  }
  for (const { shareId, identityId, keeps } of excess) {
    const rotation = given.get(shareId);
    const leftOut = rotation?.removed.includes(identityId) === true;
    const demoted = rotation?.demoted.includes(identityId) === true;
    if (!leftOut && !(keeps === 'reader' && demoted)) {
      throw new ContentError('stale-head', 'A rotation must leave out everyone losing access', {
        shareId,
      });
    }
  }
}

/**
 * Bring the member rows of `shareIds` in line with their effective access
 * after a change, under the lock on the space: publish rights follow it,
 * capped by the keys each person holds. A row whose keys exceed it means a
 * rotation is missing, so the change is refused.
 */
export async function recomputeMembers(tx: Database, shareIds: readonly string[]) {
  if (shareIds.length === 0) return;
  const access = await effectiveAccess(tx, shareIds);
  const rows = await tx
    .select()
    .from(shareMembers)
    .where(inArray(shareMembers.shareId, [...shareIds]));
  for (const row of rows) {
    const effective = access.get(row.shareId)?.get(row.identityId) ?? null;
    if (keysExceed(row.role, effective)) {
      throw new ContentError('stale-head', 'A rotation must leave out everyone losing access', {
        shareId: row.shareId,
      });
    }
    const canPublish = row.role === 'editor' && effective?.canPublish === true;
    if (canPublish !== row.canPublish) {
      await tx
        .update(shareMembers)
        .set({ canPublish })
        .where(
          and(eq(shareMembers.shareId, row.shareId), eq(shareMembers.identityId, row.identityId)),
        );
    }
  }
}

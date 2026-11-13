// The order of the pages and folders in a folder, or at the top of a space
// (protocol section 10, Order, #400). A folder whose children have no position
// lists them by name, which only apps can do; one with an order of its own
// lists them by `nodes.position`, a fractional index compared byte by byte.
// The server sees an order of IDs it already sees, never a name.
import { isPosition } from '@wikistow/contracts';
import { positionBetween, positionsBetween } from '@wikistow/client';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { nodes, shares } from '../db/schema/index.ts';
import { transactOnce, type Once } from '../idempotency.ts';
import { accessTo, canEdit, lockSpace } from './access.ts';
import { ContentError } from './errors.ts';
import { requireCaller, type Actor } from './identities.ts';

/** The children of `parentId` in `spaceId`, or the top of the space for null. */
const childrenOf = (spaceId: string, parentId: string | null) =>
  and(
    eq(nodes.spaceId, spaceId),
    parentId === null ? isNull(nodes.parentId) : eq(nodes.parentId, parentId),
  );

/** What is in a folder's tree: not in the trash, nor one of an unfinished copy's nodes. */
const shown = and(isNull(nodes.trashId), isNull(nodes.copyId));

/**
 * Whether a folder has an order of its own, and the highest position there
 * (null when it has none). Only what it shows decides whether it is
 * ordered; what is in its trash counts for the highest too, so nothing new
 * takes a position that something restored will come back to. `except`
 * leaves out nodes on their way in.
 */
async function lastPosition(
  tx: Database,
  spaceId: string,
  parentId: string | null,
  except: readonly string[] = [],
): Promise<string | null> {
  const [row] = await tx
    .select({
      ordered: sql<boolean>`bool_or(${nodes.trashId} is null)`,
      last: sql<string | null>`max(${nodes.position})`,
    })
    .from(nodes)
    .where(
      and(
        childrenOf(spaceId, parentId),
        isNull(nodes.copyId),
        isNotNull(nodes.position),
        ...(except.length > 0 ? [sql`${nodes.id} <> all(${sql.param([...except])}::text[])`] : []),
      ),
    );
  return row?.ordered ? (row.last ?? null) : null;
}

/**
 * Where something new in a folder goes: at the end, in one with an order
 * of its own, else nowhere in particular (null), so it lists by name like
 * the rest. `count` places several, in order.
 */
export async function placesAtEnd(
  tx: Database,
  { spaceId, parentId, count = 1, except = [] }: PlaceAt & { count?: number },
): Promise<(string | null)[]> {
  const last = await lastPosition(tx, spaceId, parentId, except);
  if (last === null) return Array.from({ length: count }, () => null);
  const after = (from: string) => {
    const placed: string[] = [];
    let at = from;
    for (let i = 0; i < count; i++) placed.push((at = positionBetween(at, null)));
    return placed;
  };
  try {
    return after(last);
  } catch {
    // Its keys grew too long, or one isn't a position: written afresh, in
    // the order they have, so there is room after them.
    return after(await rekey(tx, { spaceId, parentId, except }));
  }
}

/**
 * Give everything in a folder with a position a new one, short, in the
 * order they have, the trash's too; answers the last. For when keys there
 * grew too long to place anything after them.
 */
async function rekey(tx: Database, { spaceId, parentId, except = [] }: PlaceAt): Promise<string> {
  const placed = await tx
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        childrenOf(spaceId, parentId),
        isNull(nodes.copyId),
        isNotNull(nodes.position),
        ...(except.length > 0 ? [sql`${nodes.id} <> all(${sql.param([...except])}::text[])`] : []),
      ),
    )
    .orderBy(nodes.position, nodes.id);
  const keys = positionsBetween(null, null, placed.length);
  for (const [i, { id }] of placed.entries()) {
    await tx
      .update(nodes)
      .set({ position: keys[i] ?? null })
      .where(eq(nodes.id, id));
  }
  return keys.at(-1) ?? positionBetween(null, null);
}

type PlaceAt = { spaceId: string; parentId: string | null; except?: readonly string[] };

/** `placesAtEnd` for one. */
export const placeAtEnd = async (tx: Database, at: PlaceAt) =>
  (await placesAtEnd(tx, at))[0] ?? null;

/**
 * Where a node that was in a folder goes back to it, as a restore puts it
 * (section 11): its old position, while the folder has an order of its own,
 * and none once it lists by name again, so it doesn't make it ordered.
 */
export async function placeBack(
  tx: Database,
  { spaceId, parentId, nodeId }: { spaceId: string; parentId: string | null; nodeId: string },
): Promise<string | null> {
  const [node] = await tx
    .select({ position: nodes.position })
    .from(nodes)
    .where(eq(nodes.id, nodeId));
  const ordered = (await lastPosition(tx, spaceId, parentId, [nodeId])) !== null;
  if (!ordered) return null;
  const old = node?.position;
  // No position, in an ordered folder: at the end, like anything new there.
  if (!old || !isPosition(old)) return placeAtEnd(tx, { spaceId, parentId, except: [nodeId] });
  // Something given the same position meanwhile keeps it; this goes just after.
  const keys = await tx
    .select({ position: nodes.position })
    .from(nodes)
    .where(
      and(
        childrenOf(spaceId, parentId),
        shown,
        sql`${nodes.position} >= ${old}`,
        sql`${nodes.id} <> ${nodeId}`,
      ),
    )
    .orderBy(nodes.position)
    .limit(2);
  if (keys[0]?.position !== old) return old;
  const next = keys[1]?.position ?? null;
  try {
    return positionBetween(old, next !== null && isPosition(next) && next > old ? next : null);
  } catch {
    return placeAtEnd(tx, { spaceId, parentId, except: [nodeId] });
  }
}

/**
 * The caller may change the order in `parentId`, or at the top of the
 * space: they can edit there, as a move into it needs (section 10). A
 * folder they can't see, gone or in the trash, is `not-found`.
 */
async function requireArranger(
  tx: Database,
  actor: Actor,
  { spaceId, parentId }: { spaceId: string; parentId: string | null },
) {
  const caller = await requireCaller(tx, actor);
  await lockSpace(tx, spaceId);
  if (parentId !== null) {
    const [folder] = await tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.id, parentId), eq(nodes.spaceId, spaceId), eq(nodes.kind, 'folder')));
    if (!folder) throw new ContentError('not-found');
  }
  const access = await accessTo(tx, caller, { spaceId, nodeId: parentId });
  if (!access) throw new ContentError('not-found');
  if (!canEdit(access)) throw new ContentError('forbidden');
  return caller;
}

/**
 * Put nodes in order in one folder, or at the top of a space (section
 * 5.4): each gets its position, or none for null. Each must be in that
 * folder now, and one the caller can see; one elsewhere is `stale-head`,
 * as it moved since the app listed it. Nothing else changes: no keys, no
 * permission versions, so nobody's write elsewhere is turned away by it.
 * The change to `nodes` tells the people who see the space.
 */
export async function arrangeNodes(
  db: Database,
  input: {
    actor: Actor;
    spaceId: string;
    parentId: string | null;
    positions: readonly { nodeId: string; position: string | null }[];
    once?: Once | undefined;
  },
): Promise<void> {
  const { spaceId, parentId } = input;
  const byNode = new Map(input.positions.map((p) => [p.nodeId, p.position]));
  if (byNode.size !== input.positions.length) {
    throw new ContentError('binding-mismatch', 'Each node is named once');
  }
  for (const position of byNode.values()) {
    if (position !== null && !isPosition(position)) {
      throw new ContentError('binding-mismatch', 'Not a position');
    }
  }
  await transactOnce(db, input.once, async (tx) => {
    const caller = await requireArranger(tx, input.actor, { spaceId, parentId });
    const ids = [...byNode.keys()];
    const found = await tx
      .select({ id: nodes.id, parentId: nodes.parentId })
      .from(nodes)
      .where(and(eq(nodes.spaceId, spaceId), inArray(nodes.id, ids), shown))
      .for('no key update');
    const byId = new Map(found.map((row) => [row.id, row]));
    for (const id of ids) {
      if (!byId.has(id)) throw new ContentError('not-found');
    }
    // A child is in its folder's region, which the caller edits, unless it
    // is the root of a share of its own, which they may not see: one they
    // can't see doesn't exist for them.
    const roots = await tx
      .select({ rootId: shares.rootId })
      .from(shares)
      .where(and(eq(shares.spaceId, spaceId), inArray(shares.rootId, ids)));
    for (const { rootId } of roots) {
      if (rootId !== null && !(await accessTo(tx, caller, { spaceId, nodeId: rootId }))) {
        throw new ContentError('not-found');
      }
    }
    for (const id of ids) {
      if (byId.get(id)?.parentId === parentId) continue;
      // Somewhere else now: said only to someone who sees it there, as a
      // move says where a node is only to someone who may move it.
      if (!(await accessTo(tx, caller, { spaceId, nodeId: id }))) {
        throw new ContentError('not-found');
      }
      throw new ContentError('stale-head', 'It moved since you loaded it', { nodeIds: [id] });
    }
    for (const [id, position] of byNode) {
      await tx.update(nodes).set({ position }).where(eq(nodes.id, id));
    }
  });
}

/**
 * Sort by name: clear every position in one folder, or at the top of a
 * space, so it lists by name again (section 10, Order). What is in the trash
 * from there loses its position too, so restoring it doesn't make the
 * folder ordered again.
 */
export async function sortByName(
  db: Database,
  input: { actor: Actor; spaceId: string; parentId: string | null; once?: Once | undefined },
): Promise<void> {
  await transactOnce(db, input.once, async (tx) => {
    await requireArranger(tx, input.actor, input);
    await tx
      .update(nodes)
      .set({ position: null })
      .where(and(childrenOf(input.spaceId, input.parentId), isNotNull(nodes.position)));
  });
}

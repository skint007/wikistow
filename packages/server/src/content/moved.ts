// Old addresses of what a move took into another space (protocol section
// 10, "Old addresses"; ADR 0007, decision 9). A move gives every node a new
// ID, so the finish writes where each one went, and an old address, or a
// link from a page left behind, opens the new place for anyone who can open
// it. Anyone else gets not-found, as for a node that never existed. The
// records go when their new node is deleted for good (`forgetMoves`).
import { and, eq, sql } from 'drizzle-orm';
import { anyId } from '../db/any.ts';
import type { Database } from '../db/client.ts';
import { movedNodes, nodes, pageHeads } from '../db/schema/index.ts';
import { accessTo, canEdit } from './access.ts';
import { ContentError } from './errors.ts';
import { requireCaller, type Actor } from './identities.ts';

/** One node a move took: its ID in the source space, and its new node's. */
export type MovedNode = { sourceId: string; nodeId: string };

/**
 * Record, inside the move's finish and before its source is deleted, where
 * each of `moved` went. Records naming a source node as their new place
 * point on at its new node, so a chain of moves stays one step; deleting
 * the source would otherwise take them along.
 */
export async function recordMoves(
  tx: Database,
  move: { sourceSpaceId: string; destinationSpaceId: string; moved: readonly MovedNode[] },
) {
  if (move.moved.length === 0) return;
  // Each as one array parameter, so a large move is two statements.
  const pairs = sql`unnest(
    ${sql.param(move.moved.map((node) => node.sourceId))}::text[],
    ${sql.param(move.moved.map((node) => node.nodeId))}::text[]
  ) as p(source_id, node_id)`;
  await tx.execute(sql`
    update moved_nodes m set new_space_id = ${move.destinationSpaceId}, new_id = p.node_id
    from ${pairs}
    where m.new_space_id = ${move.sourceSpaceId} and m.new_id = p.source_id`);
  // Node IDs are never reused, so an old ID is recorded once.
  await tx.execute(sql`
    insert into moved_nodes (old_id, old_space_id, new_space_id, new_id)
    select p.source_id, ${move.sourceSpaceId}, ${move.destinationSpaceId}, p.node_id
    from ${pairs}
    on conflict do nothing`);
}

/**
 * Remove the records of moves to nodes of `spaceId` deleted for good: `ids`,
 * or with none given, every node of the space, which is going.
 */
export async function forgetMoves(tx: Database, spaceId: string, ids?: readonly string[]) {
  await tx
    .delete(movedNodes)
    .where(and(eq(movedNodes.newSpaceId, spaceId), ids ? anyId(movedNodes.newId, ids) : undefined));
}

/**
 * Where the node `nodeId` of `spaceId` moved to, for a caller who can open
 * it there: a folder they have access to, or a page they could open
 * (`pageInfo`: readers only once it is published). Not-found for anyone
 * else, for a node that didn't move, and while the new node is in the trash.
 */
export async function movedPlace(
  db: Database,
  actor: Actor,
  { spaceId, nodeId }: { spaceId: string; nodeId: string },
) {
  const caller = await requireCaller(db, actor);
  const [moved] = await db
    .select({ spaceId: nodes.spaceId, nodeId: nodes.id, kind: nodes.kind })
    .from(movedNodes)
    .innerJoin(nodes, and(eq(nodes.spaceId, movedNodes.newSpaceId), eq(nodes.id, movedNodes.newId)))
    .where(and(eq(movedNodes.oldId, nodeId), eq(movedNodes.oldSpaceId, spaceId)));
  if (!moved) throw new ContentError('not-found');
  // Hidden nodes, in the trash, give no access.
  const access = await accessTo(db, caller, moved);
  if (!access) throw new ContentError('not-found');
  if (moved.kind === 'page' && !canEdit(access)) {
    const [heads] = await db
      .select({ publishedHead: pageHeads.publishedHead })
      .from(pageHeads)
      .where(eq(pageHeads.pageId, moved.nodeId));
    if (!heads?.publishedHead) throw new ContentError('not-found');
  }
  return moved;
}

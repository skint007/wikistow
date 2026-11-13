// Putting pages and folders in an order of their own, in a folder or at the
// top of a space (protocol section 10, Order, #400). The order is shared: everyone
// who sees the folder sees it, and anyone who can edit there changes it.
import { structureRoutes, type FolderId, type Position, type SpaceId } from '@wikistow/contracts';
import { positionsFor, type PositionWrite } from '../positions.ts';
import type { ClientContext } from './session.ts';

/**
 * Give nodes in `parentId`, or at the top of the space for null, their
 * positions, or none for null, which lists them by name after the rest.
 * Each must be there now (`stale-head` otherwise).
 */
export async function arrange(
  ctx: ClientContext,
  {
    spaceId,
    parentId,
    positions,
  }: { spaceId: SpaceId; parentId: FolderId | null; positions: readonly PositionWrite[] },
): Promise<void> {
  if (positions.length === 0) return;
  await ctx.api.call(structureRoutes.arrange, {
    params: { spaceId },
    body: { parentId, positions: [...positions] },
  });
}

/** Sort by name: everything in `parentId`, or at the top, lists by name again. */
export async function sortByName(
  ctx: ClientContext,
  { spaceId, parentId }: { spaceId: SpaceId; parentId: FolderId | null },
): Promise<void> {
  await ctx.api.call(structureRoutes.sortByName, { params: { spaceId }, body: { parentId } });
}

/** A child of the folder, in the order shown. */
type Shown = { id: string; position: string | null };

/**
 * Where `nodeId` goes to land just before `before` among `shown`, the
 * folder's children in the order shown, or at the end for null: the
 * writes that make it so, its own and the fewest others' (`positionsFor`).
 * `nodeId` may be one of `shown`, a reorder, or arriving from elsewhere.
 */
export function placing(
  shown: readonly Shown[],
  nodeId: string,
  before: string | null,
): { own: PositionWrite; others: PositionWrite[] } {
  const moving = shown.find((child) => child.id === nodeId) ?? { id: nodeId, position: null };
  const rest = shown.filter((child) => child.id !== nodeId);
  const at = before === null ? rest.length : rest.findIndex((child) => child.id === before);
  const order = [...rest];
  order.splice(at < 0 ? rest.length : at, 0, moving);
  const writes = positionsFor(order, nodeId);
  // Its key, where it stays the same, isn't written: it keeps it.
  const own = writes.find((write) => write.nodeId === nodeId) ?? {
    nodeId,
    position: moving.position as Position | null,
  };
  return { own, others: writes.filter((write) => write.nodeId !== nodeId) };
}

/**
 * Move up or Move down: `nodeId` swapped with the child before or after it
 * in `shown`. Null when it is first or last already.
 */
export function stepping(
  shown: readonly Shown[],
  nodeId: string,
  step: -1 | 1,
): PositionWrite[] | null {
  const at = shown.findIndex((child) => child.id === nodeId);
  const to = at + step;
  if (at < 0 || to < 0 || to >= shown.length) return null;
  const order = [...shown];
  const [moving] = order.splice(at, 1);
  if (!moving) return null;
  order.splice(to, 0, moving);
  return positionsFor(order, nodeId);
}

/** The writes that put `writes`' nodes back as `shown` had them, for Undo. */
export const undoing = (
  shown: readonly Shown[],
  writes: readonly PositionWrite[],
): PositionWrite[] =>
  writes.map(({ nodeId }) => ({
    nodeId,
    position: (shown.find((child) => child.id === nodeId)?.position ?? null) as Position | null,
  }));

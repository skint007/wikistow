// Ending public links and copies (ADR 0005, decisions 5 and 8). Every
// change that ends some locks the rows it deletes first: the links, then
// the copies, then the target rows, each in order of ID. Changes that end
// them hold the page's locks already (its space, share, node and heads, a
// delete's locks, or a change of rights's space or share), or for a
// suspension the account's row, and any account rows before these, so two
// endings that meet wait for each other instead of deadlocking.
import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { audit } from '../admin/audit.ts';
import type { Database } from '../db/client.ts';
import { publicCopies, publicLinks, publicTargets, users } from '../db/schema/index.ts';

// One array parameter however many there are, so a space's worth of pages
// can't pass Postgres's limit on parameters.
const anyOf = (column: unknown, ids: readonly string[]) =>
  sql`${column} = any(${sql.param([...ids])}::text[])`;
const anyUuid = (column: unknown, ids: readonly string[]) =>
  sql`${column} = any(${sql.param([...ids])}::uuid[])`;

/** Lock the target rows of `copyIds`, and those naming `pageIds`' links, in order. */
async function lockTargets(
  tx: Database,
  { copyIds, pageIds }: { copyIds: readonly string[]; pageIds: readonly string[] },
) {
  if (copyIds.length === 0 && pageIds.length === 0) return;
  await tx
    .select({ copyId: publicTargets.copyId })
    .from(publicTargets)
    .where(
      sql`${anyUuid(publicTargets.copyId, copyIds)} or ${anyOf(publicTargets.targetPageId, pageIds)}`,
    )
    .orderBy(publicTargets.copyId, publicTargets.key)
    .for('update');
}

/**
 * End the links of `pageIds`, any that have one: lock them, their copies,
 * and the target rows of those copies and those naming these pages, then
 * delete them all. The links that ended.
 */
export async function endLinks(tx: Database, pageIds: readonly string[]) {
  if (pageIds.length === 0) return [];
  return (await end(tx, anyOf(publicLinks.pageId, pageIds), [])).links;
}

/**
 * End the links `linkIds` (by link ID, so one turned off and on again
 * meanwhile stays), with every copy of their pages, and the copies
 * `copyIds`, all locked in one pass in the order above. What ended.
 */
export async function endLinksAndCopies(
  tx: Database,
  { linkIds, copyIds }: { linkIds: readonly string[]; copyIds: readonly string[] },
) {
  return end(tx, linkIds.length === 0 ? null : anyOf(publicLinks.id, linkIds), copyIds);
}

// Lock the links `links` picks, then their pages' copies and `copyIds`,
// then the target rows of those copies and those naming those pages, and
// delete them all.
async function end(tx: Database, links: SQL | null, copyIds: readonly string[]) {
  const ended = links
    ? await tx.select().from(publicLinks).where(links).orderBy(publicLinks.pageId).for('update')
    : [];
  const pageIds = ended.map((link) => link.pageId);
  if (pageIds.length === 0 && copyIds.length === 0) return { links: ended, copies: 0 };
  const copies = await tx
    .select({ id: publicCopies.id })
    .from(publicCopies)
    .where(or(anyOf(publicCopies.pageId, pageIds), anyUuid(publicCopies.id, copyIds)))
    .orderBy(publicCopies.id)
    .for('update');
  const ids = copies.map((copy) => copy.id);
  await lockTargets(tx, { copyIds: ids, pageIds });
  // Their files and target rows go with them, all locked above.
  if (ids.length > 0) await tx.delete(publicCopies).where(anyUuid(publicCopies.id, ids));
  if (pageIds.length > 0) await tx.delete(publicLinks).where(anyOf(publicLinks.pageId, pageIds));
  return { links: ended, copies: ids.length };
}

/**
 * Delete copies, live or staged: every copy of `pageId`, or of those only
 * `copyIds`. Locks them, then their target rows. How many went.
 */
export async function endCopies(
  tx: Database,
  pageId: string,
  copyIds?: readonly string[],
): Promise<number> {
  if (copyIds?.length === 0) return 0;
  const copies = await tx
    .select({ id: publicCopies.id })
    .from(publicCopies)
    .where(and(eq(publicCopies.pageId, pageId), copyIds && anyUuid(publicCopies.id, copyIds)))
    .orderBy(publicCopies.id)
    .for('update');
  if (copies.length === 0) return 0;
  const ids = copies.map((copy) => copy.id);
  await lockTargets(tx, { copyIds: ids, pageIds: [] });
  await tx.delete(publicCopies).where(anyUuid(publicCopies.id, ids));
  return ids.length;
}

/**
 * Carry the links of pages a move takes into another space over to their
 * new pages (ADR 0007, decision 6): `moved` names each page and its new
 * page, which arrives published where the mover, `sharedBy`, can publish
 * it. Each link keeps its id, so `/p/<id>` keeps working, and the mover
 * becomes who turned it on, since its old sharer may have no access
 * there. Its copies were made from the old page, so they end, and the
 * public page says it is being updated until someone updates it. Other
 * copies' target rows naming it stay, pointing at the new page.
 *
 * Inside the move's finish, which holds both spaces and the source
 * subtree: the mover's account row, then the links, their copies and the
 * target rows, in the order above. The links carried; the move's delete
 * ends the others. Nothing is carried for a suspended mover.
 */
export async function moveLinks(
  tx: Database,
  move: { sharedBy: string; moved: readonly { sourceId: string; nodeId: string }[] },
) {
  if (move.moved.length === 0) return [];
  const [mover] = await tx
    .select({ suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, move.sharedBy))
    .for('share');
  if (!mover || mover.suspendedAt) return [];
  const links = await tx
    .select()
    .from(publicLinks)
    .where(
      anyOf(
        publicLinks.pageId,
        move.moved.map((page) => page.sourceId),
      ),
    )
    .orderBy(publicLinks.pageId)
    .for('update');
  if (links.length === 0) return [];
  const pageIds = links.map((link) => link.pageId);
  const copies = await tx
    .select({ id: publicCopies.id })
    .from(publicCopies)
    .where(anyOf(publicCopies.pageId, pageIds))
    .orderBy(publicCopies.id)
    .for('update');
  const copyIds = copies.map((copy) => copy.id);
  await lockTargets(tx, { copyIds, pageIds });
  // Other copies' gaps leading to these links, kept for their new pages.
  // The rows' foreign key can't follow the link's page ID as it changes,
  // so they go while it does and come back after.
  const naming = await tx
    .select()
    .from(publicTargets)
    .where(
      and(
        anyOf(publicTargets.targetPageId, pageIds),
        copyIds.length > 0 ? sql`not ${anyUuid(publicTargets.copyId, copyIds)}` : undefined,
      ),
    );
  // Their files and own target rows go with them.
  if (copyIds.length > 0) await tx.delete(publicCopies).where(anyUuid(publicCopies.id, copyIds));
  await tx.delete(publicTargets).where(anyOf(publicTargets.targetPageId, pageIds));
  const linked = new Map(links.map((link) => [link.pageId, link]));
  const carried = move.moved.flatMap((page) => {
    const link = linked.get(page.sourceId);
    return link ? [{ ...link, nodeId: page.nodeId }] : [];
  });
  await tx.execute(sql`
    update public_links l set page_id = p.node_id, shared_by = ${move.sharedBy}
    from unnest(
      ${sql.param(carried.map((link) => link.pageId))}::text[],
      ${sql.param(carried.map((link) => link.nodeId))}::text[]
    ) as p(source_id, node_id)
    where l.page_id = p.source_id`);
  const newPage = new Map(carried.map((link) => [link.pageId, link.nodeId]));
  if (naming.length > 0) {
    await tx.insert(publicTargets).values(
      naming.map((row) => ({
        ...row,
        targetPageId: newPage.get(row.targetPageId) ?? row.targetPageId,
      })),
    );
  }
  return carried;
}

type Ended = { actor: string | null; reason: 'turned-off' | 'unpublished' | 'lost-publish-rights' };

/** Record that a link of a page in `spaceId` ended, and how. */
export function recordEnded(
  tx: Database,
  link: { pageId: string; sharedBy: string },
  spaceId: string,
  { actor, reason }: Ended,
) {
  return audit(tx, {
    actor,
    action: 'node.public-link-off',
    target: { kind: 'node', id: link.pageId },
    details: { spaceId, sharedBy: link.sharedBy, reason },
  });
}

/**
 * End a page's link, under its locks, and record how. Unpublishing ends
 * the link this way too.
 */
export async function endLinkFor(tx: Database, page: { id: string; spaceId: string }, how: Ended) {
  for (const link of await endLinks(tx, [page.id])) await recordEnded(tx, link, page.spaceId, how);
}

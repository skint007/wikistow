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
import { publicCopies, publicLinks, publicTargets } from '../db/schema/index.ts';

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

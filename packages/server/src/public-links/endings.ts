// Ending public links and copies (ADR 0005, decisions 5 and 8). Every
// change that ends some locks the rows it deletes first: the links, then
// the copies, then the target rows, each in order of ID. Changes that end
// them hold the page's locks already (its space, share, node and heads, or
// a delete's locks), and any account rows before these, so two endings
// that meet wait for each other instead of deadlocking.
import { and, eq, sql } from 'drizzle-orm';
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
  const links = await tx
    .select()
    .from(publicLinks)
    .where(anyOf(publicLinks.pageId, pageIds))
    .orderBy(publicLinks.pageId)
    .for('update');
  if (links.length === 0) return [];
  const ended = links.map((link) => link.pageId);
  const copies = await tx
    .select({ id: publicCopies.id })
    .from(publicCopies)
    .where(anyOf(publicCopies.pageId, ended))
    .orderBy(publicCopies.id)
    .for('update');
  await lockTargets(tx, { copyIds: copies.map((copy) => copy.id), pageIds: ended });
  // Their copies, files and target rows go with them, all locked above.
  await tx.delete(publicLinks).where(anyOf(publicLinks.pageId, ended));
  return links;
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
 * End a page's link, under its locks, and record how. Unpublishing ends
 * the link this way too.
 */
export async function endLinkFor(
  tx: Database,
  page: { id: string; spaceId: string },
  {
    actor,
    reason,
  }: { actor: string | null; reason: 'turned-off' | 'unpublished' | 'lost-publish-rights' },
) {
  for (const link of await endLinks(tx, [page.id])) {
    await audit(tx, {
      actor,
      action: 'node.public-link-off',
      target: { kind: 'node', id: page.id },
      details: { spaceId: page.spaceId, sharedBy: link.sharedBy, reason },
    });
  }
}

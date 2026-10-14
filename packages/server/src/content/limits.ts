import { and, count, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { nodes, spaces } from '../db/schema/index.ts';
import { ContentError } from './errors.ts';

export const DEFAULT_CONTENT_LIMITS = { spaces: 100, folders: 10_000, pages: 100_000 };
export type ContentLimits = typeof DEFAULT_CONTENT_LIMITS;

/**
 * Count live items created for an account, including its agents' work.
 * Call after existing space/share/node locks and before inserting the item.
 * The account lock makes concurrent creates in different spaces count once.
 * Deleting an item frees capacity; sharing or moving it does not transfer it.
 * Nothing deletes spaces yet, so the space limit counts every space made. An
 * item counts against its creator even after they lose access, as storage does.
 */
export async function requireCapacity(
  tx: Database,
  accountId: string,
  kind: 'space' | 'folder' | 'page',
  maximum: number,
) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wikistow:items:${accountId}`}))`);
  const [total] =
    kind === 'space'
      ? await tx.select({ count: count() }).from(spaces).where(eq(spaces.createdBy, accountId))
      : await tx
          .select({ count: count() })
          .from(nodes)
          .where(and(eq(nodes.createdBy, accountId), eq(nodes.kind, kind)));
  if ((total?.count ?? 0) >= maximum) {
    throw new ContentError(`${kind}-limit`, `Your account has reached its ${kind} limit`);
  }
}

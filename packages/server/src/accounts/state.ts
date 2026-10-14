import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { users } from '../db/schema/index.ts';

/** Read fresh from the database on every check; never trust a cached session. */
export async function accountState(
  db: Database,
  accountId: string,
): Promise<'active' | 'suspended' | 'missing'> {
  const [row] = await db
    .select({ suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, accountId));
  if (!row) return 'missing';
  return row.suspendedAt ? 'suspended' : 'active';
}

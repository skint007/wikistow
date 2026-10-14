import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database } from './db/client.ts';
import { passwordBudgets } from './db/schema/index.ts';

export type PasswordBudget = { capacity: number; windowMs: number };

/** Allowances refill over an hour. */
export const PASSWORD_GUESS_WINDOW_MS = 60 * 60 * 1000;
const SWEEP_BATCH = 10_000;

/**
 * Take one guess from `key`'s allowance: `capacity` guesses, refilled evenly
 * over `windowMs`. One upsert decides, so concurrent guesses can't overdraw it,
 * and nothing is locked or held once it returns. A refused guess takes nothing,
 * so the allowance keeps refilling while it is refused. Only that one row is
 * touched: expired rows wait for `sweepPasswordBudgets`.
 */
export async function spendPasswordGuess(
  db: Database,
  key: string,
  { capacity, windowMs }: PasswordBudget,
  now = Date.now(),
): Promise<boolean> {
  const refilled = sql`least(${capacity}::float8, ${passwordBudgets.tokens} + (${now} - ${passwordBudgets.refilledAt}) * ${capacity / windowMs}::float8)`;
  const spent = await db
    .insert(passwordBudgets)
    .values({ key, tokens: capacity - 1, refilledAt: now })
    .onConflictDoUpdate({
      target: passwordBudgets.key,
      set: { tokens: sql`${refilled} - 1`, refilledAt: now },
      setWhere: sql`${refilled} >= 1`,
    })
    .returning({ key: passwordBudgets.key });
  return spent.length > 0;
}

/** Give back a guess that turned out right, so the owner's success costs nothing. */
export async function refundPasswordGuess(
  db: Database,
  key: string,
  { capacity }: PasswordBudget,
): Promise<void> {
  await db
    .update(passwordBudgets)
    .set({ tokens: sql`least(${capacity}::float8, ${passwordBudgets.tokens} + 1)` })
    .where(eq(passwordBudgets.key, key));
}

/**
 * Delete the allowances that are full again, untouched for a whole window and
 * so the same as no row, a batch at a time. Run hourly, not per guess, so
 * however many rows attackers make, a guess never waits on them. How many went.
 */
export async function sweepPasswordBudgets(
  db: Database,
  { windowMs = PASSWORD_GUESS_WINDOW_MS, now = Date.now() } = {},
): Promise<number> {
  // Checked again on the row itself, so a guess spent meanwhile stays.
  const expired = lt(passwordBudgets.refilledAt, now - windowMs);
  let deleted = 0;
  for (;;) {
    // By row address, so each batch reads only its own rows: matching on the
    // key planned as a join over every expired row, once per batch.
    const batch = db
      .select({ ctid: sql`ctid` })
      .from(passwordBudgets)
      .where(expired)
      .limit(SWEEP_BATCH);
    const gone = await db
      .delete(passwordBudgets)
      .where(and(expired, sql`ctid = any(array(${batch}))`))
      .returning({ key: passwordBudgets.key });
    deleted += gone.length;
    if (gone.length < SWEEP_BATCH) return deleted;
  }
}

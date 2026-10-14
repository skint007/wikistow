import { lt, sql } from 'drizzle-orm';
import type { Database } from './db/client.ts';
import { appRateLimits } from './db/schema/index.ts';

/** Longer than any window, so pruning never resets a live counter. */
const RETENTION_MS = 60 * 60 * 1000;

/**
 * Count one request against `key` in a fixed window, in a single upsert so
 * concurrent requests can't slip past the limit. Expired counters are pruned
 * as we go, so the table can't grow without bound.
 */
export async function consumeRateLimit(
  db: Database,
  key: string,
  { windowMs, max, now = Date.now() }: { windowMs: number; max: number; now?: number },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  await db.delete(appRateLimits).where(lt(appRateLimits.windowStart, now - RETENTION_MS));
  const expired = sql`${appRateLimits.windowStart} <= ${now - windowMs}`;
  const [row] = await db
    .insert(appRateLimits)
    .values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: appRateLimits.key,
      set: {
        windowStart: sql`case when ${expired} then ${now} else ${appRateLimits.windowStart} end`,
        count: sql`case when ${expired} then 1 else ${appRateLimits.count} + 1 end`,
      },
    })
    .returning();
  if (!row) throw new Error('rate limit upsert returned nothing');
  return {
    allowed: row.count <= max,
    retryAfterSeconds: Math.max(1, Math.ceil((row.windowStart + windowMs - now) / 1000)),
  };
}

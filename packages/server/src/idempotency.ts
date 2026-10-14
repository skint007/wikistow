import { IDEMPOTENCY_KEY_KEPT_MS } from '@wikistow/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './db/client.ts';
import { ContentError } from './content/errors.ts';
import { idempotencyKeys } from './db/schema/index.ts';

/** How long an answer is kept for a retry; clients count on it too. */
const KEEP = sql`make_interval(secs => ${IDEMPOTENCY_KEY_KEPT_MS / 1000})`;

/**
 * The first half of every key lock's two-part advisory key. Postgres keeps
 * two-part keys apart from the one-part keys every other lock here uses,
 * so a caller's chosen key can't land on one of those.
 */
const KEY_LOCKS = 1;

/**
 * The largest answer kept, in bytes of JSON. The routes that take a key
 * answer a few IDs; anything larger is handled but not kept, so a retry is
 * handled afresh.
 */
export const IDEMPOTENT_ANSWER_BYTES = 64 * 1024;

/**
 * A content change sent with an `Idempotency-Key` (protocol section 16), as
 * the route that takes one hands it to the change: who sent it, the key,
 * and a hash of the request, method, path and exact body bytes. A retry is
 * the same request only if its body is identical: a client that seals the
 * change again (new nonces, signatures or IDs) sends another request, which
 * the key then refuses.
 */
export type Once = { callerId: string; key: string; requestHash: string };

/**
 * Run `change` in a transaction, once per key when `once` is given. The key
 * is claimed and the answer kept inside that same transaction, so a change
 * that commits always has its answer kept, and one that fails or never
 * finishes leaves nothing behind: a retry is handled afresh. A retry of a
 * change that committed gets `change`'s first answer back without running
 * it. While the first request with a key is still running, a second is
 * `busy`; the key with another request is `duplicate`. `change`'s answer
 * must survive JSON as it is.
 */
export async function transactOnce<T>(
  db: Database,
  once: Once | undefined,
  change: (tx: Database) => Promise<T>,
): Promise<T> {
  // Day-old keys go in a statement of their own, before the change's
  // transaction, skipping any another sweep has: no change holds or waits
  // on another's.
  if (once) {
    await db.execute(sql`delete from ${idempotencyKeys} where ctid in (
      select ctid from ${idempotencyKeys} where ${idempotencyKeys.createdAt} < now() - ${KEEP}
      for update skip locked)`);
  }
  return db.transaction(async (tx) => {
    if (!once) return change(tx);
    const { callerId, key, requestHash } = once;
    const [claim] = await tx.execute<{ held: boolean }>(
      sql`select pg_try_advisory_xact_lock(${KEY_LOCKS}, hashtext(${`${callerId}:${key}`})) as held`,
    );
    if (!claim?.held) {
      throw new ContentError('busy', 'The first request with this key is still running');
    }
    const [kept] = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.callerId, callerId), eq(idempotencyKeys.key, key)));
    if (kept) {
      if (kept.requestHash !== requestHash) {
        throw new ContentError('duplicate', 'That Idempotency-Key was used for another request');
      }
      return kept.response as T;
    }
    const answer = await change(tx);
    const response = JSON.stringify(answer ?? null);
    if (Buffer.byteLength(response) <= IDEMPOTENT_ANSWER_BYTES) {
      await tx
        .insert(idempotencyKeys)
        .values({ callerId, key, requestHash, response: sql`${response}::jsonb` });
    }
    return answer;
  });
}

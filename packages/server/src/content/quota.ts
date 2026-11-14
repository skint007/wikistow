import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import {
  blobs,
  comments,
  commentVersions,
  contactsRecords,
  identities,
  liveUsage,
  metadataRevisions,
  publicCopies,
  publicFiles,
  revisions,
} from '../db/schema/index.ts';
import { ContentError } from './errors.ts';

/**
 * Serializes one account's writes that count toward its storage, so two at
 * once can't both fit under the quota. Taken again in one transaction, it
 * holds as before.
 */
export const lockQuota = (tx: Database, accountId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wikistow:quota:${accountId}`}))`);

const total = async (query: Promise<{ bytes: string }[]>) => Number((await query)[0]?.bytes ?? 0);

/**
 * Everything stored on an account's behalf: attachments it uploaded, page
 * and metadata versions and comments it wrote, its live sessions' records,
 * messages and joins while kept, and each session ID it took (protocol
 * section 5.10, summed in `live_usage`),
 * what is kept of its contacts record, and the files of public copies it
 * uploaded.
 * The sums run one after another: in a transaction they share a connection.
 */
export async function usedBytes(db: Database, accountId: string): Promise<number> {
  return (await usedBesidesLive(db, accountId)) + (await liveBytes(db, accountId));
}

const sum = (column: unknown) => sql<string>`coalesce(sum(${column}), 0)`;

/** An account's live sessions' storage, from `live_usage`: one index range. */
const liveBytes = (db: Database, accountId: string) =>
  total(
    db
      .select({ bytes: sum(liveUsage.bytes) })
      .from(liveUsage)
      .where(eq(liveUsage.accountId, accountId)),
  );

/** Everything `usedBytes` counts but live sessions. */
async function usedBesidesLive(db: Database, accountId: string): Promise<number> {
  const parts = [
    await total(
      db
        .select({ bytes: sum(blobs.size) })
        .from(blobs)
        .where(eq(blobs.uploadedBy, accountId)),
    ),
    await total(
      db
        .select({ bytes: sum(revisions.payloadSize) })
        .from(revisions)
        .where(eq(revisions.authorAccountId, accountId)),
    ),
    await total(
      db
        .select({ bytes: sum(metadataRevisions.payloadSize) })
        .from(metadataRevisions)
        .innerJoin(
          identities,
          and(
            eq(identities.id, metadataRevisions.authorIdentityId),
            eq(identities.keyVersion, metadataRevisions.authorKeyVersion),
          ),
        )
        .where(eq(identities.accountId, accountId)),
    ),
    await total(
      db
        .select({ bytes: sum(commentVersions.payloadSize) })
        .from(commentVersions)
        .innerJoin(comments, eq(comments.id, commentVersions.commentId))
        .where(eq(comments.authorAccountId, accountId)),
    ),
    await total(
      db
        .select({ bytes: sum(contactsRecords.size) })
        .from(contactsRecords)
        .where(eq(contactsRecords.accountId, accountId)),
    ),
    await total(
      db
        .select({ bytes: sum(sql`octet_length(${publicFiles.bytes})`) })
        .from(publicFiles)
        .innerJoin(publicCopies, eq(publicCopies.id, publicFiles.copyId))
        .where(eq(publicCopies.uploadedBy, accountId)),
    ),
  ];
  return parts.reduce((a, b) => a + b, 0);
}

/** How long a live write takes the rest of an account's storage as last summed. */
const BESIDES_LIVE_MS = 60_000;
const besidesLive = new Map<string, { bytes: number; at: number }>();

/**
 * `charge` for live sessions' writes, which come many a second from one
 * person under a lock the whole session shares: their own storage exactly,
 * from `live_usage`, and the rest of the account's as summed at most a
 * minute ago. Other writes are charged exactly, so the rest can only have
 * grown by what those let in meanwhile.
 */
export async function chargeLive(
  tx: Database,
  accountId: string,
  bytes: number,
  storageBytes: number,
) {
  await lockQuota(tx, accountId);
  const now = Date.now();
  let rest = besidesLive.get(accountId);
  if (!rest || rest.at + BESIDES_LIVE_MS <= now) {
    rest = { bytes: await usedBesidesLive(tx, accountId), at: now };
    besidesLive.set(accountId, rest);
    // Kept small: only accounts that wrote within the last minute stay.
    for (const [id, entry] of besidesLive) {
      if (entry.at + BESIDES_LIVE_MS <= now) besidesLive.delete(id);
    }
  }
  if (rest.bytes + (await liveBytes(tx, accountId)) + bytes > storageBytes) {
    throw new ContentError('storage-full', 'Your storage is full');
  }
}

/** Refuse a write of `bytes` that would take the account over its storage. */
export async function charge(tx: Database, accountId: string, bytes: number, storageBytes: number) {
  await lockQuota(tx, accountId);
  if ((await usedBytes(tx, accountId)) + bytes > storageBytes) {
    throw new ContentError('storage-full', 'Your storage is full');
  }
}

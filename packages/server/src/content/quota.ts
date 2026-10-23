import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import {
  blobs,
  contactsRecords,
  identities,
  metadataRevisions,
  publicCopies,
  publicFiles,
  revisions,
} from '../db/schema/index.ts';
import { ContentError } from './errors.ts';

// Serializes one account's writes that count toward its storage, so two at
// once can't both fit under the quota.
const lockQuota = (tx: Database, accountId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wikistow:quota:${accountId}`}))`);

const total = async (query: Promise<{ bytes: string }[]>) => Number((await query)[0]?.bytes ?? 0);

/**
 * Everything stored on an account's behalf: attachments it uploaded, page
 * and metadata versions it wrote, what is kept of its contacts record, and
 * the files of public copies it uploaded.
 * The sums run one after another: in a transaction they share a connection.
 */
export async function usedBytes(db: Database, accountId: string): Promise<number> {
  const sum = (column: unknown) => sql<string>`coalesce(sum(${column}), 0)`;
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

/** Refuse a write of `bytes` that would take the account over its storage. */
export async function charge(tx: Database, accountId: string, bytes: number, storageBytes: number) {
  await lockQuota(tx, accountId);
  if ((await usedBytes(tx, accountId)) + bytes > storageBytes) {
    throw new ContentError('storage-full', 'Your storage is full');
  }
}

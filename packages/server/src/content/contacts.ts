// Each person's contacts record (protocol section 8): stored as signed, one
// row per version, and replaced only by compare-and-swap.
import { InstallationId, SealedContacts, SignedContactsRecord } from '@wikistow/contracts';
import { contactsHash, CryptoError, verifyContactsRecord } from '@wikistow/client';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { contactsRecords } from '../db/schema/index.ts';
import { readSettings } from '../settings.ts';
import { ContentError } from './errors.ts';
import { currentIdentity } from './identities.ts';
import { charge } from './quota.ts';
import { readStored, type ReportUnreadable } from './stored.ts';

/**
 * The caller's newest record, or `null` before their first write; with
 * `after`, every later version's signed record too, oldest first, so a
 * device can check the chain from the version it last accepted.
 */
export async function readContacts(
  db: Database,
  { accountId, after }: { accountId: string; after?: number | undefined },
  report: ReportUnreadable,
) {
  const [newest] = await db
    .select()
    .from(contactsRecords)
    .where(eq(contactsRecords.accountId, accountId))
    .orderBy(desc(contactsRecords.version))
    .limit(1);
  const record = newest
    ? (readStored(
        SealedContacts,
        newest.sealed,
        { table: 'contacts_records', id: accountId },
        report,
      ) ?? null)
    : null;
  const later =
    after === undefined
      ? []
      : await db
          .select({ version: contactsRecords.version, sealed: contactsRecords.sealed })
          .from(contactsRecords)
          .where(and(eq(contactsRecords.accountId, accountId), gt(contactsRecords.version, after)))
          .orderBy(contactsRecords.version);
  const chain = later.flatMap((row) => {
    const stored = { table: 'contacts_records', id: `${accountId}@${row.version}` };
    const signed = readStored(SignedContactsRecord.loose(), row.sealed, stored, report);
    return signed ? [{ record: signed.record, signature: signed.signature }] : [];
  });
  return { record, chain };
}

// One account's contacts writes, one at a time.
const lockContacts = (tx: Database, accountId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wikistow:contacts:${accountId}`}))`);

/**
 * Store the next version of the caller's record if theirs is still
 * `expectedVersion` (0 for none), and the new one is version
 * `expectedVersion + 1`, signed by the caller's current key, for this
 * installation, and chained to the current one (section 8.6). Otherwise
 * `stale-head`: the client fetches the newer record and re-applies its
 * changes. The version it replaces keeps only its signed record, which is
 * all a device needs to check the chain from an older mark (section 8.5);
 * what is kept counts toward the caller's storage.
 */
export async function writeContacts(
  db: Database,
  input: {
    accountId: string;
    expectedVersion: number;
    record: SealedContacts;
    storageBytes: number;
  },
): Promise<{ version: number }> {
  return db.transaction(async (tx) => {
    const identity = await currentIdentity(tx, input.accountId);
    if (!identity) throw new ContentError('vault-missing', 'Set up your vault first');
    await lockContacts(tx, input.accountId);
    const [current] = await tx
      .select()
      .from(contactsRecords)
      .where(eq(contactsRecords.accountId, input.accountId))
      .orderBy(desc(contactsRecords.version))
      .limit(1);
    const version = current?.version ?? 0;
    const next = input.record.record;
    if (version !== input.expectedVersion || next.version !== version + 1) {
      throw new ContentError('stale-head', 'Your contacts changed on another device');
    }
    const { installationId } = await readSettings(tx);
    try {
      verifyContactsRecord({
        owner: identity,
        installationId: InstallationId.parse(installationId),
        signed: { record: input.record.record, signature: input.record.signature },
      });
    } catch (error) {
      if (error instanceof CryptoError) throw new ContentError('contacts-invalid', error.message);
      throw error;
    }
    const previous = current ? SignedContactsRecord.loose().safeParse(current.sealed) : null;
    const prevHash = previous?.success ? contactsHash(previous.data.record) : null;
    if (current && next.prevHash !== prevHash) {
      throw new ContentError('contacts-invalid', 'It does not follow your current record');
    }
    if (current) {
      const signed = sql`jsonb_build_object(
        'record', ${contactsRecords.sealed} -> 'record',
        'signature', ${contactsRecords.sealed} -> 'signature')`;
      await tx
        .update(contactsRecords)
        .set({ sealed: signed, size: sql`length(${signed}::text)` })
        .where(
          and(
            eq(contactsRecords.accountId, input.accountId),
            eq(contactsRecords.version, current.version),
          ),
        );
    }
    const size = JSON.stringify(input.record).length;
    await charge(tx, input.accountId, size, input.storageBytes);
    await tx.insert(contactsRecords).values({
      accountId: input.accountId,
      version: next.version,
      sealed: input.record,
      size,
    });
    return { version: next.version };
  });
}

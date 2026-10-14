import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { users } from './users.ts';

/**
 * Each person's contacts record (protocol section 8), one row per version,
 * stored as its owner signed it. The newest is the record; a superseded one
 * keeps only its signed record, which is all a device needs to check the
 * chain from the version it last saw. Every version counts toward the
 * owner's storage.
 */
export const contactsRecords = pgTable(
  'contacts_records',
  {
    accountId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    /** The SealedContacts as its owner signed it, or only its signed record once superseded. */
    sealed: jsonb().notNull(),
    size: integer().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.version] }),
    check('contacts_records_version', sql`${table.version} >= 1`),
  ],
);

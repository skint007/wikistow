import { foreignKey, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { identities } from './identities.ts';

/**
 * One sealed content key per (version, recipient key). The full signed
 * envelope is stored as sent, so recipients can verify who granted it.
 */
export const keyEnvelopes = pgTable(
  'key_envelopes',
  {
    subjectKind: text({ enum: ['revision', 'metadata'] }).notNull(),
    subjectId: text().notNull(),
    recipientIdentityId: text().notNull(),
    recipientKeyVersion: integer().notNull(),
    envelope: jsonb().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.subjectKind,
        table.subjectId,
        table.recipientIdentityId,
        table.recipientKeyVersion,
      ],
    }),
    foreignKey({
      columns: [table.recipientIdentityId, table.recipientKeyVersion],
      foreignColumns: [identities.id, identities.keyVersion],
    }),
  ],
);

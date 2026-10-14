import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { primaryId, timestamps, timestamptz } from './helpers.ts';

/** Better Auth's one-time tokens (email verification, password reset). */
export const verifications = pgTable(
  'verifications',
  {
    id: primaryId(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamptz().notNull(),
    ...timestamps,
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);

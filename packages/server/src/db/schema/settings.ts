import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, smallint, text } from 'drizzle-orm/pg-core';

/**
 * Installation-wide settings, kept in a single row (`id = 1`) that the first
 * migration creates. `installationId` is bound into every signature and every
 * piece of ciphertext, so it must never change.
 */
export const settings = pgTable(
  'settings',
  {
    id: smallint().primaryKey().default(1),
    installationId: text().notNull(),
    publicRegistration: boolean().notNull().default(false),
  },
  (table) => [check('settings_single_row', sql`${table.id} = 1`)],
);

import { sql } from 'drizzle-orm';
import { check, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, timestamptz } from './helpers.ts';
import { users } from './users.ts';

export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml'] as const;

/**
 * One avatar per account, kept in the database in the clear like the
 * account's name, at most 2 MiB. `id` is random and new with every upload,
 * so a replaced image's address stops working and the new one can be cached
 * for good.
 */
export const avatars = pgTable(
  'avatars',
  {
    accountId: uuid()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    id: text().notNull().unique(),
    contentType: text({ enum: AVATAR_TYPES }).notNull(),
    bytes: bytea().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    check(
      'avatars_content_type',
      sql`${table.contentType} in ('image/jpeg', 'image/png', 'image/gif', 'image/svg+xml')`,
    ),
    check('avatars_size', sql`octet_length(${table.bytes}) <= 2097152`),
  ],
);

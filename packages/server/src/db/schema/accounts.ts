import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamps, timestamptz } from './helpers.ts';
import { users } from './users.ts';

/**
 * Better Auth sign-in methods. WikiStow only uses the `credential` provider,
 * whose `password` column holds the hash.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: primaryId(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamptz(),
    refreshTokenExpiresAt: timestamptz(),
    scope: text(),
    password: text(),
    ...timestamps,
  },
  (table) => [index('accounts_user_id_idx').on(table.userId)],
);

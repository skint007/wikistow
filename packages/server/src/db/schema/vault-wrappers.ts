import { integer, jsonb, pgTable, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { users } from './users.ts';

/**
 * One vault wrapper per account: the keyring sealed under the vault key, and
 * the vault key wrapped by the passphrase and by the recovery key. Only the
 * passphrase wrapper ever changes, guarded by `version`.
 */
export const vaultWrappers = pgTable('vault_wrappers', {
  accountId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  version: integer().notNull().default(1),
  wrapper: jsonb().notNull(),
  updatedAt: timestamptz().notNull().defaultNow(),
});

import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, timestamptz } from './helpers.ts';
import { users } from './users.ts';

/**
 * Better Auth's TOTP state. It encrypts `secret` and `backupCodes` with the
 * auth secret before storing them.
 */
export const twoFactors = pgTable(
  'two_factors',
  {
    id: primaryId(),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    verified: boolean().default(true),
    failedVerificationCount: integer().default(0),
    lockedUntil: timestamptz(),
    /** The latest 30-second step a code was accepted for; older or equal steps are refused. */
    lastTotpStep: bigint({ mode: 'number' }),
  },
  (table) => [
    // One per account. Better Auth checks then inserts without a transaction,
    // so parallel setups would otherwise leave several secrets.
    uniqueIndex('two_factors_user_id_idx').on(table.userId),
    index('two_factors_secret_idx').on(table.secret),
  ],
);

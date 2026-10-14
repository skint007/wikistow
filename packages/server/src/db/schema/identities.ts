import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { users } from './users.ts';

/**
 * The public keys behind every signature and key envelope, one row per key
 * version. This is the directory clients refuse to trust until they've pinned
 * a key, so the server only guards its shape and immutability.
 */
export const identities = pgTable(
  'identities',
  {
    id: text().notNull(),
    keyVersion: integer().notNull(),
    accountId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text({ enum: ['human', 'agent'] }).notNull(),
    boxPublicKey: text().notNull(),
    signPublicKey: text().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    revokedAt: timestamptz(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.keyVersion] }),
    check('identities_id_shape', sql`${table.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    // Agent IDs are self-certifying hashes prefixed `agent-`; humans never use it.
    check('identities_agent_prefix', sql`(${table.kind} = 'agent') = (${table.id} like 'agent-%')`),
    uniqueIndex('identities_one_live_human_per_account')
      .on(table.accountId)
      .where(sql`${table.kind} = 'human' and ${table.revokedAt} is null`),
    index('identities_account_idx').on(table.accountId),
  ],
);

/** Identity IDs stay owned forever, even after an account and its keys are deleted. */
export const identityReservations = pgTable('identity_reservations', {
  id: text().primaryKey(),
  // Deliberately no foreign key: deletion must never release an ID.
  accountId: uuid().notNull(),
});

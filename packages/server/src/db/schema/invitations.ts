import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamptz } from './helpers.ts';
import { ROLES, users } from './users.ts';

/**
 * Single-use invitations. Only a SHA-256 hash of the token is stored. An
 * invitation with an email can only be accepted by that address; one without
 * binds to whoever redeems it first. Neither grants any content access.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: primaryId(),
    tokenHash: text().notNull().unique(),
    email: text(),
    role: text({ enum: ROLES }).notNull().default('user'),
    /** Null once the issuer is deleted. */
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz().notNull().defaultNow(),
    expiresAt: timestamptz().notNull(),
    lastSentAt: timestamptz(),
    acceptedAt: timestamptz(),
    acceptedUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamptz(),
  },
  (table) => [
    check('invitations_role', sql`${table.role} in ('user', 'admin')`),
    check('invitations_email_lowercase', sql`${table.email} = lower(${table.email})`),
    // At most one open invitation per address.
    uniqueIndex('invitations_pending_email')
      .on(table.email)
      .where(
        sql`${table.acceptedAt} is null and ${table.revokedAt} is null and ${table.email} is not null`,
      ),
    index('invitations_created_at_idx').on(table.createdAt),
  ],
);

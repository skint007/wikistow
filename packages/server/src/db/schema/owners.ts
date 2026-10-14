import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { spaces } from './spaces.ts';
import { users } from './users.ts';

/**
 * Who owns each space (protocol section 6.5). Apps never accept an owner
 * because this lists them; it is what the server enforces roles by, and who
 * owner-region envelopes must go to. A removed owner keeps their row, with
 * `removedAt`, since owner statements may still name them. Every space
 * keeps at least one current owner, which a trigger checks at commit.
 */
export const spaceOwners = pgTable(
  'space_owners',
  {
    spaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    identityId: text().notNull(),
    addedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz().notNull().defaultNow(),
    removedAt: timestamptz(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.identityId] }),
    check('space_owners_human', sql`${table.identityId} not like 'agent-%'`),
    index('space_owners_identity_idx').on(table.identityId),
  ],
);

/**
 * Signed statements that a person owns a space, at one key (section 6.5),
 * served to owners and members in the order they were stored. Immutable.
 */
export const ownerStatements = pgTable(
  'owner_statements',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    spaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    ownerIdentityId: text().notNull(),
    ownerKeyVersion: integer().notNull(),
    signerIdentityId: text().notNull(),
    signerKeyVersion: integer().notNull(),
    /** The OwnerStatement as signed. */
    statement: jsonb().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    unique('owner_statements_once').on(
      table.spaceId,
      table.ownerIdentityId,
      table.ownerKeyVersion,
      table.signerIdentityId,
      table.signerKeyVersion,
    ),
    index('owner_statements_space_idx').on(table.spaceId),
  ],
);

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { identities } from './identities.ts';
import { SHARE_ROLES, shares } from './shares.ts';
import { nodes } from './spaces.ts';
import { users } from './users.ts';

export const ENROLLMENT_STATES = [
  'requested',
  'claimed',
  'cli-confirmed',
  'approved',
  'delivered',
  'expired',
  'cancelled',
  'rejected',
] as const;

/**
 * An agent's enrollment (protocol section 9.1), from the CLI's request to
 * the token's delivery. Only hashes of the lookup code and poll secret are
 * kept, and the token only sealed to the agent's key, until the CLI
 * collects it. Every transition is checked under a row lock.
 */
export const agentEnrollments = pgTable(
  'agent_enrollments',
  {
    id: text().primaryKey(),
    state: text({ enum: ENROLLMENT_STATES }).notNull().default('requested'),
    lookupCodeHash: text().notNull(),
    pollSecretHash: text().notNull(),
    boxPublicKey: text().notNull(),
    signPublicKey: text().notNull(),
    expiresAt: timestamptz().notNull(),
    /** Set when a person claims the lookup code. */
    ownerAccountId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    ownerIdentityId: text(),
    ownerKeyVersion: integer(),
    /** Set when the CLI confirms the enrollment fingerprint. */
    agentId: text(),
    confirmedAt: timestamptz(),
    /** Set at approval, and cleared once the CLI collects them. */
    credentialId: text(),
    sealedToken: text(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    check(
      'agent_enrollments_state',
      sql`${table.state} in ('requested', 'claimed', 'cli-confirmed', 'approved', 'delivered', 'expired', 'cancelled', 'rejected')`,
    ),
    // A code names one open enrollment; once claimed or ended it names none.
    uniqueIndex('agent_enrollments_open_code')
      .on(table.lookupCodeHash)
      .where(sql`${table.state} = 'requested'`),
    index('agent_enrollments_owner_idx').on(table.ownerAccountId),
    // Old enrollments are swept by it (`requestEnrollment`).
    index('agent_enrollments_expires_idx').on(table.expiresAt),
  ],
);

/**
 * An enrolled agent (section 9.2, step 5): its person, the enrollment they
 * signed, and the name they gave it, which other people's apps show only
 * as the server's. Its keys are its identity row, at key version 1.
 */
export const agentProfiles = pgTable(
  'agent_profiles',
  {
    agentId: text().primaryKey(),
    keyVersion: integer().notNull().default(1),
    accountId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ownerIdentityId: text().notNull(),
    ownerKeyVersion: integer().notNull(),
    name: text().notNull(),
    /** The AgentEnrollment as the person signed it. */
    enrollment: jsonb().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    check('agent_profiles_agent', sql`${table.agentId} like 'agent-%'`),
    check('agent_profiles_key_version', sql`${table.keyVersion} = 1`),
    foreignKey({
      columns: [table.agentId, table.keyVersion],
      foreignColumns: [identities.id, identities.keyVersion],
    }).onDelete('cascade'),
    index('agent_profiles_account_idx').on(table.accountId),
  ],
);

/**
 * An agent's bearer credential (section 9.6), stored as the hash of its
 * secret. It is dead once revoked, or once its person's account revokes
 * every credential made before some moment (`users.credentialsRevokedAt`).
 */
export const agentCredentials = pgTable(
  'agent_credentials',
  {
    id: text().primaryKey(),
    agentId: text()
      .notNull()
      .references(() => agentProfiles.agentId, { onDelete: 'cascade' }),
    accountId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The 32-byte hash of section 9.6, in base64url. */
    tokenHash: text().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    revokedAt: timestamptz(),
  },
  (table) => [index('agent_credentials_agent_idx').on(table.agentId)],
);

/**
 * What a person granted their agent in one share (section 9.4): the whole
 * share, or one folder in it, with a role. The server caps it at the
 * person's current access on every request (section 9.5).
 */
export const agentGrants = pgTable(
  'agent_grants',
  {
    agentId: text()
      .notNull()
      .references(() => agentProfiles.agentId, { onDelete: 'cascade' }),
    shareId: text()
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    spaceId: text().notNull(),
    folderId: text(),
    role: text({ enum: SHARE_ROLES }).notNull(),
    canPublish: boolean().notNull().default(false),
    grantedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.shareId] }),
    check('agent_grants_role', sql`${table.role} in ('reader', 'editor')`),
    check(
      'agent_grants_readers_never_publish',
      sql`${table.role} <> 'reader' or not ${table.canPublish}`,
    ),
    // A picked folder that is deleted takes the pick with it.
    foreignKey({
      columns: [table.spaceId, table.folderId],
      foreignColumns: [nodes.spaceId, nodes.id],
    }).onDelete('cascade'),
    index('agent_grants_share_idx').on(table.shareId),
  ],
);

/**
 * Each agent's latest version of each page it wrote, recorded as it writes:
 * its activity as the Agents page and a page's editors see it, which stays
 * when draft retention removes the version itself.
 */
export const agentEdits = pgTable(
  'agent_edits',
  {
    agentId: text()
      .notNull()
      .references(() => agentProfiles.agentId, { onDelete: 'cascade' }),
    pageId: text()
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    revisionId: text().notNull(),
    audience: text({ enum: ['draft', 'published'] }).notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.pageId] }),
    index('agent_edits_page_created_idx').on(table.pageId, table.createdAt),
  ],
);

/**
 * Answers to content changes sent with an `Idempotency-Key`, so a retry
 * after a lost answer gets the same answer instead of acting twice. Kept a
 * day, per caller, and written in the change's own transaction
 * (`transactOnce`), so a row is only ever a committed change's answer.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    /** The person, or the agent, that sent the change. */
    callerId: text().notNull(),
    key: text().notNull(),
    requestHash: text().notNull(),
    /** What the change answered, JSON null for nothing. */
    response: jsonb().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.callerId, table.key] }),
    index('idempotency_keys_created_idx').on(table.createdAt),
  ],
);

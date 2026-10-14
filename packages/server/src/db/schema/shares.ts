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
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { identities } from './identities.ts';
import { metadataRevisions } from './metadata-revisions.ts';
import { revisions } from './revisions.ts';
import { nodes, spaces } from './spaces.ts';
import { users } from './users.ts';

export const SHARE_ROLES = ['reader', 'editor'] as const;

/**
 * Folders, or whole spaces (`rootId` null), with their own folder keys
 * (protocol section 6.1). Share IDs are made by clients and unique across
 * the installation. Shares never nest, which the server checks under a lock
 * on the space. `currentKeyVersion` moves up by one with each rotation.
 */
export const shares = pgTable(
  'shares',
  {
    id: text().primaryKey(),
    spaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    rootId: text(),
    currentKeyVersion: integer().notNull().default(1),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    check('shares_id_shape', sql`${table.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check('shares_key_version', sql`${table.currentKeyVersion} >= 1`),
    unique('shares_one_per_root').on(table.spaceId, table.rootId).nullsNotDistinct(),
    foreignKey({
      columns: [table.spaceId, table.rootId],
      foreignColumns: [nodes.spaceId, nodes.id],
    }).onDelete('cascade'),
  ],
);

/**
 * Everyone but the owners who holds a share's keys, with their role there
 * (section 7.1), at the identity key version their envelopes are sealed to.
 */
export const shareMembers = pgTable(
  'share_members',
  {
    shareId: text()
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    identityId: text().notNull(),
    keyVersion: integer().notNull(),
    role: text({ enum: SHARE_ROLES }).notNull(),
    canPublish: boolean().notNull().default(false),
    addedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.shareId, table.identityId] }),
    check('share_members_role', sql`${table.role} in ('reader', 'editor')`),
    check(
      'share_members_readers_never_publish',
      sql`${table.role} <> 'reader' or not ${table.canPublish}`,
    ),
    check('share_members_human', sql`${table.identityId} not like 'agent-%'`),
    foreignKey({
      columns: [table.identityId, table.keyVersion],
      foreignColumns: [identities.id, identities.keyVersion],
    }).onDelete('cascade'),
    index('share_members_identity_idx').on(table.identityId),
  ],
);

/**
 * One key version of one share, sealed to one person and signed by the
 * owner who sealed it (section 6.4), stored as sent. At most one per
 * recipient key; a later one replaces it, as when a reader becomes an
 * editor. `drafts` says whether it carries the draft key.
 */
export const folderKeyEnvelopes = pgTable(
  'folder_key_envelopes',
  {
    shareId: text()
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    keyVersion: integer().notNull(),
    recipientIdentityId: text().notNull(),
    recipientKeyVersion: integer().notNull(),
    spaceId: text().notNull(),
    sealerIdentityId: text().notNull(),
    drafts: boolean().notNull(),
    envelope: jsonb().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.shareId,
        table.keyVersion,
        table.recipientIdentityId,
        table.recipientKeyVersion,
      ],
    }),
    foreignKey({
      columns: [table.recipientIdentityId, table.recipientKeyVersion],
      foreignColumns: [identities.id, identities.keyVersion],
    }).onDelete('cascade'),
    index('folder_key_envelopes_recipient_idx').on(
      table.spaceId,
      table.recipientIdentityId,
      table.recipientKeyVersion,
    ),
  ],
);

/**
 * The key wrap of a page version in a share (section 6.3): its content key
 * under one key version's draft or published key. Not signed; the record's
 * key commitment catches a wrap that opens to another key.
 */
export const revisionWraps = pgTable(
  'revision_wraps',
  {
    revisionId: text()
      .primaryKey()
      .references(() => revisions.id, { onDelete: 'cascade' }),
    shareId: text()
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    keyVersion: integer().notNull(),
    wrap: jsonb().notNull(),
  },
  (table) => [index('revision_wraps_share_idx').on(table.shareId)],
);

/** The key wrap of a folder's or the space's name version in a share. */
export const metadataWraps = pgTable(
  'metadata_wraps',
  {
    metadataRevisionId: text()
      .primaryKey()
      .references(() => metadataRevisions.id, { onDelete: 'cascade' }),
    shareId: text()
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    keyVersion: integer().notNull(),
    wrap: jsonb().notNull(),
  },
  (table) => [index('metadata_wraps_share_idx').on(table.shareId)],
);

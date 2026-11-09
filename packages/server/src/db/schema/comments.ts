import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { identities } from './identities.ts';
import { shares } from './shares.ts';
import { nodes } from './spaces.ts';
import { users } from './users.ts';

/**
 * Comments on pages (protocol section 5.9), as the server keeps them: the
 * page, thread and audience the writer's request named, which the server
 * never changes and the opening app checks, and what the server decides
 * alone: times, resolving and deleting. Comment IDs are made by clients.
 * A deleted first comment that still has replies stays, without its
 * version; anything else deleted goes.
 */
export const comments = pgTable(
  'comments',
  {
    id: text().primaryKey(),
    spaceId: text().notNull(),
    pageId: text()
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    /** The thread's first comment, or null for a first comment. */
    threadId: text().references((): AnyPgColumn => comments.id, { onDelete: 'cascade' }),
    audience: text({ enum: ['draft', 'published'] }).notNull(),
    authorIdentityId: text().notNull(),
    /** The person responsible: the author, or an agent's person. */
    authorAccountId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /**
     * The page's `readerHistoryFrom` when the comment was made. A thread
     * for readers started before the page's latest unpublish has a lower
     * one than the page has now, so readers no longer see it.
     */
    readerHistoryFrom: integer().notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    editedAt: timestamptz(),
    /** A thread's, so only on a first comment, as is `deletedAt`. */
    resolvedAt: timestamptz(),
    resolvedBy: text(),
    deletedAt: timestamptz(),
  },
  (table) => [
    check('comments_id_shape', sql`${table.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check(
      'comments_thread_state',
      sql`${table.threadId} is null or (${table.resolvedAt} is null and ${table.deletedAt} is null)`,
    ),
    check('comments_resolved', sql`(${table.resolvedAt} is null) = (${table.resolvedBy} is null)`),
    index('comments_page_idx').on(table.pageId, table.createdAt),
    index('comments_thread_idx').on(table.threadId),
    index('comments_author_account_idx').on(table.authorAccountId),
  ],
);

/**
 * The current version of each comment, stored exactly as signed. An edit
 * replaces it, so there is no edit history. Its ID is a metadata version
 * ID, and none repeats one of `metadata_revisions`, so an envelope names
 * one record.
 */
export const commentVersions = pgTable(
  'comment_versions',
  {
    id: text().primaryKey(),
    commentId: text()
      .notNull()
      .unique()
      .references(() => comments.id, { onDelete: 'cascade' }),
    spaceId: text().notNull(),
    /** The SealedComment (record, signature, payload) as the client signed it. */
    sealed: jsonb().notNull(),
    /** The ciphertext's length, which counts toward its author's storage. */
    payloadSize: integer()
      .notNull()
      .generatedAlwaysAs(sql`length(sealed -> 'payload' ->> 'ciphertext')`),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    check('comment_versions_id_shape', sql`${table.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    index('comment_versions_space_idx').on(table.spaceId),
  ],
);

/**
 * The key wrap of a comment version in a share (section 6.3), under the
 * folder key of the comment's audience, kept apart from names' wraps.
 */
export const commentWraps = pgTable(
  'comment_wraps',
  {
    versionId: text()
      .primaryKey()
      .references(() => commentVersions.id, { onDelete: 'cascade' }),
    shareId: text()
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    keyVersion: integer().notNull(),
    wrap: jsonb().notNull(),
  },
  (table) => [index('comment_wraps_share_idx').on(table.shareId)],
);

/**
 * A comment version's content key sealed to one owner outside shares, as
 * a v2 metadata envelope stored as sent, kept apart from names' envelopes.
 */
export const commentEnvelopes = pgTable(
  'comment_envelopes',
  {
    versionId: text()
      .notNull()
      .references(() => commentVersions.id, { onDelete: 'cascade' }),
    recipientIdentityId: text().notNull(),
    recipientKeyVersion: integer().notNull(),
    envelope: jsonb().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.versionId, table.recipientIdentityId, table.recipientKeyVersion],
    }),
    foreignKey({
      columns: [table.recipientIdentityId, table.recipientKeyVersion],
      foreignColumns: [identities.id, identities.keyVersion],
    }),
  ],
);

/** When each person last opened a page's comments, on any device (decision 8). */
export const commentSeen = pgTable(
  'comment_seen',
  {
    accountId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pageId: text()
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    seenAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.pageId] }),
    index('comment_seen_page_idx').on(table.pageId),
  ],
);

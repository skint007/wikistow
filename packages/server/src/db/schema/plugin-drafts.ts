import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, primaryId, timestamptz } from './helpers.ts';
import { users } from './users.ts';

/**
 * Plugin drafts (ADR 0004): the workshop's work, saved as the assistant
 * writes it. Plain, like the library's plugins. `updatedAt` moves
 * with the files, never with a build or the kept workshop.
 */
export const pluginDrafts = pgTable(
  'plugin_drafts',
  {
    id: primaryId(),
    ownerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The manifest's name as last saved, else "Untitled plugin". */
    name: text().notNull(),
    /** The library version it started from, if any. Plain text: it may be removed since. */
    fromPluginId: text(),
    fromHash: text(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [index('plugin_drafts_owner_idx').on(table.ownerId, table.updatedAt)],
);

/**
 * A draft's files: each a text file of at most 256 KB (`text`), or a font
 * or image under `public/` of at most 1 MB (`data`), never both.
 */
export const pluginDraftFiles = pgTable(
  'plugin_draft_files',
  {
    draftId: uuid()
      .notNull()
      .references(() => pluginDrafts.id, { onDelete: 'cascade' }),
    path: text().notNull(),
    text: text(),
    data: bytea(),
    /** Its text's bytes in UTF-8, or its bytes. */
    size: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.path] }),
    check(
      'plugin_draft_files_text_or_data',
      sql`(${table.text} is null) <> (${table.data} is null)`,
    ),
  ],
);

/**
 * The people a draft's owner shared it with (#315): each reads and changes
 * its files and runs the workshop on it. Only the owner shares, deletes and
 * publishes it.
 */
export const pluginDraftShares = pgTable(
  'plugin_draft_shares',
  {
    draftId: uuid()
      .notNull()
      .references(() => pluginDrafts.id, { onDelete: 'cascade' }),
    accountId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.accountId] }),
    index('plugin_draft_shares_account_idx').on(table.accountId),
  ],
);

/**
 * The build one person's browser last previewed of a draft, its files in
 * `plugin_draft_build_files`: each person who reaches the draft has their
 * own, so two previewing at once don't replace each other's.
 */
export const pluginDraftBuilds = pgTable(
  'plugin_draft_builds',
  {
    draftId: uuid()
      .notNull()
      .references(() => pluginDrafts.id, { onDelete: 'cascade' }),
    accountId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    hash: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.draftId, table.accountId] })],
);

/** The files of one person's build of a draft, as a library upload carries them. */
export const pluginDraftBuildFiles = pgTable(
  'plugin_draft_build_files',
  {
    draftId: uuid().notNull(),
    accountId: uuid().notNull(),
    path: text().notNull(),
    data: bytea().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.draftId, table.accountId, table.path] }),
    foreignKey({
      name: 'plugin_draft_build_files_build_fk',
      columns: [table.draftId, table.accountId],
      foreignColumns: [pluginDraftBuilds.draftId, pluginDraftBuilds.accountId],
    }).onDelete('cascade'),
  ],
);

/**
 * The workshop one person keeps with a draft (#314) as JSON: their
 * conversation, versions and sample pages, without copies of real pages.
 * Plain, like its files. Each person who reaches the draft keeps their
 * own, which nobody else reads (#315).
 */
export const pluginDraftWorkshops = pgTable(
  'plugin_draft_workshops',
  {
    draftId: uuid()
      .notNull()
      .references(() => pluginDrafts.id, { onDelete: 'cascade' }),
    accountId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workshop: text(),
    /** Counts each save and clear of `workshop`: a save names the one it follows. */
    revision: integer().notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.draftId, table.accountId] })],
);

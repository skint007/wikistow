import { index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, primaryId, timestamptz } from './helpers.ts';
import { users } from './users.ts';

/**
 * Plugin drafts (ADR 0004): the workshop's work, saved as the assistant
 * writes it. Plain text, like the library's plugins. `updatedAt` moves
 * with the files, never with a build.
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
    /** The build a browser last previewed, held in `plugin_draft_build_files`. */
    buildHash: text(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [index('plugin_drafts_owner_idx').on(table.ownerId, table.updatedAt)],
);

/** A draft's files, each a text file of at most 256 KB. */
export const pluginDraftFiles = pgTable(
  'plugin_draft_files',
  {
    draftId: uuid()
      .notNull()
      .references(() => pluginDrafts.id, { onDelete: 'cascade' }),
    path: text().notNull(),
    text: text().notNull(),
    /** Its text's bytes in UTF-8. */
    size: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.draftId, table.path] })],
);

/** The files of a draft's one build, as a library upload carries them. */
export const pluginDraftBuildFiles = pgTable(
  'plugin_draft_build_files',
  {
    draftId: uuid()
      .notNull()
      .references(() => pluginDrafts.id, { onDelete: 'cascade' }),
    path: text().notNull(),
    data: bytea().notNull(),
  },
  (table) => [primaryKey({ columns: [table.draftId, table.path] })],
);

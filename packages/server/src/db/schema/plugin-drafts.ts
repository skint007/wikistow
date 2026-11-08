import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
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
    /** The build a browser last previewed, held in `plugin_draft_build_files`. */
    buildHash: text(),
    /**
     * The workshop kept with it (#314) as JSON: the conversation, versions
     * and sample pages, without copies of real pages. Plain, like its files.
     */
    workshop: text(),
    /** Counts each save and clear of `workshop`: a save names the one it follows. */
    workshopRevision: integer().notNull().default(0),
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

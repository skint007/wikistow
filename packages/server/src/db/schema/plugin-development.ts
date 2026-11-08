import { pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, timestamptz } from './helpers.ts';
import { users } from './users.ts';

/**
 * Development builds (#317): the one build of each plugin ID a person last
 * loaded from a folder in a browser, served to them only, apart from the
 * library and from their drafts' builds. Every row of an ID is written at
 * once, so they share one hash and one `loadedAt`.
 */
export const pluginDevelopmentFiles = pgTable(
  'plugin_development_files',
  {
    accountId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pluginId: text().notNull(),
    hash: text().notNull(),
    path: text().notNull(),
    data: bytea().notNull(),
    loadedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.pluginId, table.path] })],
);

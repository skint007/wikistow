import type { pluginRoutes } from '@wikistow/contracts';
import type { Manifest } from '@wikistow/plugin-sdk/manifest';
import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { users } from './users.ts';

/**
 * The plugin library (ADR 0002): one row per plugin ID, owned by the
 * account that uploaded it first. Plain text, as the server serves it.
 * `visibility` is the owner's choice (ADR 0004): a private plugin is
 * listed only to its owner and to people who name one of its hashes.
 */
export const plugins = pgTable(
  'plugins',
  {
    id: text().primaryKey(),
    ownerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    visibility: text().$type<pluginRoutes.PluginVisibility>().notNull().default('shared'),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [check('plugins_visibility', sql`${table.visibility} in ('shared', 'private')`)],
);

/**
 * A plugin's uploaded versions, by the SHA-256 of their files, which are
 * stored under `BLOB_DIR/plugins/<hash>/` (`filePluginStore`). A version
 * never changes; it is only removed.
 */
export const pluginVersions = pgTable(
  'plugin_versions',
  {
    hash: text().primaryKey(),
    pluginId: text()
      .notNull()
      .references(() => plugins.id, { onDelete: 'cascade' }),
    manifest: jsonb().$type<Manifest>().notNull(),
    /** Every file's path, sorted: what a download needs to check the hash. */
    files: jsonb().$type<string[]>().notNull(),
    size: bigint({ mode: 'number' }).notNull(),
    uploadedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [index('plugin_versions_plugin_idx').on(table.pluginId, table.createdAt)],
);

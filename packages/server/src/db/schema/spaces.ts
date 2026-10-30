import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { users } from './users.ts';

const idShape = (column: unknown) => sql`${column} ~ '^[A-Za-z0-9_-]{1,64}$'`;

/**
 * Spaces hold folders and pages. Names live in encrypted metadata; the server
 * sees only IDs, structure, and who has access. `permissionVersion` changes
 * whenever who may read the space's root could change.
 */
export const spaces = pgTable(
  'spaces',
  {
    id: text().primaryKey(),
    kind: text({ enum: ['personal', 'shared'] }).notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    permissionVersion: bigint({ mode: 'number' }).notNull().default(1),
    /** The current metadata version (name, emoji). */
    metadataHead: text(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    check('spaces_id_shape', idShape(table.id)),
    index('spaces_created_by_idx').on(table.createdBy),
  ],
);

/**
 * Folders and pages. Every node has one parent within its own space: the
 * composite foreign key makes a cross-space parent impossible. Folders carry
 * encrypted metadata; pages carry their titles inside revisions instead.
 */
export const nodes = pgTable(
  'nodes',
  {
    id: text().primaryKey(),
    spaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    /** Null for nodes at the space root. */
    parentId: text(),
    kind: text({ enum: ['folder', 'page'] }).notNull(),
    /** The responsible account, including when an agent creates it. */
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    permissionVersion: bigint({ mode: 'number' }).notNull().default(1),
    metadataHead: text(),
    /**
     * Set while the node is one of a copy's new nodes, not shown yet: it is
     * in no tree and counts for nothing outside its copy (`copies`).
     */
    copyId: text(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    check('nodes_id_shape', idShape(table.id)),
    check(
      'nodes_page_has_no_metadata',
      sql`${table.kind} = 'folder' or ${table.metadataHead} is null`,
    ),
    unique('nodes_space_id').on(table.spaceId, table.id),
    foreignKey({
      columns: [table.spaceId, table.parentId],
      foreignColumns: [table.spaceId, table.id],
    }).onDelete('cascade'),
    index('nodes_space_parent_idx').on(table.spaceId, table.parentId),
    index('nodes_created_by_kind_idx').on(table.createdBy, table.kind),
    index('nodes_copy_idx')
      .on(table.copyId)
      .where(sql`${table.copyId} is not null`),
  ],
);

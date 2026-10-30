import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './helpers.ts';
import { nodes, spaces } from './spaces.ts';
import { users } from './users.ts';

/**
 * Copies of a page or folder, and moves into another space, not finished
 * yet (protocol section 10, "Copies, and moves between spaces"). The new
 * nodes are made hidden (`nodes.copyId`), get their records, and are shown
 * at the finish, which for a move deletes the source too. The source isn't
 * a foreign key: a copy whose source is deleted meanwhile still finishes,
 * and a move then fails its check of the source. One nobody finishes is
 * swept a day after its last request (`touchedAt`).
 */
export const copies = pgTable(
  'copies',
  {
    id: text().primaryKey(),
    kind: text({ enum: ['copy', 'move'] }).notNull(),
    /** Whether pages' published versions come along, where the opener can publish. */
    bringsPublished: boolean().notNull(),
    /** The responsible account, including when an agent opens it. */
    openedBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Who opened it, a person or an agent: only they send to it and finish it. */
    openerId: text().notNull(),
    sourceSpaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    sourceNodeId: text().notNull(),
    /** The source node's permission version the preview was made at. */
    sourcePermissionVersion: bigint({ mode: 'number' }).notNull(),
    destinationSpaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    /** Null for the top of the space. */
    destinationParentId: text(),
    /** The destination parent's (or space's) permission version the records are written at. */
    permissionVersion: bigint({ mode: 'number' }).notNull(),
    createdAt: timestamptz().notNull().defaultNow(),
    touchedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    check('copies_id_shape', sql`${table.id} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check(
      'copies_move_elsewhere',
      sql`${table.kind} = 'copy' or ${table.sourceSpaceId} <> ${table.destinationSpaceId}`,
    ),
    index('copies_touched_at_idx').on(table.touchedAt),
  ],
);

/**
 * A copy's new nodes, each with the source node it copies and the source
 * versions its records were sealed from: a page's draft and, when it came
 * along, published version; a folder's metadata version. Null until its
 * records arrive. For a move, the finish checks they are still the source's
 * heads. The records themselves are the hidden node's own versions.
 */
export const copyNodes = pgTable(
  'copy_nodes',
  {
    nodeId: text()
      .primaryKey()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    copyId: text()
      .notNull()
      .references(() => copies.id, { onDelete: 'cascade' }),
    sourceId: text().notNull(),
    /** The new node's parent's source, or null for the copy's top node. */
    sourceParentId: text(),
    draftFrom: text(),
    publishedFrom: text(),
    metadataFrom: text(),
  },
  (table) => [index('copy_nodes_copy_idx').on(table.copyId)],
);
